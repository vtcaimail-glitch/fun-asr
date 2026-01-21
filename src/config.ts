import "dotenv/config";
import path from "node:path";

type Config = {
  port: number;
  bearerToken: string;
  requireAuth: boolean;
  pythonBin: string;
  ffmpegBin: string;
  checkPy: string;
  tmpDir: string;
};

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return value;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
}

export const config: Config = {
  port: readInt("PORT", 3000),
  bearerToken: process.env.BEARER_TOKEN ?? "",
  requireAuth: readBool("REQUIRE_AUTH", true),
  pythonBin: process.env.PYTHON_BIN ?? "",
  ffmpegBin: process.env.FFMPEG_BIN ?? "ffmpeg",
  checkPy: process.env.CHECK_PY ?? path.join(process.cwd(), "python", "funasr_runner.py"),
  tmpDir: process.env.TMP_DIR ?? path.join(process.cwd(), "tmp"),
};

export function validateConfig(): void {
  if (config.requireAuth && !config.bearerToken) {
    throw new Error("Missing BEARER_TOKEN (set REQUIRE_AUTH=false to disable auth).");
  }
}
