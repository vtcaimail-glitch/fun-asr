import fs from "node:fs";
import path from "node:path";
import { config } from "../config";

export function resolvePythonBin(): string {
  const venvPython =
    process.platform === "win32"
      ? path.join(process.cwd(), ".venv", "Scripts", "python.exe")
      : path.join(process.cwd(), ".venv", "bin", "python");

  if (fs.existsSync(venvPython)) return venvPython;

  if (config.pythonBin) {
    const looksLikePath = config.pythonBin.includes("/") || config.pythonBin.includes("\\");
    if (looksLikePath && !fs.existsSync(config.pythonBin)) {
      throw new Error(`PYTHON_BIN points to a missing file: ${config.pythonBin}`);
    }
    return config.pythonBin;
  }

  throw new Error(
    `Python .venv not found. Expected ${venvPython}. Create it in repo root (./.venv).`
  );
}
