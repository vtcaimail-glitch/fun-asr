import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { config, validateConfig } from "./config";
import { bearerAuth } from "./http/auth";
import { HttpError, toErrorBody } from "./http/errors";
import { getRequestId, requestIdMiddleware } from "./http/requestId";
import { SerialQueue } from "./queue/serialQueue";
import { runAsrViaPython } from "./engine/pythonAsr";
import { downloadToFile } from "./http/download";
import { convertToWavMono16k } from "./audio/ffmpeg";
import { runDemucs } from "./engine/demucs";
import { createZipViaPython } from "./engine/zipViaPython";
import { resolvePythonBin } from "./engine/pythonBin";

validateConfig();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(requestIdMiddleware);

const queue = new SerialQueue();

function logLine(prefix: string, msg: string, extra?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const tail = extra ? ` ${JSON.stringify(extra)}` : "";
  console.log(`[${ts}] ${prefix} ${msg}${tail}`);
}

function isAbortError(err: unknown): boolean {
  const mErr = err as { message?: unknown; code?: unknown };
  if (mErr?.code === "ECONNABORTED") return true;
  const msg = typeof mErr?.message === "string" ? mErr.message : "";
  // Express uses this exact message in response.js's onaborted handler.
  if (msg === "Request aborted") return true;
  // Other common strings for peer disconnects mid-response.
  if (msg.includes("aborted") || msg.includes("socket hang up")) return true;
  return false;
}

async function downloadAttachment(args: {
  req: express.Request;
  res: express.Response;
  requestId: string;
  downloadPath: string;
  downloadName: string;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    args.res.download(args.downloadPath, args.downloadName, (err) => {
      if (!err) return resolve();

      // If the client/proxy disconnects (common for long-running demucs/asr),
      // Express reports "Request aborted". That's not a server failure.
      if (args.req.aborted || args.res.destroyed || isAbortError(err)) {
        logLine(`[${args.requestId}]`, "client_aborted", {
          stage: "download",
          message: (err as Error)?.message ?? String(err),
        });
        return resolve();
      }
      reject(err);
    });
  });
}

const uploadDir = path.join(config.tmpDir, "uploads");
const outDirRoot = path.join(config.tmpDir, "out");
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(outDirRoot, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const requestId = getRequestId(req).replaceAll(/[^\w.-]/g, "_");
    const safe = file.originalname.replaceAll(/[^\w.\-()[\] ]/g, "_");
    cb(null, `${requestId}__${Date.now()}__${safe}`);
  },
});

const upload = multer({
  storage,
});

