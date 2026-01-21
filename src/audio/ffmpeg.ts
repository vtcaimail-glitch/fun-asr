import { spawn } from "node:child_process";

export async function convertToWavMono16k(args: {
  ffmpegBin: string;
  inputPath: string;
  outputWavPath: string;
}): Promise<void> {
  const ffmpegArgs = [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    args.inputPath,
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    args.outputWavPath,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(args.ffmpegBin, ffmpegArgs, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 32_000) stderr = `${stderr.slice(0, 32_000)}…`;
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code, signal) => {
      if (code === 0) return resolve();
      const msg = `ffmpeg failed code=${code ?? "null"} signal=${signal ?? "null"}`;
      const err = new Error(stderr.trim() ? `${msg}: ${stderr.trim()}` : msg);
      (err as unknown as { code: string }).code = "FFMPEG_FAILED";
      reject(err);
    });
  });
}

