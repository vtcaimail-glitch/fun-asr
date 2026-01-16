import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type WorkerResponse =
  | { type: "ready"; pid: number; device?: string; ncpu?: number; idleSeconds?: number }
  | { type: "result"; id: number; ok: true; srtPath: string }
  | { type: "result"; id: number; ok: false; error: string; traceback?: string }
  | { type: "shutdown"; id?: number; ok: true }
  | Record<string, unknown>;

type Pending = {
  resolve: (value: { srtPath: string }) => void;
  reject: (err: Error) => void;
};

export type PythonWorkerEvent =
  | { type: "spawn"; pid?: number }
  | { type: "ready"; pid: number; device?: string; ncpu?: number; idleSeconds?: number }
  | { type: "stderr"; pid?: number; line: string }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null };

export class PythonAsrWorker {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuf = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private starting: Promise<void> | undefined;
  private ready = false;
  private lastReady: { pid: number; device?: string; ncpu?: number; idleSeconds?: number } | undefined;
  private stderrBuf = "";

  constructor(
    private readonly pythonBin: string,
    private readonly runnerPath: string,
    private readonly idleSeconds: number,
    private readonly onEvent?: (ev: PythonWorkerEvent) => void
  ) {}

  async requestAsr(args: { audioPath: string; outDir: string }): Promise<{ srtPath: string }> {
    await this.ensureStarted();
    const child = this.child;
    if (!child) throw new Error("Python worker not running");

    const id = this.nextId++;
    const payload = JSON.stringify({ type: "asr", id, audioPath: args.audioPath, outDir: args.outDir }) + "\n";

    const resultPromise = new Promise<{ srtPath: string }>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    child.stdin.write(payload);
    return resultPromise;
  }

  private async ensureStarted(): Promise<void> {
    if (this.child) return;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      const child = spawn(
        this.pythonBin,
        [this.runnerPath, "--worker", "--idle-seconds", String(this.idleSeconds)],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
      this.child = child;
      this.stdoutBuf = "";
      this.ready = false;
      this.lastReady = undefined;
      this.stderrBuf = "";
      this.onEvent?.({ type: "spawn", pid: child.pid });

      child.stdout.on("data", (d) => this.onStdout(String(d)));
      child.stderr.on("data", (d) => this.onStderr(String(d)));

      child.on("close", (code, signal) => {
        this.onEvent?.({ type: "exit", code: code ?? null, signal: (signal as NodeJS.Signals) ?? null });
        const err = new Error(`Python worker exited code=${code ?? "null"} signal=${signal ?? "null"}`);
        for (const { reject } of this.pending.values()) reject(err);
        this.pending.clear();
        this.child = undefined;
        this.starting = undefined;
      });

      await this.waitForReady();
    })();

    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async waitForReady(): Promise<void> {
    const child = this.child;
    if (!child) throw new Error("Python worker not running");
    if (this.ready) return;

    await new Promise<void>((resolve, reject) => {
      const onLine = (msg: WorkerResponse) => {
        if ((msg as { type?: string }).type === "ready") {
          this.ready = true;
          cleanup();
          resolve();
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Python worker exited before ready"));
      };
      const cleanup = () => {
        this._onMessage = prev;
        child.off("close", onClose);
      };
      const prev = this._onMessage;
      this._onMessage = (msg) => {
        onLine(msg);
        prev?.(msg);
      };
      child.on("close", onClose);
    });
  }

  private _onMessage: ((msg: WorkerResponse) => void) | undefined;

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    while (true) {
      const idx = this.stdoutBuf.indexOf("\n");
      if (idx < 0) break;
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;

      let msg: WorkerResponse;
      try {
        msg = JSON.parse(line) as WorkerResponse;
      } catch {
        continue;
      }

      if ((msg as { type?: string }).type === "ready") {
        const m = msg as { pid: number; device?: string; ncpu?: number; idleSeconds?: number };
        this.ready = true;
        this.lastReady = { pid: m.pid, device: m.device, ncpu: m.ncpu, idleSeconds: m.idleSeconds };
        this.onEvent?.({ type: "ready", ...this.lastReady });
      }
      this._onMessage?.(msg);

      if ((msg as { type?: string }).type === "result") {
        const m = msg as { id: number; ok: boolean; srtPath?: string; error?: string; traceback?: string };
        const pending = this.pending.get(m.id);
        if (!pending) continue;
        this.pending.delete(m.id);

        if (m.ok && m.srtPath) {
          pending.resolve({ srtPath: m.srtPath });
        } else {
          const err = new Error(m.error || "Python worker ASR failed");
          (err as unknown as { code: string }).code = "PY_ASR_FAILED";
          (err as unknown as { details: unknown }).details = { error: m.error, traceback: m.traceback };
          pending.reject(err);
        }
      }
    }
  }

  private onStderr(chunk: string): void {
    this.stderrBuf += chunk;
    while (true) {
      const idx = this.stderrBuf.indexOf("\n");
      if (idx < 0) break;
      const line = this.stderrBuf.slice(0, idx).trimEnd();
      this.stderrBuf = this.stderrBuf.slice(idx + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      const msg = trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}…` : trimmed;
      this.onEvent?.({ type: "stderr", pid: this.child?.pid, line: msg });
    }
  }
}