async function resolveAudioInput(req: express.Request, requestId: string): Promise<{
  audioPath: string;
  tempAudioPath?: string;
  source: "upload" | "audioPath" | "audioUrl" | "unknown";
}> {
  const jsonAudioPath = (req.body?.audioPath as unknown as string | undefined)?.trim();
  const audioUrl = (req.body?.audioUrl as unknown as string | undefined)?.trim();
  const uploadedFilePath = (req as express.Request & { file?: { path?: string } }).file?.path;

  let tempAudioPath: string | undefined = uploadedFilePath;
  let audioPath: string | undefined = uploadedFilePath ?? jsonAudioPath;
  const source = uploadedFilePath ? "upload" : jsonAudioPath ? "audioPath" : audioUrl ? "audioUrl" : "unknown";
  if (!audioPath && audioUrl) {
    const safe = audioUrl.replaceAll(/[^\w.-]/g, "_");
    tempAudioPath = path.join(uploadDir, `${requestId}__${Date.now()}__url__${safe}`);
    const { bytes } = await downloadToFile(audioUrl, tempAudioPath);
    logLine(`[${requestId}]`, "downloaded", { bytes, url: audioUrl });
    audioPath = tempAudioPath;
  }

  if (!audioPath) {
    throw new HttpError(
      400,
      "bad_request",
      "Missing audio (multipart field 'audio' or JSON audioPath or JSON audioUrl)"
    );
  }

  return { audioPath, tempAudioPath, source };
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/v1/asr", bearerAuth, upload.single("audio"), async (req, res, next) => {
  try {
    const requestId = getRequestId(req);
    const tRequest = Date.now();
    const responseFormat = String(req.query?.format ?? "").toLowerCase(); // "json" | "srt"

    const vadMaxSingleSegmentMsRaw = String(req.query?.vadMaxSingleSegmentMs ?? "").trim();
    const vadMaxEndSilenceMsRaw = String(req.query?.vadMaxEndSilenceMs ?? "").trim();
    const vadMaxSingleSegmentMs = vadMaxSingleSegmentMsRaw
      ? Number.parseInt(vadMaxSingleSegmentMsRaw, 10)
      : undefined;
    const vadMaxEndSilenceMs = vadMaxEndSilenceMsRaw ? Number.parseInt(vadMaxEndSilenceMsRaw, 10) : undefined;
    if (
      (vadMaxSingleSegmentMs !== undefined && (!Number.isFinite(vadMaxSingleSegmentMs) || vadMaxSingleSegmentMs <= 0)) ||
      (vadMaxEndSilenceMs !== undefined && (!Number.isFinite(vadMaxEndSilenceMs) || vadMaxEndSilenceMs <= 0))
    ) {
      throw new HttpError(
        400,
        "bad_request",
        "Invalid VAD params. Use positive integers: vadMaxSingleSegmentMs, vadMaxEndSilenceMs."
      );
    }

    const { audioPath, tempAudioPath, source } = await resolveAudioInput(req, requestId);

    if (req.file?.path && req.file?.size) {
      logLine(`[${requestId}]`, "received", {
        source,
        bytes: req.file.size,
        pending: queue.pending,
        running: queue.running,
        format: responseFormat || "json",
      });
    } else {
      logLine(`[${requestId}]`, "received", {
        source,
        audioPath,
        pending: queue.pending,
        running: queue.running,
        format: responseFormat || "json",
      });
    }

    const perRequestOutDir = path.join(outDirRoot, requestId);
    const tEnqueue = Date.now();
    const job = async () => {
      try {
        const tStart = Date.now();
        logLine(`[${requestId}]`, "start", { waitMs: tStart - tEnqueue, pending: queue.pending, running: queue.running });
        await fs.promises.mkdir(perRequestOutDir, { recursive: true });
        const asrWavPath = path.join(perRequestOutDir, "asr.wav");
        try {
          const tConvert = Date.now();
          await convertToWavMono16k({
            ffmpegBin: config.ffmpegBin,
            inputPath: audioPath,
            outputWavPath: asrWavPath,
          });
          logLine(`[${requestId}]`, "audio_converted", { convertMs: Date.now() - tConvert });
        } catch (err) {
          const details = (err as Error)?.message ?? String(err);
          throw new HttpError(400, "bad_audio", "Failed to convert input audio to wav mono 16k", { details });
        }
        let srtPath: string;
        try {
          const tAsr = Date.now();
          ({ srtPath } = await runAsrViaPython({
            audioPath: asrWavPath,
            outDir: perRequestOutDir,
            vadMaxSingleSegmentMs,
            vadMaxEndSilenceMs,
          }));
          logLine(`[${requestId}]`, "engine_done", { engineMs: Date.now() - tAsr });
        } catch (err) {
          const details = (err as unknown as { details?: unknown }).details;
          const code = (err as unknown as { code?: string }).code;
          throw new HttpError(
            500,
            code === "PY_ASR_FAILED" ? "engine_error" : "internal_error",
            "ASR engine failed",
            details
          );
        }
        const srt = await fs.promises.readFile(srtPath, "utf-8");
        logLine(`[${requestId}]`, "done", {
          srtBytes: Buffer.byteLength(srt, "utf-8"),
          totalMs: Date.now() - tRequest,
        });
        return srt;
      } finally {
        await fs.promises.rm(perRequestOutDir, { recursive: true, force: true });
        if (tempAudioPath) await fs.promises.rm(tempAudioPath, { force: true });
      }
    };

    let srt: string;
    srt = await queue.add(job);

    if (responseFormat === "srt") {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("content-disposition", "attachment; filename=\"output.srt\"");
      res.setHeader("x-request-id", requestId);
      return res.status(200).send(Buffer.from(`\ufeff${srt}`, "utf8"));
    }

    res.setHeader("x-request-id", requestId);
    res.json({ status: "ok", data: { srt } });
  } catch (err) {
    next(err);
  }
});

