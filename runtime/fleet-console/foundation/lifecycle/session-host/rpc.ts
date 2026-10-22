import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { SESSION_FRAME_MAX_BYTES, SESSION_RPC_TIMEOUT_MS } from "@fleet-console/protocol/session-host";

type Frame = { id: string; method: string; body?: unknown } | { reply: string; value?: unknown; error?: string };
export type RpcHandler = (method: string, body: unknown) => unknown | Promise<unknown>;
/** Bounded, full-duplex local RPC; a lost connection never replays a request. */
export class SessionRpcPeer {
  private input = Buffer.alloc(0);
  private closed = false;
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> | undefined }>();
  private readonly closeListeners = new Set<() => void>();
  private handler: RpcHandler = () => { throw new Error("session_rpc_unbound"); };
  constructor(readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.input = Buffer.concat([this.input, chunk]);
      for (;;) {
        const end = this.input.indexOf(10);
        if (end < 0) break;
        if (end > SESSION_FRAME_MAX_BYTES) { this.close(); return; }
        const line = this.input.subarray(0, end);
        this.input = this.input.subarray(end + 1);
        try { void this.receive(JSON.parse(line.toString("utf8")) as Frame); } catch { this.close(); return; }
      }
      if (this.input.length > SESSION_FRAME_MAX_BYTES) this.close();
    });
    socket.on("error", () => this.close());
    socket.on("close", () => this.close());
  }
  bind(handler: RpcHandler): void { this.handler = handler; }
  onClose(listener: () => void): () => void { this.closeListeners.add(listener); return () => this.closeListeners.delete(listener); }
  get isClosed(): boolean { return this.closed; }
  call<T = unknown>(method: string, body?: unknown, timeoutMs = SESSION_RPC_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(new Error("session_rpc_closed"));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => { this.pending.delete(id); reject(new Error("session_rpc_timeout")); }, timeoutMs) : undefined;
      timer?.unref();
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try { this.send({ id, method, body }); } catch (error) {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      }
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error("session_rpc_closed")); }
    this.pending.clear();
    for (const listener of this.closeListeners) { try { listener(); } catch { /* Closing cannot strand other waiters. */ } }
    this.closeListeners.clear();
  }
  private send(frame: Frame): void {
    const bytes = Buffer.from(JSON.stringify(frame) + "\n");
    if (this.closed || bytes.length > SESSION_FRAME_MAX_BYTES || this.socket.writableLength > SESSION_FRAME_MAX_BYTES) throw new Error("session_rpc_frame_limit");
    this.socket.write(bytes);
  }
  private async receive(frame: Frame): Promise<void> {
    if (!frame || typeof frame !== "object") { this.close(); return; }
    if ("reply" in frame) {
      const pending = this.pending.get(frame.reply);
      if (!pending) return;
      this.pending.delete(frame.reply); clearTimeout(pending.timer);
      if (typeof frame.error === "string") pending.reject(new Error(frame.error)); else pending.resolve(frame.value);
      return;
    }
    if (typeof frame.id !== "string" || typeof frame.method !== "string") { this.close(); return; }
    try { const value = await this.handler(frame.method, frame.body); if (!this.closed) this.send({ reply: frame.id, value }); }
    catch (error) { try { if (!this.closed) this.send({ reply: frame.id, error: error instanceof Error ? error.message : "session_rpc_failed" }); } catch { this.close(); } }
  }
}
export async function connectSessionRpc(socket: string): Promise<SessionRpcPeer> {
  const stream = new Socket();
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    const ready = () => { stream.off("error", reject); resolve(); };
    stream.connect(socket, ready);
  });
  return new SessionRpcPeer(stream);
}
