import { spawn } from "node:child_process";

export async function createZipViaPython(args: {
  pythonBin: string;
  zipPath: string;
  files: Array<{ path: string; name: string }>;
}): Promise<void> {
  const payload = JSON.stringify({ zipPath: args.zipPath, files: args.files });
  const script = `
import json, sys, zipfile
from pathlib import Path

req = json.loads(sys.argv[1])
zip_path = Path(req["zipPath"])
zip_path.parent.mkdir(parents=True, exist_ok=True)

with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as z:
    for f in req["files"]:
        z.write(f["path"], arcname=f["name"])
`;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(args.pythonBin, ["-c", script, payload], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 32_000) stderr = `${stderr.slice(0, 32_000)}…`;
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code, signal) => {
      if (code === 0) return resolve();
      const msg = `python zip failed code=${code ?? "null"} signal=${signal ?? "null"}`;
      reject(new Error(stderr.trim() ? `${msg}: ${stderr.trim()}` : msg));
    });
  });
}