app.post("/v1/demucs", bearerAuth, upload.single("audio"), async (req, res, next) => {
  try {
    const requestId = getRequestId(req);
    const tRequest = Date.now();
    const { audioPath, tempAudioPath, source } = await resolveAudioInput(req, requestId);

    if ((req as unknown as { file?: { size?: number } }).file?.size) {
      logLine(`[${requestId}]`, "received_demucs", {
        source,
        bytes: (req as unknown as { file?: { size?: number } }).file?.size,
        pending: queue.pending,
        running: queue.running,
      });
    } else {
      logLine(`[${requestId}]`, "received_demucs", { source, audioPath, pending: queue.pending, running: queue.running });
    }

    const perRequestOutDir = path.join(outDirRoot, requestId);
    const tEnqueue = Date.now();
    const job = async () => {
      const tStart = Date.now();
      logLine(`[${requestId}]`, "demucs_start", {
        waitMs: tStart - tEnqueue,
        pending: queue.pending,
        running: queue.running,
      });
      await fs.promises.mkdir(perRequestOutDir, { recursive: true });
      const demucsOutDir = path.join(perRequestOutDir, "demucs");

      const tDemucs = Date.now();
      const { vocalsPath, noVocalsPath } = await runDemucs({ audioPath, outDir: demucsOutDir });
      logLine(`[${requestId}]`, "demucs_done", { demucsMs: Date.now() - tDemucs });

      const pythonBin = resolvePythonBin();
      const zipPath = path.join(perRequestOutDir, "demucs.zip");
      await createZipViaPython({
        pythonBin,
        zipPath,
        files: [
          { path: vocalsPath, name: "vocals.mp3" },
          { path: noVocalsPath, name: "no_vocals.mp3" },
        ],
      });
      logLine(`[${requestId}]`, "demucs_zip_done", { totalMs: Date.now() - tRequest });

      return { downloadPath: zipPath, downloadName: "demucs.zip" as const };
    };

    try {
      const { downloadPath, downloadName } = await queue.add(job);
      res.setHeader("x-request-id", requestId);
      await downloadAttachment({ req, res, requestId, downloadPath, downloadName });
    } finally {
      await fs.promises.rm(perRequestOutDir, { recursive: true, force: true });
      if (tempAudioPath) await fs.promises.rm(tempAudioPath, { force: true });
    }
  } catch (err) {
    const code = (err as unknown as { code?: string }).code;
    if (code === "DEMUCS_FAILED") {
      const details = (err as Error)?.message ?? String(err);
      return next(new HttpError(400, "bad_audio", "Demucs failed to process input audio", { details }));
    }
    next(err);
  }
});

