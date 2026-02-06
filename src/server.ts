import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
const jobsV2Dir = path.join(config.tmpDir, "jobs-v2");
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(outDirRoot, { recursive: true });
fs.mkdirSync(jobsV2Dir, { recursive: true });

async function cleanupOrphanedV2JobDirs(): Promise<void> {
  const ttlMs = config.jobTtlSeconds * 1000;
  const now = Date.now();
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(jobsV2Dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const full = path.join(jobsV2Dir, ent.name);
    try {
      const job = await tryLoadV2Job(full);
      if (job?.expiresAt) {
        const t = Date.parse(job.expiresAt);
        if (Number.isFinite(t) && t > now) continue;
      } else {
        const st = await fs.promises.stat(full);
        if (now - st.mtimeMs < ttlMs) continue;
      }
      await fs.promises.rm(full, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
void cleanupOrphanedV2JobDirs();

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

// V2 doesn't need the original filename and may hit Windows path-length limits if it's too long.
const storageV2 = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const requestId = getRequestId(req).replaceAll(/[^\w.-]/g, "_");
    const ext = path.extname(file.originalname) || ".bin";
    cb(null, `${requestId}__${Date.now()}${ext}`);
  },
});

const uploadV2 = multer({ storage: storageV2 });

function maybeMulterArray(fieldName: string, maxCount: number) {
  const mw = uploadV2.array(fieldName, maxCount);
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.is("multipart/form-data")) return mw(req, res, next);
    return next();
  };
}

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

type V2JobType = "asr" | "demucs" | "asr-demucs";
type V2JobState = "queued" | "running" | "succeeded" | "failed";
type V2JobPhase =
  | "queued"
  | "asr_convert"
  | "asr"
  | "demucs"
  | "zip_demucs"
  | "zip_result"
  | "done"
  | "error";

type V2Artifact = {
  name: string;
  path: string;
  ready: boolean;
  bytes?: number;
};

type V2JobError = {
  code: "bad_request" | "bad_audio" | "engine_error" | "internal_error";
  message: string;
  details?: unknown;
};

type V2Job = {
  id: string;
  type: V2JobType;
  state: V2JobState;
  phase: V2JobPhase;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  expiresAt?: string;
  outDir: string;
  source: "upload" | "audioPath" | "audioUrl" | "unknown";
  audioPath: string;
  cleanupAudioOnFinish: boolean;
  vadMaxSingleSegmentMs?: number;
  vadMaxEndSilenceMs?: number;
  artifacts: Record<string, V2Artifact>;
  error?: V2JobError;
};

const v2Jobs = new Map<string, V2Job>();
const V2_JOB_META = "job.json";

async function writeJsonAtomic(filePath: string, obj: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), "utf-8");
  try {
    await fs.promises.rename(tmp, filePath);
  } catch (err) {
    // Windows can fail when destination exists; fallback to "replace".
    const code = (err as unknown as { code?: string }).code;
    if (code === "EEXIST" || code === "EPERM") {
      await fs.promises.rm(filePath, { force: true });
      await fs.promises.rename(tmp, filePath);
      return;
    }
    throw err;
  }
}

async function persistV2Job(job: V2Job): Promise<void> {
  const metaPath = path.join(job.outDir, V2_JOB_META);
  await writeJsonAtomic(metaPath, job);
}

async function tryLoadV2Job(dirPath: string): Promise<V2Job | undefined> {
  const metaPath = path.join(dirPath, V2_JOB_META);
  let raw: string;
  try {
    raw = await fs.promises.readFile(metaPath, "utf-8");
  } catch {
    return undefined;
  }
  let job: V2Job;
  try {
    job = JSON.parse(raw) as V2Job;
  } catch {
    return undefined;
  }

  if (!job?.id || typeof job.id !== "string") return undefined;
  if (!job?.outDir || typeof job.outDir !== "string") return undefined;
  job.outDir = dirPath;

  if (!job.artifacts || typeof job.artifacts !== "object") job.artifacts = {};
  // Reconcile artifacts against filesystem (ready => file must exist).
  for (const a of Object.values(job.artifacts)) {
    if (!a?.name || !a?.path) continue;
    const full = path.isAbsolute(a.path) ? a.path : path.join(job.outDir, a.path);
    a.path = full;
    const bytes = await safeStatBytes(full);
    if (bytes === undefined) {
      a.ready = false;
      delete a.bytes;
    } else {
      a.ready = true;
      a.bytes = bytes;
    }
  }

  return job;
}

type V2BatchPolicy = "stage-first";
type V2BatchState = "queued" | "running" | "succeeded" | "failed" | "canceled";
type V2BatchPhase = "validate" | "asr" | "demucs" | "done" | "error";
type V2BatchTaskFlags = { asr: boolean; demucs: boolean };
type V2BatchOptions = {
  policy: V2BatchPolicy;
  tasks: V2BatchTaskFlags;
  vadMaxSingleSegmentMs?: number;
  vadMaxEndSilenceMs?: number;
};

type V2BatchItemKind = "upload" | "audioPath" | "audioUrl";
type V2BatchItemState = "queued" | "running" | "succeeded" | "failed" | "canceled";
type V2BatchItemPhase =
  | "queued"
  | "validate"
  | "asr_convert"
  | "asr"
  | "demucs"
  | "zip_demucs"
  | "zip_result"
  | "done"
  | "error";

