import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "../config";

type RunPythonArgs = {
  audioPath: string;
  outDir: string;
  maxCharsPerLine: number;
  timeoutMs: number;
};

function resolvePythonBin(): string {
  if (config.pythonBin) return config.pythonBin;

  const candidates = [
    path.join(process.cwd(), ".venv", "Scripts", "python.exe"),
    path.join(process.cwd(), ".venv", "bin", "python3"),
    path.join(process.cwd(), ".venv", "bin", "python"),
    "python3",
    "python",
  ];
  for (const candidate of candidates) {
    if (candidate === "python3" || candidate === "python") return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return "python3";
}

export async function runAsrViaPython(args: RunPythonArgs): Promise<{ srtPath: string }> {
  const pythonBin = resolvePythonBin();
  const checkPy = config.checkPy;

  const base = path.parse(args.audioPath).name;
  const srtPath = path.join(args.outDir, `${base}.funasr.srt`);

  await fs.promises.mkdir(args.outDir, { recursive: true });

  const child = spawn(
    pythonBin,
    [
      checkPy,
      "--audio",
      args.audioPath,
      "--out-dir",
      args.outDir,
      "--max-chars-per-line",
      String(args.maxCharsPerLine),
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  child.stderr.on("data", (d) => (stderr += String(d)));

  const exitCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ASR timeout after ${args.timeoutMs}ms`));
    }, args.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });

  if (exitCode !== 0) {
    const error = new Error("Python ASR failed");
    (error as unknown as { code: string }).code = "PY_ASR_FAILED";
    (error as unknown as { details: unknown }).details = { exitCode, stdout, stderr };
    throw error;
  }

  return { srtPath };
}
