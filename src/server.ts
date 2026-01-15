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

validateConfig();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(requestIdMiddleware);

const queue = new SerialQueue(config.queueMaxSize);

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
  limits: { fileSize: config.maxUploadBytes },
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/v1/asr", bearerAuth, upload.single("audio"), async (req, res, next) => {
  try {
    const requestId = getRequestId(req);
    const responseFormat = String(req.query?.format ?? "").toLowerCase(); // "json" | "srt"

    const jsonAudioPath = (req.body?.audioPath as unknown as string | undefined)?.trim();
    const audioUrl = (req.body?.audioUrl as unknown as string | undefined)?.trim();
    const uploadedFilePath = req.file?.path;

    let tempAudioPath: string | undefined = uploadedFilePath;
    let audioPath: string | undefined = uploadedFilePath ?? jsonAudioPath;
    if (!audioPath && audioUrl) {
      const safe = audioUrl.replaceAll(/[^\w.-]/g, "_");
      tempAudioPath = path.join(uploadDir, `${requestId}__${Date.now()}__url__${safe}`);
      const { bytes } = await downloadToFile(audioUrl, tempAudioPath, config.maxUploadBytes);
      console.log(`[${requestId}] downloaded bytes=${bytes} url=${audioUrl}`);
      audioPath = tempAudioPath;
    }
    if (!audioPath) {
      throw new HttpError(
        400,
        "bad_request",
        "Missing audio (multipart field 'audio' or JSON audioPath or JSON audioUrl)"
      );
    }

    const ext = path.extname(audioPath).toLowerCase();
    if ([".mp4", ".mkv", ".mov", ".avi", ".webm"].includes(ext)) {
      throw new HttpError(
        400,
        "unsupported_media",
        "Video container input is not supported here; convert to WAV/FLAC (16kHz mono) and retry."
      );
    }

    if (uploadedFilePath && req.file?.size) {
      console.log(`[${requestId}] upload bytes=${req.file.size} pending=${queue.pending} running=${queue.running}`);
    } else {
      console.log(`[${requestId}] audioPath=${audioPath} pending=${queue.pending} running=${queue.running}`);
    }

    const perRequestOutDir = path.join(outDirRoot, requestId);
    const job = async () => {
      try {
        console.log(`[${requestId}] start`);
        let srtPath: string;
        try {
          ({ srtPath } = await runAsrViaPython({
            audioPath,
            outDir: perRequestOutDir,
            maxCharsPerLine: config.maxCharsPerLine,
            timeoutMs: config.asrTimeoutMs,
          }));
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
        console.log(`[${requestId}] done srtBytes=${Buffer.byteLength(srt, "utf-8")}`);
        return srt;
      } finally {
        await fs.promises.rm(perRequestOutDir, { recursive: true, force: true });
        if (tempAudioPath) await fs.promises.rm(tempAudioPath, { force: true });
      }
    };

    let srt: string;
    try {
      srt = await queue.add(job);
    } catch (err) {
      const code = (err as unknown as { code?: string }).code;
      if (code === "QUEUE_FULL") throw new HttpError(503, "overloaded", "Queue is full");
      throw err;
    }

    if (responseFormat === "srt") {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("content-disposition", "attachment; filename=\"output.srt\"");
      res.setHeader("x-request-id", requestId);
      return res.status(200).send(Buffer.from(`\ufeff${srt}`, "utf8"));
    }

    res.json({ status: "ok", data: { srt } });
  } catch (err) {
    next(err);
  }
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
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
