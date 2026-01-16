import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "../config";

type RunPythonArgs = {
  audioPath: string;
  outDir: string;
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

export async function runAsrViaPython(args: RunPythonArgs): Promise<{ srtPath: string }> {
  const pythonBin = resolvePythonBin();
  const checkPy = config.checkPy;

  const base = path.parse(args.audioPath).name;
  const srtPath = path.join(args.outDir, `${base}.funasr.srt`);

  await fs.promises.mkdir(args.outDir, { recursive: true });

  const child = spawn(
    pythonBin,
    [checkPy, "--audio", args.audioPath, "--out-dir", args.outDir],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  child.stderr.on("data", (d) => (stderr += String(d)));

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
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
