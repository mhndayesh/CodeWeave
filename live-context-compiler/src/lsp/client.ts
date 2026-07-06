import { spawn, type ChildProcess } from "node:child_process";

// Minimal Language Server Protocol client over a child process's stdio.
// Just enough to initialize, open documents, and query symbols/references.
export class LspClient {
  private proc: ChildProcess;
  private buf = Buffer.alloc(0);
  private pending = new Map<number, (msg: any) => void>();
  private nextId = 1;
  private exited = false;

  constructor(command: string, args: string[], cwd?: string) {
    this.proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], cwd });
    this.proc.stdout!.on("data", (d: Buffer) => this.onData(d));
    this.proc.stderr?.on("data", () => {}); // swallow server logs
    this.proc.on("exit", () => {
      this.exited = true;
      for (const resolve of this.pending.values()) resolve({ error: "server exited" });
      this.pending.clear();
    });
  }

  get alive(): boolean {
    return !this.exited;
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const header = this.buf.slice(0, headerEnd).toString();
      const m = /Content-Length: (\d+)/i.exec(header);
      if (!m) {
        this.buf = this.buf.slice(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (this.buf.length < start + len) break;
      const body = this.buf.slice(start, start + len).toString();
      this.buf = this.buf.slice(start + len);
      let msg: any;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const resolve = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        resolve(msg);
      }
    }
  }

  private write(obj: unknown): void {
    if (this.exited) return;
    const s = JSON.stringify({ jsonrpc: "2.0", ...(obj as object) });
    this.proc.stdin!.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
  }

  request(method: string, params: unknown, timeoutMs = 15000): Promise<any> {
    if (this.exited) return Promise.resolve({ error: "server exited" });
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ error: "timeout" });
        }
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  async shutdown(): Promise<void> {
    try {
      await this.request("shutdown", null, 3000);
      this.notify("exit", null);
    } catch {
      // ignore
    }
    try {
      this.proc.kill();
    } catch {
      // ignore
    }
  }
}
