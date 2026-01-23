import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "../config";
import { resolvePythonBin } from "./pythonBin";

type DemucsResult = {
  vocalsPath: string;
  noVocalsPath: string;
};

const DEFAULT_DEMUCS_MODEL = "htdemucs_ft";
const DEFAULT_DEMUCS_TWO_STEMS = "vocals";

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile()) out.push(full);
    }
  }
  return out;
}

async function findDemucsOutputs(outDir: string): Promise<DemucsResult> {
  const files = await walkFiles(outDir);
  const endsWithStem = (filePath: string, stem: string) => {
    const p = filePath.toLowerCase();
    return p.endsWith(`/${stem}`) || p.endsWith(`\\${stem}`);
  };
  const vocals = files.find((f) => endsWithStem(f, "vocals.mp3"));
  const noVocals = files.find((f) => endsWithStem(f, "no_vocals.mp3"));
  if (!vocals || !noVocals) {
    throw new Error(`Demucs outputs not found under ${outDir}`);
  }
  return { vocalsPath: vocals, noVocalsPath: noVocals };
}

export async function runDemucs(args: { audioPath: string; outDir: string }): Promise<DemucsResult> {
  const pythonBin = resolvePythonBin();
  await fs.promises.mkdir(args.outDir, { recursive: true });

  const demucsArgs = [
    "-m",
    "demucs.separate",
    args.audioPath,
    "-n",
    DEFAULT_DEMUCS_MODEL,
    "--two-stems",
    DEFAULT_DEMUCS_TWO_STEMS,
    "-o",
    args.outDir,
    "--mp3",
    "--mp3-bitrate",
    String(config.demucsMp3Bitrate),
    "-j",
    String(config.demucsJobs),
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(pythonBin, demucsArgs, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 64_000) stderr = `${stderr.slice(0, 64_000)}…`;
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code, signal) => {
      if (code === 0) return resolve();
      const msg = `demucs failed code=${code ?? "null"} signal=${signal ?? "null"}`;
      const err = new Error(stderr.trim() ? `${msg}: ${stderr.trim()}` : msg);
      (err as unknown as { code: string }).code = "DEMUCS_FAILED";
      reject(err);
    });
  });

  return findDemucsOutputs(args.outDir);
}