type V2BatchItemInput =
  | { kind: "upload"; fileIndex: number }
  | { kind: "audioPath"; audioPath: string }
  | { kind: "audioUrl"; audioUrl: string };

type V2BatchItem = {
  idx: number;
  input: V2BatchItemInput;
  source: "upload" | "audioPath" | "audioUrl";
  audioPath: string;
  ownedInput: boolean;
  state: V2BatchItemState;
  phase: V2BatchItemPhase;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  artifacts: Record<string, V2Artifact>;
  error?: V2JobError;
};

type V2Batch = {
  id: string;
  state: V2BatchState;
  phase: V2BatchPhase;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  expiresAt?: string;
  cancelRequested?: boolean;
  outDir: string;
  options: V2BatchOptions;
  items: V2BatchItem[];
  error?: V2JobError;
};

const batchesV2Dir = path.join(config.tmpDir, "batches");
fs.mkdirSync(batchesV2Dir, { recursive: true });
const v2Batches = new Map<string, V2Batch>();
const V2_BATCH_META = "batch.json";

function defaultBatchOptions(): V2BatchOptions {
  return { policy: "stage-first", tasks: { asr: true, demucs: true } };
}

function parsePositiveIntOrUndefined(raw: unknown): number | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function parseBatchOptions(raw: unknown): V2BatchOptions {
  const base = defaultBatchOptions();
  if (!raw) return base;
  const o = raw as Partial<V2BatchOptions> & { tasks?: Partial<V2BatchTaskFlags> };
  const policy = o.policy === "stage-first" ? "stage-first" : base.policy;
  const tasks: V2BatchTaskFlags = {
    asr: o.tasks?.asr !== undefined ? Boolean(o.tasks.asr) : base.tasks.asr,
    demucs: o.tasks?.demucs !== undefined ? Boolean(o.tasks.demucs) : base.tasks.demucs,
  };
  const vadMaxSingleSegmentMs =
    o.vadMaxSingleSegmentMs !== undefined ? Number(o.vadMaxSingleSegmentMs) : base.vadMaxSingleSegmentMs;
  const vadMaxEndSilenceMs = o.vadMaxEndSilenceMs !== undefined ? Number(o.vadMaxEndSilenceMs) : base.vadMaxEndSilenceMs;
  const opts: V2BatchOptions = { policy, tasks };
  if (vadMaxSingleSegmentMs !== undefined && Number.isFinite(vadMaxSingleSegmentMs) && vadMaxSingleSegmentMs > 0) {
    opts.vadMaxSingleSegmentMs = vadMaxSingleSegmentMs;
  }
  if (vadMaxEndSilenceMs !== undefined && Number.isFinite(vadMaxEndSilenceMs) && vadMaxEndSilenceMs > 0) {
    opts.vadMaxEndSilenceMs = vadMaxEndSilenceMs;
  }
  return opts;
}

async function persistV2Batch(batch: V2Batch): Promise<void> {
  await writeJsonAtomic(path.join(batch.outDir, V2_BATCH_META), batch);
}

async function tryLoadV2Batch(dirPath: string): Promise<V2Batch | undefined> {
  const metaPath = path.join(dirPath, V2_BATCH_META);
  let raw: string;
  try {
    raw = await fs.promises.readFile(metaPath, "utf-8");
  } catch {
    return undefined;
  }
  let batch: V2Batch;
  try {
    batch = JSON.parse(raw) as V2Batch;
  } catch {
    return undefined;
  }
  if (!batch?.id || typeof batch.id !== "string") return undefined;
  batch.outDir = dirPath;
  if (!Array.isArray(batch.items)) batch.items = [];
  for (const it of batch.items) {
    if (!it?.artifacts || typeof it.artifacts !== "object") it.artifacts = {};
    for (const a of Object.values(it.artifacts)) {
      if (!a?.name || !a?.path) continue;
      const full = path.isAbsolute(a.path) ? a.path : path.join(dirPath, a.path);
      a.path = full;
      const bytes = await safeStatBytes(full);
      if (bytes === undefined) {
        a.ready = false;
        delete a.bytes;
      } else {
        a.ready = true;
        a.bytes = bytes;
      }
    }
  }
  return batch;
}

function batchCounts(batch: V2Batch) {
  const counts = { total: batch.items.length, queued: 0, running: 0, succeeded: 0, failed: 0, canceled: 0 };
  for (const it of batch.items) {
    if (it.state === "queued") counts.queued++;
    else if (it.state === "running") counts.running++;
    else if (it.state === "succeeded") counts.succeeded++;
    else if (it.state === "failed") counts.failed++;
    else if (it.state === "canceled") counts.canceled++;
  }
  return counts;
}

function v2BatchToResponse(req: express.Request, batch: V2Batch) {
  const mkArtifact = (item: V2BatchItem, a: V2Artifact) => ({
    name: a.name,
    ready: a.ready,
    bytes: a.bytes,
    url: a.ready
      ? `/v2/batches/${batch.id}/items/${item.idx}/artifacts/${encodeURIComponent(a.name)}`
      : undefined,
  });

  return {
    id: batch.id,
    state: batch.state,
    phase: batch.phase,
    createdAt: batch.createdAt,
    startedAt: batch.startedAt,
    finishedAt: batch.finishedAt,
    expiresAt: batch.expiresAt,
    cancelRequested: batch.cancelRequested,
    options: batch.options,
    queue: { pending: queue.pending, running: queue.running },
    counts: batchCounts(batch),
    items: batch.items.map((it) => ({
      idx: it.idx,
      state: it.state,
      phase: it.phase,
      createdAt: it.createdAt,
      startedAt: it.startedAt,
      finishedAt: it.finishedAt,
      artifacts: Object.fromEntries(Object.entries(it.artifacts).map(([k, a]) => [k, mkArtifact(it, a)])),
      error: it.error,
    })),
    error: batch.error,
  };
}