app.post("/v1/demucs-asr", bearerAuth, upload.single("audio"), async (req, res, next) => {
  try {
    const requestId = getRequestId(req);
    const tRequest = Date.now();
    const responseFormat = String(req.query?.format ?? "").toLowerCase(); // "zip" (default) | "json" (optional)

    const vadMaxSingleSegmentMsRaw = String(req.query?.vadMaxSingleSegmentMs ?? "").trim();
    const vadMaxEndSilenceMsRaw = String(req.query?.vadMaxEndSilenceMs ?? "").trim();
    const vadMaxSingleSegmentMs = vadMaxSingleSegmentMsRaw
      ? Number.parseInt(vadMaxSingleSegmentMsRaw, 10)
      : undefined;
    const vadMaxEndSilenceMs = vadMaxEndSilenceMsRaw ? Number.parseInt(vadMaxEndSilenceMsRaw, 10) : undefined;
    if (
      (vadMaxSingleSegmentMs !== undefined && (!Number.isFinite(vadMaxSingleSegmentMs) || vadMaxSingleSegmentMs <= 0)) ||
      (vadMaxEndSilenceMs !== undefined && (!Number.isFinite(vadMaxEndSilenceMs) || vadMaxEndSilenceMs <= 0))
    ) {
      throw new HttpError(
        400,
        "bad_request",
        "Invalid VAD params. Use positive integers: vadMaxSingleSegmentMs, vadMaxEndSilenceMs."
      );
    }

    const { audioPath, tempAudioPath, source } = await resolveAudioInput(req, requestId);
    logLine(`[${requestId}]`, "received_demucs_asr", {
      source,
      pending: queue.pending,
      running: queue.running,
      format: responseFormat || "zip",
    });

    const perRequestOutDir = path.join(outDirRoot, requestId);
    const tEnqueue = Date.now();
    const job = async () => {
      const tStart = Date.now();
      logLine(`[${requestId}]`, "demucs_asr_start", {
        waitMs: tStart - tEnqueue,
        pending: queue.pending,
        running: queue.running,
      });

      await fs.promises.mkdir(perRequestOutDir, { recursive: true });

      // 1) Demucs (first)
      const demucsOutDir = path.join(perRequestOutDir, "demucs");
      const tDemucs = Date.now();
      const { vocalsPath, noVocalsPath } = await runDemucs({ audioPath, outDir: demucsOutDir });
      logLine(`[${requestId}]`, "demucs_done", { demucsMs: Date.now() - tDemucs });

      // 2) ASR (convert -> funasr)
      const asrWavPath = path.join(perRequestOutDir, "asr.wav");
      try {
        const tConvert = Date.now();
        await convertToWavMono16k({
          ffmpegBin: config.ffmpegBin,
          inputPath: audioPath,
          outputWavPath: asrWavPath,
        });
        logLine(`[${requestId}]`, "audio_converted", { convertMs: Date.now() - tConvert });
      } catch (err) {
        const details = (err as Error)?.message ?? String(err);
        throw new HttpError(400, "bad_audio", "Failed to convert input audio to wav mono 16k", { details });
      }

      let srtPath: string;
      try {
        const tAsr = Date.now();
        ({ srtPath } = await runAsrViaPython({
          audioPath: asrWavPath,
          outDir: perRequestOutDir,
          vadMaxSingleSegmentMs,
          vadMaxEndSilenceMs,
        }));
        logLine(`[${requestId}]`, "asr_done", { asrMs: Date.now() - tAsr });
      } catch (err) {
        const details = (err as unknown as { details?: unknown }).details;
        const code = (err as unknown as { code?: string }).code;
        throw new HttpError(
          500,
          code === "PY_ASR_FAILED" ? "engine_error" : "internal_error",
          "ASR engine failed",
          details
        );
      }

      // 3) Package result (zip by default)
      const pythonBin = resolvePythonBin();
      const zipPath = path.join(perRequestOutDir, "result.zip");
      await createZipViaPython({
        pythonBin,
        zipPath,
        files: [
          { path: srtPath, name: "output.srt" },
          { path: vocalsPath, name: "vocals.mp3" },
          { path: noVocalsPath, name: "no_vocals.mp3" },
        ],
      });
      logLine(`[${requestId}]`, "demucs_asr_done", { totalMs: Date.now() - tRequest });

      return { downloadPath: zipPath, downloadName: "result.zip" as const };
    };

    try {
      const { downloadPath, downloadName } = await queue.add(job);
      res.setHeader("x-request-id", requestId);

      if (responseFormat === "json") {
        // Minimal fallback; still synchronous. The zip is the intended response.
        return res.json({ status: "ok", data: { downloadName } });
      }

      await downloadAttachment({ req, res, requestId, downloadPath, downloadName });
    } finally {
      await fs.promises.rm(perRequestOutDir, { recursive: true, force: true });
      if (tempAudioPath) await fs.promises.rm(tempAudioPath, { force: true });
    }
  } catch (err) {
    const code = (err as unknown as { code?: string }).code;
    if (code === "DEMUCS_FAILED") {
      const details = (err as Error)?.message ?? String(err);
      return next(new HttpError(400, "bad_audio", "Demucs failed to process input audio", { details }));
    }
    next(err);
  }
});

app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // If the peer disconnected, don't try to write a response and don't spam logs.
  if (req.aborted || res.headersSent || res.writableEnded || res.destroyed) {
    if (isAbortError(err) || req.aborted || res.destroyed) return;
  }

  if (err instanceof HttpError) {
    return res.status(err.statusCode).json(toErrorBody(err));
  }

  const mErr = err as Error;
  const details = (mErr as unknown as { details?: unknown }).details;
  console.error("Unhandled error:", mErr?.stack ?? mErr, details ? { details } : "");
  return res.status(500).json(toErrorBody(new HttpError(500, "internal_error", "Internal server error")));
});

app.listen(config.port, () => {
  console.log(`fun-asr-server listening on :${config.port}`);
});
