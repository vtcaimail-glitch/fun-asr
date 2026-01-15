import fs from "node:fs";
import path from "node:path";

export async function downloadToFile(
  url: string,
  destPath: string,
  maxBytes: number
): Promise<{ bytes: number }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  if (!response.body) throw new Error("Download failed: empty body");

  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const file = fs.createWriteStream(destPath);

  let bytes = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new Error(`Download too large (>${maxBytes} bytes)`);
      if (!file.write(chunk)) await new Promise((r) => file.once("drain", r));
    }
  } finally {
    await new Promise<void>((resolve) => file.end(() => resolve()));
  }

  return { bytes };
}