function parseV2JobType(raw: string): V2JobType {
  const v = raw.trim().toLowerCase().replaceAll("_", "-");
  if (!v || v === "asr-demucs" || v === "demucs-asr" || v === "demucsasr" || v === "asr+demucs") return "asr-demucs";
  if (v === "asr") return "asr";
  if (v === "demucs") return "demucs";
  throw new HttpError(400, "bad_request", "Invalid job type. Use: asr | demucs | asr-demucs");
}

function makeJobUrl(req: express.Request, pathSuffix: string): string {
  // Prefer relative URLs to avoid issues behind reverse proxies.
  void req;
  const base = "/v2/jobs";
  return `${base}${pathSuffix}`;
}

function v2JobToResponse(req: express.Request, job: V2Job) {
  const artifacts = Object.fromEntries(
    Object.entries(job.artifacts).map(([key, a]) => [
      key,
      {
        name: a.name,
        ready: a.ready,
        bytes: a.bytes,
        url: a.ready ? makeJobUrl(req, `/${job.id}/artifacts/${encodeURIComponent(a.name)}`) : undefined,
      },
    ])
  );

  return {
    id: job.id,
    type: job.type,
    state: job.state,
    phase: job.phase,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    expiresAt: job.expiresAt,
    queue: { pending: queue.pending, running: queue.running },
    artifacts,
    error: job.error,
  };
}

async function safeStatBytes(filePath: string): Promise<number | undefined> {
  try {
    const st = await fs.promises.stat(filePath);
    if (!st.isFile()) return undefined;
    return st.size;
  } catch {
    return undefined;
  }
}

async function ensureV2Artifact(job: V2Job, key: string, name: string, filePath: string): Promise<void> {
  const bytes = await safeStatBytes(filePath);
  job.artifacts[key] = { name, path: filePath, ready: true, bytes };
  await persistV2Job(job);
}

