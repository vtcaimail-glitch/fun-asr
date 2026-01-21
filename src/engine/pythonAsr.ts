import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { PythonAsrWorker } from "./pythonWorker";

type RunPythonArgs = {
  audioPath: string;
  outDir: string;
  vadMaxSingleSegmentMs?: number;
  vadMaxEndSilenceMs?: number;
};

function resolvePythonBin(): string {
  if (config.pythonBin) {
    const looksLikePath = config.pythonBin.includes("/") || config.pythonBin.includes("\\");
    if (looksLikePath && !fs.existsSync(config.pythonBin)) {
      throw new Error(`PYTHON_BIN points to a missing file: ${config.pythonBin}`);
    }
    return config.pythonBin;
  }

  const venvPython =
    process.platform === "win32"
      ? path.join(process.cwd(), ".venv", "Scripts", "python.exe")
      : path.join(process.cwd(), ".venv", "bin", "python");

  if (fs.existsSync(venvPython)) return venvPython;

  throw new Error(
    `Python .venv not found. Expected ${venvPython}. Create it or set PYTHON_BIN to the venv python executable.`
  );
}

let worker: PythonAsrWorker | undefined;

export async function runAsrViaPython(args: RunPythonArgs): Promise<{ srtPath: string }> {
  const pythonBin = resolvePythonBin();
  const runner = config.checkPy;

  await fs.promises.mkdir(args.outDir, { recursive: true });

  const idleSeconds = 5 * 60;
  const makeWorker = () =>
    new PythonAsrWorker(pythonBin, runner, idleSeconds, (ev) => {
      const ts2 = new Date().toISOString();
      if (ev.type === "spawn") console.log(`[${ts2}] [python-worker] spawn pid=${ev.pid ?? "?"}`);
      if (ev.type === "ready")
        console.log(
          `[${ts2}] [python-worker] ready pid=${ev.pid} device=${ev.device ?? "?"} ncpu=${ev.ncpu ?? "?"} idleSeconds=${
            ev.idleSeconds ?? "?"
          }`
        );
      if (ev.type === "stderr") console.log(`[${ts2}] [python-worker] stderr pid=${ev.pid ?? "?"} ${ev.line}`);
      if (ev.type === "exit")
        console.log(
          `[${ts2}] [python-worker] exit code=${ev.code ?? "null"} signal=${ev.signal ?? "null"}`
        );
    });
  if (!worker) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [python-worker] init pythonBin=${pythonBin} runner=${runner} idleSeconds=${idleSeconds}`);
    worker = makeWorker();
  }

  try {
    return await worker.requestAsr({
      audioPath: args.audioPath,
      outDir: args.outDir,
      vadMaxSingleSegmentMs: args.vadMaxSingleSegmentMs,
      vadMaxEndSilenceMs: args.vadMaxEndSilenceMs,
    });
  } catch (err) {
    // Best-effort: if the worker died while handling the request, respawn once.
    const ts = new Date().toISOString();
    console.log(`[${ts}] [python-worker] respawn after error=${(err as Error)?.message ?? String(err)}`);
    worker = makeWorker();
    return await worker.requestAsr({
      audioPath: args.audioPath,
      outDir: args.outDir,
      vadMaxSingleSegmentMs: args.vadMaxSingleSegmentMs,
      vadMaxEndSilenceMs: args.vadMaxEndSilenceMs,
    });
  }
}