async function runV2Job(job: V2Job): Promise<void> {
  job.state = "running";
  job.startedAt = new Date().toISOString();
  job.phase = "queued";
  await persistV2Job(job);

  const finalizeSuccess = () => {
    job.state = "succeeded";
    job.phase = "done";
    job.finishedAt = new Date().toISOString();
    job.expiresAt = new Date(Date.now() + config.jobTtlSeconds * 1000).toISOString();
  };

  const finalizeFailure = (err: unknown) => {
    const httpErr = err as unknown as { statusCode?: number; code?: string; message?: string; details?: unknown };
    job.state = "failed";
    job.phase = "error";
    job.finishedAt = new Date().toISOString();
    job.expiresAt = new Date(Date.now() + config.jobTtlSeconds * 1000).toISOString();
    const code =
      httpErr?.code === "bad_request" ||
      httpErr?.code === "bad_audio" ||
      httpErr?.code === "engine_error" ||
      httpErr?.code === "internal_error"
        ? (httpErr.code as V2JobError["code"])
        : "internal_error";
    job.error = {
      code,
      message: httpErr?.message || (err as Error)?.message || "Job failed",
      details: httpErr?.details,
    };
  };

  const copyTo = async (src: string, dest: string) => {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(src, dest);
  };

  try {
    // ASR stage (optional)
    if (job.type === "asr" || job.type === "asr-demucs") {
      job.phase = "asr_convert";
      await persistV2Job(job);
      const asrWavPath = path.join(job.outDir, "asr.wav");
      try {
        await convertToWavMono16k({
          ffmpegBin: config.ffmpegBin,
          inputPath: job.audioPath,
          outputWavPath: asrWavPath,
        });
      } catch (err) {
        const details = (err as Error)?.message ?? String(err);
        throw new HttpError(400, "bad_audio", "Failed to convert input audio to wav mono 16k", { details });
      }

      job.phase = "asr";
      await persistV2Job(job);
      let srtPath: string;
      try {
        ({ srtPath } = await runAsrViaPython({
          audioPath: asrWavPath,
          outDir: job.outDir,
          vadMaxSingleSegmentMs: job.vadMaxSingleSegmentMs,
          vadMaxEndSilenceMs: job.vadMaxEndSilenceMs,
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

      const outSrt = path.join(job.outDir, "output.srt");
      if (srtPath !== outSrt) {
        try {
          await fs.promises.rename(srtPath, outSrt);
        } catch {
          await copyTo(srtPath, outSrt);
          await fs.promises.rm(srtPath, { force: true });
        }
      }
      await ensureV2Artifact(job, "srt", "output.srt", outSrt);

      // Keep the job folder tidy: ASR intermediates aren't needed after SRT is ready.
      await fs.promises.rm(asrWavPath, { force: true });
    }

    // Demucs stage (optional)
    if (job.type === "demucs" || job.type === "asr-demucs") {
      job.phase = "demucs";
      await persistV2Job(job);
      const demucsOutDir = path.join(job.outDir, "demucs");
      const { vocalsPath, noVocalsPath } = await runDemucs({ audioPath: job.audioPath, outDir: demucsOutDir });
      const outVocals = path.join(job.outDir, "vocals.mp3");
      const outNoVocals = path.join(job.outDir, "no_vocals.mp3");
      await copyTo(vocalsPath, outVocals);
      await copyTo(noVocalsPath, outNoVocals);
      await ensureV2Artifact(job, "vocals", "vocals.mp3", outVocals);
      await ensureV2Artifact(job, "no_vocals", "no_vocals.mp3", outNoVocals);

      job.phase = "zip_demucs";
      await persistV2Job(job);
      const pythonBin = resolvePythonBin();
      const demucsZip = path.join(job.outDir, "demucs.zip");
      await createZipViaPython({
        pythonBin,
        zipPath: demucsZip,
        files: [
          { path: outVocals, name: "vocals.mp3" },
          { path: outNoVocals, name: "no_vocals.mp3" },
        ],
      });
      await ensureV2Artifact(job, "demucs_zip", "demucs.zip", demucsZip);

      // Keep the job folder tidy: demucs raw tree can be large, and we already copied/zip'd outputs.
      await fs.promises.rm(demucsOutDir, { recursive: true, force: true });
    }

    // Result bundle (only for combined job)
    if (job.type === "asr-demucs") {
      const srt = job.artifacts["srt"];
      const vocals = job.artifacts["vocals"];
      const noVocals = job.artifacts["no_vocals"];
      if (srt?.ready && vocals?.ready && noVocals?.ready) {
        job.phase = "zip_result";
        await persistV2Job(job);
        const pythonBin = resolvePythonBin();
        const resultZip = path.join(job.outDir, "result.zip");
        await createZipViaPython({
          pythonBin,
          zipPath: resultZip,
          files: [
            { path: srt.path, name: "output.srt" },
            { path: vocals.path, name: "vocals.mp3" },
            { path: noVocals.path, name: "no_vocals.mp3" },
          ],
        });
        await ensureV2Artifact(job, "result_zip", "result.zip", resultZip);
      }
    }

    finalizeSuccess();
    await persistV2Job(job);
  } catch (err) {
    finalizeFailure(err);
    await persistV2Job(job);
  } finally {
    if (job.cleanupAudioOnFinish) {
      try {
        await fs.promises.rm(job.audioPath, { force: true });
      } catch {
        // ignore
      }
    }
  }
}

function scheduleV2Cleanup(): void {
  const sweep = async () => {
    const now = Date.now();
    for (const [id, job] of v2Jobs.entries()) {
      if (!job.expiresAt) continue;
      const t = Date.parse(job.expiresAt);
      if (!Number.isFinite(t) || t > now) continue;
      if (job.state === "queued" || job.state === "running") continue;
      v2Jobs.delete(id);
      try {
        await fs.promises.rm(job.outDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  };
  const t = setInterval(() => void sweep(), 60_000);
  t.unref();
}

scheduleV2Cleanup();

function scheduleV2BatchCleanup(): void {
  const sweep = async () => {
    const now = Date.now();
    for (const [id, batch] of v2Batches.entries()) {
      if (!batch.expiresAt) continue;
      const t = Date.parse(batch.expiresAt);
      if (!Number.isFinite(t) || t > now) continue;
      if (batch.state === "queued" || batch.state === "running") continue;
      v2Batches.delete(id);
      try {
        await fs.promises.rm(batch.outDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  };
  const t = setInterval(() => void sweep(), 60_000);
  t.unref();
}

scheduleV2BatchCleanup();

async function loadV2JobsFromDisk(): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(jobsV2Dir, { withFileTypes: true });
  } catch {
    return;
  }

  const now = Date.now();
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dirPath = path.join(jobsV2Dir, ent.name);
    const job = await tryLoadV2Job(dirPath);
    if (!job) continue;

    // Drop expired jobs eagerly.
    if (job.expiresAt) {
      const t = Date.parse(job.expiresAt);
      if (Number.isFinite(t) && t <= now) {
        try {
          await fs.promises.rm(dirPath, { recursive: true, force: true });
        } catch {
          // ignore
        }
        continue;
      }
    }

    // If the server was restarted while a job was queued/running, it won't resume (no persistence of queue).
    if (job.state === "queued" || job.state === "running") {
      job.state = "failed";
      job.phase = "error";
      job.finishedAt = new Date().toISOString();
      job.expiresAt = new Date(Date.now() + config.jobTtlSeconds * 1000).toISOString();
      job.error = {
        code: "internal_error",
        message: "Job interrupted by server restart. Please re-submit the job.",
      };
      await persistV2Job(job);
    }

    v2Jobs.set(job.id, job);
  }
}

void loadV2JobsFromDisk();

async function loadV2BatchesFromDisk(): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(batchesV2Dir, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dirPath = path.join(batchesV2Dir, ent.name);
    const batch = await tryLoadV2Batch(dirPath);
    if (!batch) continue;

    if (batch.expiresAt) {
      const t = Date.parse(batch.expiresAt);
      if (Number.isFinite(t) && t <= now) {
        try {
          await fs.promises.rm(dirPath, { recursive: true, force: true });
        } catch {
          // ignore
        }
        continue;
      }
    }

    if (batch.state === "queued" || batch.state === "running") {
      batch.state = "failed";
      batch.phase = "error";
      batch.finishedAt = new Date().toISOString();
      batch.expiresAt = new Date(Date.now() + config.jobTtlSeconds * 1000).toISOString();
      batch.error = {
        code: "internal_error",
        message: "Batch interrupted by server restart. Please re-submit the batch.",
      };
      for (const it of batch.items) {
        if (it.state === "queued" || it.state === "running") {
          it.state = "failed";
          it.phase = "error";
          it.finishedAt = new Date().toISOString();
          it.error = { code: "internal_error", message: "Item interrupted by server restart." };
        }
      }
      await persistV2Batch(batch);
    }

    v2Batches.set(batch.id, batch);
  }
}

void loadV2BatchesFromDisk();

async function ensureBatchArtifact(item: V2BatchItem, key: string, name: string, filePath: string): Promise<void> {
  const bytes = await safeStatBytes(filePath);
  item.artifacts[key] = { name, path: filePath, ready: true, bytes };
}

async function runV2Batch(batch: V2Batch): Promise<void> {
  batch.state = "running";
  batch.startedAt = new Date().toISOString();
  batch.phase = "validate";
  await persistV2Batch(batch);

  const markBatchDone = async (state: V2BatchState, phase: V2BatchPhase, err?: V2JobError) => {
    batch.state = state;
    batch.phase = phase;
    batch.finishedAt = new Date().toISOString();
    batch.expiresAt = new Date(Date.now() + config.jobTtlSeconds * 1000).toISOString();
    if (err) batch.error = err;
    await persistV2Batch(batch);
  };

  const cancelRemaining = async (fromIdx: number) => {
    for (let i = fromIdx; i < batch.items.length; i++) {
      const it = batch.items[i]!;
      if (it.state === "queued") {
        it.state = "canceled";
        it.phase = "error";
        it.finishedAt = new Date().toISOString();
      }
    }
    await persistV2Batch(batch);
  };

  const copyTo = async (src: string, dest: string) => {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(src, dest);
  };

  const tasks = batch.options.tasks;

  try {
    // Stage 1: ASR for all items
    if (tasks.asr) {
      batch.phase = "asr";
      await persistV2Batch(batch);
      for (let i = 0; i < batch.items.length; i++) {
        const it = batch.items[i]!;
        if (batch.cancelRequested) {
          await cancelRemaining(i);
          await markBatchDone("canceled", "done");
          return;
        }
        if (it.state !== "queued") continue;

        it.state = "running";
        it.startedAt = new Date().toISOString();
        it.phase = "asr_convert";
        await persistV2Batch(batch);

        const itemDir = path.join(batch.outDir, "items", String(it.idx));
        await fs.promises.mkdir(itemDir, { recursive: true });
        const asrWavPath = path.join(itemDir, "asr.wav");

        try {
          await convertToWavMono16k({
            ffmpegBin: config.ffmpegBin,
            inputPath: it.audioPath,
            outputWavPath: asrWavPath,
          });
        } catch (err) {
          const details = (err as Error)?.message ?? String(err);
          it.state = "failed";
          it.phase = "error";
          it.finishedAt = new Date().toISOString();
          it.error = { code: "bad_audio", message: "Failed to convert input audio to wav mono 16k", details: { details } };
          await persistV2Batch(batch);
          continue;
        }

        it.phase = "asr";
        await persistV2Batch(batch);
        let srtPath: string;
        try {
          ({ srtPath } = await runAsrViaPython({
            audioPath: asrWavPath,
            outDir: itemDir,
            vadMaxSingleSegmentMs: batch.options.vadMaxSingleSegmentMs,
            vadMaxEndSilenceMs: batch.options.vadMaxEndSilenceMs,
          }));
        } catch (err) {
          const details = (err as unknown as { details?: unknown }).details;
          const code = (err as unknown as { code?: string }).code;
          it.state = "failed";
          it.phase = "error";
          it.finishedAt = new Date().toISOString();
          it.error = {
            code: code === "PY_ASR_FAILED" ? "engine_error" : "internal_error",
            message: "ASR engine failed",
            details,
          };
          await persistV2Batch(batch);
          continue;
        }

        const outSrt = path.join(itemDir, "output.srt");
        if (srtPath !== outSrt) {
          try {
            await fs.promises.rename(srtPath, outSrt);
          } catch {
            await copyTo(srtPath, outSrt);
            await fs.promises.rm(srtPath, { force: true });
          }
        }
        await ensureBatchArtifact(it, "srt", "output.srt", outSrt);
        await fs.promises.rm(asrWavPath, { force: true });

        // Not done yet if demucs is also required.
        if (!tasks.demucs) {
          if (it.ownedInput) {
            try {
              await fs.promises.rm(it.audioPath, { force: true });
            } catch {
              // ignore
            }
          }
          it.state = "succeeded";
          it.phase = "done";
          it.finishedAt = new Date().toISOString();
        } else {
          it.state = "queued";
          it.phase = "queued";
        }
        await persistV2Batch(batch);
      }
    }

    // Stage 2: Demucs for all items
    if (tasks.demucs) {
      batch.phase = "demucs";
      await persistV2Batch(batch);
      for (let i = 0; i < batch.items.length; i++) {
        const it = batch.items[i]!;
        if (batch.cancelRequested) {
          await cancelRemaining(i);
          await markBatchDone("canceled", "done");
          return;
        }
        if (it.state !== "queued") continue; // only run demucs for items that passed prior stage

        it.state = "running";
        it.phase = "demucs";
        if (!it.startedAt) it.startedAt = new Date().toISOString();
        await persistV2Batch(batch);

        const itemDir = path.join(batch.outDir, "items", String(it.idx));
        await fs.promises.mkdir(itemDir, { recursive: true });

        const demucsOutDir = path.join(itemDir, "demucs");
        let vocalsPath: string;
        let noVocalsPath: string;
        try {
          ({ vocalsPath, noVocalsPath } = await runDemucs({ audioPath: it.audioPath, outDir: demucsOutDir }));
        } catch (err) {
          const details = (err as Error)?.message ?? String(err);
          it.state = "failed";
          it.phase = "error";
          it.finishedAt = new Date().toISOString();
          it.error = { code: "bad_audio", message: "Demucs failed to process input audio", details: { details } };
          await persistV2Batch(batch);
          continue;
        }

        const outVocals = path.join(itemDir, "vocals.mp3");
        const outNoVocals = path.join(itemDir, "no_vocals.mp3");
        await copyTo(vocalsPath, outVocals);
        await copyTo(noVocalsPath, outNoVocals);
        await ensureBatchArtifact(it, "vocals", "vocals.mp3", outVocals);
        await ensureBatchArtifact(it, "no_vocals", "no_vocals.mp3", outNoVocals);

        it.phase = "zip_demucs";
        await persistV2Batch(batch);
        const pythonBin = resolvePythonBin();
        const demucsZip = path.join(itemDir, "demucs.zip");
        await createZipViaPython({
          pythonBin,
          zipPath: demucsZip,
          files: [
            { path: outVocals, name: "vocals.mp3" },
            { path: outNoVocals, name: "no_vocals.mp3" },
          ],
        });
        await ensureBatchArtifact(it, "demucs_zip", "demucs.zip", demucsZip);

        if (tasks.asr) {
          const srt = it.artifacts["srt"];
          if (srt?.ready) {
            it.phase = "zip_result";
            await persistV2Batch(batch);
            const resultZip = path.join(itemDir, "result.zip");
            await createZipViaPython({
              pythonBin,
              zipPath: resultZip,
              files: [
                { path: srt.path, name: "output.srt" },
                { path: outVocals, name: "vocals.mp3" },
                { path: outNoVocals, name: "no_vocals.mp3" },
              ],
            });
            await ensureBatchArtifact(it, "result_zip", "result.zip", resultZip);
          }
        }

        await fs.promises.rm(demucsOutDir, { recursive: true, force: true });

        // Free owned inputs now that all required tasks are complete.
        if (it.ownedInput) {
          try {
            await fs.promises.rm(it.audioPath, { force: true });
          } catch {
            // ignore
          }
        }

        it.state = "succeeded";
        it.phase = "done";
        it.finishedAt = new Date().toISOString();
        await persistV2Batch(batch);
      }
    }

    // Finalize batch state
    const hasFailed = batch.items.some((it) => it.state === "failed");
    const hasCanceled = batch.items.some((it) => it.state === "canceled");
    if (hasCanceled && !hasFailed) {
      await markBatchDone("canceled", "done");
    } else if (hasFailed) {
      await markBatchDone("failed", "done");
    } else {
      await markBatchDone("succeeded", "done");
    }
  } catch (err) {
    const e = err as { message?: string; details?: unknown; code?: string };
    await markBatchDone("failed", "error", { code: "internal_error", message: e?.message ?? "Batch failed", details: e?.details });
  }
}

app.post("/v2/jobs", bearerAuth, uploadV2.single("audio"), async (req, res, next) => {
  try {
    const requestId = getRequestId(req);
    const jobId = crypto.randomUUID();
    const jobType = parseV2JobType(String((req.body as unknown as { type?: unknown })?.type ?? req.query?.type ?? ""));

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

    const jobOutDir = path.join(jobsV2Dir, jobId);
    await fs.promises.mkdir(jobOutDir, { recursive: true });

    const { audioPath, tempAudioPath, source } = await resolveAudioInput(req, jobId);
    let jobAudioPath = audioPath;
    let cleanupAudioOnFinish = false;

    // For upload/audioUrl we own the temp file: move it into the job folder so it survives the request.
    if (tempAudioPath) {
      const ext = path.extname(tempAudioPath) || path.extname(audioPath) || ".bin";
      const dest = path.join(jobOutDir, `input${ext}`);
      try {
        await fs.promises.rename(tempAudioPath, dest);
      } catch {
        // Cross-device rename fallback.
        await fs.promises.copyFile(tempAudioPath, dest);
        await fs.promises.rm(tempAudioPath, { force: true });
      }
      jobAudioPath = dest;
      cleanupAudioOnFinish = true;
    }

    const job: V2Job = {
      id: jobId,
      type: jobType,
      state: "queued",
      phase: "queued",
      createdAt: new Date().toISOString(),
      outDir: jobOutDir,
      source,
      audioPath: jobAudioPath,
      cleanupAudioOnFinish,
      vadMaxSingleSegmentMs,
      vadMaxEndSilenceMs,
      artifacts: {},
    };
    v2Jobs.set(jobId, job);
    await persistV2Job(job);

    logLine(`[${requestId}]`, "v2_job_created", {
      jobId,
      type: jobType,
      source,
      pending: queue.pending,
      running: queue.running,
    });

    // Fire-and-forget: jobs are executed on the same serial engine queue.
    void queue
      .add(async () => {
        logLine(`[${jobId}]`, "v2_job_start", { type: job.type, source: job.source });
        await runV2Job(job);
        logLine(`[${jobId}]`, "v2_job_done", { state: job.state, phase: job.phase });
      })
      .catch((err) => {
        // Should be rare because runV2Job captures errors, but keep it safe.
        logLine(`[${jobId}]`, "v2_job_unhandled", { message: (err as Error)?.message ?? String(err) });
      });

    res.setHeader("x-request-id", requestId);
    res.setHeader("x-job-id", jobId);
    return res.status(202).json({
      status: "ok",
      data: {
        jobId,
        statusUrl: makeJobUrl(req, `/${jobId}`),
        job: v2JobToResponse(req, job),
      },
    });
  } catch (err) {
    next(err);
  }
});

app.get("/v2/jobs/:id", bearerAuth, (req, res) => {
  const id = String(req.params.id || "").trim();
  const job = v2Jobs.get(id);
  if (!job) {
    return res.status(404).json(toErrorBody(new HttpError(404, "not_found", "Job not found")));
  }
  return res.json({ status: "ok", data: v2JobToResponse(req, job) });
});

app.get("/v2/jobs/:id/artifacts/:name", bearerAuth, async (req, res, next) => {
  try {
    const id = String(req.params.id || "").trim();
    const name = String(req.params.name || "").trim();
    const job = v2Jobs.get(id);
    if (!job) {
      throw new HttpError(404, "not_found", "Job not found");
    }

    const artifact = Object.values(job.artifacts).find((a) => a.name === name);
    if (!artifact || !artifact.ready) {
      throw new HttpError(404, "not_found", "Artifact not found (or not ready yet)");
    }

    res.setHeader("x-job-id", job.id);
    await downloadAttachment({ req, res, requestId: job.id, downloadPath: artifact.path, downloadName: artifact.name });
  } catch (err) {
    next(err);
  }
});

app.post("/v2/batches", bearerAuth, maybeMulterArray("audio", 10), async (req, res, next) => {
  try {
    const requestId = getRequestId(req);
    const batchId = crypto.randomUUID();
    const batchOutDir = path.join(batchesV2Dir, batchId);
    await fs.promises.mkdir(path.join(batchOutDir, "inputs"), { recursive: true });
    await fs.promises.mkdir(path.join(batchOutDir, "items"), { recursive: true });

    const isMultipart = req.is("multipart/form-data");
    const files = (req as unknown as { files?: Express.Multer.File[] }).files ?? [];
    const bodyAny = req.body as unknown as { items?: unknown; options?: unknown };

    let itemsRaw: unknown;
    let optionsRaw: unknown;
    if (isMultipart) {
      try {
        itemsRaw = bodyAny?.items ? JSON.parse(String(bodyAny.items)) : undefined;
      } catch {
        throw new HttpError(400, "bad_request", "Invalid JSON in multipart field 'items'");
      }
      try {
        optionsRaw = bodyAny?.options ? JSON.parse(String(bodyAny.options)) : undefined;
      } catch {
        throw new HttpError(400, "bad_request", "Invalid JSON in multipart field 'options'");
      }
    } else {
      itemsRaw = (req.body as unknown as { items?: unknown }).items;
      optionsRaw = (req.body as unknown as { options?: unknown }).options;
    }

    if (!Array.isArray(itemsRaw) || itemsRaw.length < 1 || itemsRaw.length > 10) {
      throw new HttpError(400, "bad_request", "items must be an array with length 1..10");
    }

    const options = parseBatchOptions(optionsRaw);
    // Allow query-string VAD override (optional)
    const qVad1 = parsePositiveIntOrUndefined(req.query?.vadMaxSingleSegmentMs);
    const qVad2 = parsePositiveIntOrUndefined(req.query?.vadMaxEndSilenceMs);
    if (qVad1 !== undefined) options.vadMaxSingleSegmentMs = qVad1;
    if (qVad2 !== undefined) options.vadMaxEndSilenceMs = qVad2;

    const itemsInput = itemsRaw as unknown as V2BatchItemInput[];

    const materializeItem = async (idx: number, input: V2BatchItemInput): Promise<V2BatchItem> => {
      const createdAt = new Date().toISOString();
      const itemDir = path.join(batchOutDir, "items", String(idx));
      await fs.promises.mkdir(itemDir, { recursive: true });

      if (input.kind === "upload") {
        const fi = Number(input.fileIndex);
        if (!Number.isFinite(fi) || fi < 0 || fi >= files.length) {
          throw new HttpError(400, "bad_request", `items[${idx}]: invalid fileIndex`);
        }
        const f = files[fi]!;
        const ext = path.extname(f.originalname) || path.extname(f.filename) || ".bin";
        const dest = path.join(batchOutDir, "inputs", `${idx}${ext}`);
        try {
          await fs.promises.rename(f.path, dest);
        } catch {
          await fs.promises.copyFile(f.path, dest);
          await fs.promises.rm(f.path, { force: true });
        }
        return {
          idx,
          input: { kind: "upload", fileIndex: fi },
          source: "upload",
          audioPath: dest,
          ownedInput: true,
          state: "queued",
          phase: "queued",
          createdAt,
          artifacts: {},
        };
      }

      if (input.kind === "audioUrl") {
        const url = String(input.audioUrl ?? "").trim();
        if (!url) throw new HttpError(400, "bad_request", `items[${idx}]: missing audioUrl`);
        const u = new URL(url);
        const ext = path.extname(u.pathname) || ".bin";
        const dest = path.join(batchOutDir, "inputs", `${idx}${ext}`);
        const { bytes } = await downloadToFile(url, dest);
        logLine(`[${requestId}]`, "v2_batch_downloaded", { batchId, idx, bytes, url });
        return {
          idx,
          input: { kind: "audioUrl", audioUrl: url },
          source: "audioUrl",
          audioPath: dest,
          ownedInput: true,
          state: "queued",
          phase: "queued",
          createdAt,
          artifacts: {},
        };
      }

      if (input.kind === "audioPath") {
        const p = String(input.audioPath ?? "").trim();
        if (!p) throw new HttpError(400, "bad_request", `items[${idx}]: missing audioPath`);
        return {
          idx,
          input: { kind: "audioPath", audioPath: p },
          source: "audioPath",
          audioPath: p,
          ownedInput: false,
          state: "queued",
          phase: "queued",
          createdAt,
          artifacts: {},
        };
      }

      throw new HttpError(400, "bad_request", `items[${idx}]: invalid kind`);
    };

    const batch: V2Batch = {
      id: batchId,
      state: "queued",
      phase: "validate",
      createdAt: new Date().toISOString(),
      outDir: batchOutDir,
      options,
      items: [],
    };

    // Materialize inputs
    for (let idx = 0; idx < itemsInput.length; idx++) {
      const input = itemsInput[idx] as V2BatchItemInput;
      const kind = (input as { kind?: unknown }).kind;
      if (kind !== "upload" && kind !== "audioPath" && kind !== "audioUrl") {
        throw new HttpError(400, "bad_request", `items[${idx}]: kind must be upload|audioPath|audioUrl`);
      }
      batch.items.push(await materializeItem(idx, input));
    }

    v2Batches.set(batchId, batch);
    await persistV2Batch(batch);

    logLine(`[${requestId}]`, "v2_batch_created", {
      batchId,
      items: batch.items.length,
      policy: batch.options.policy,
      tasks: batch.options.tasks,
      pending: queue.pending,
      running: queue.running,
    });

    void queue
      .add(async () => {
        logLine(`[${batchId}]`, "v2_batch_start", { items: batch.items.length });
        await runV2Batch(batch);
        logLine(`[${batchId}]`, "v2_batch_done", { state: batch.state, phase: batch.phase });
      })
      .catch(async (err) => {
        batch.state = "failed";
        batch.phase = "error";
        batch.finishedAt = new Date().toISOString();
        batch.expiresAt = new Date(Date.now() + config.jobTtlSeconds * 1000).toISOString();
        batch.error = { code: "internal_error", message: (err as Error)?.message ?? String(err) };
        await persistV2Batch(batch);
        logLine(`[${batchId}]`, "v2_batch_unhandled", { message: (err as Error)?.message ?? String(err) });
      });

    res.setHeader("x-request-id", requestId);
    res.setHeader("x-batch-id", batchId);
    return res.status(202).json({
      status: "ok",
      data: { batchId, statusUrl: `/v2/batches/${batchId}` },
    });
  } catch (err) {
    next(err);
  }
});

app.get("/v2/batches/:id", bearerAuth, (req, res) => {
  const id = String(req.params.id || "").trim();
  const batch = v2Batches.get(id);
  if (!batch) {
    return res.status(404).json(toErrorBody(new HttpError(404, "not_found", "Batch not found")));
  }
  return res.json({ status: "ok", data: v2BatchToResponse(req, batch) });
});

app.get("/v2/batches/:id/items/:idx/artifacts/:name", bearerAuth, async (req, res, next) => {
  try {
    const id = String(req.params.id || "").trim();
    const idx = Number.parseInt(String(req.params.idx || ""), 10);
    const name = String(req.params.name || "").trim();
    const batch = v2Batches.get(id);
    if (!batch) throw new HttpError(404, "not_found", "Batch not found");
    if (!Number.isFinite(idx) || idx < 0 || idx >= batch.items.length) {
      throw new HttpError(404, "not_found", "Batch item not found");
    }
    const item = batch.items[idx]!;
    const artifact = Object.values(item.artifacts).find((a) => a.name === name);
    if (!artifact || !artifact.ready) {
      throw new HttpError(404, "not_found", "Artifact not found (or not ready yet)");
    }
    res.setHeader("x-batch-id", batch.id);
    await downloadAttachment({
      req,
      res,
      requestId: `${batch.id}:${idx}`,
      downloadPath: artifact.path,
      downloadName: artifact.name,
    });
  } catch (err) {
    next(err);
  }
});

app.post("/v2/batches/:id/cancel", bearerAuth, async (req, res) => {
  void req;
  const id = String(req.params.id || "").trim();
  const batch = v2Batches.get(id);
  if (!batch) {
    return res.status(404).json(toErrorBody(new HttpError(404, "not_found", "Batch not found")));
  }
  batch.cancelRequested = true;
  await persistV2Batch(batch);
  return res.json({ status: "ok", data: { batchId: batch.id, cancelRequested: true } });
});

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
