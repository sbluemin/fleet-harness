import { randomUUID, createCipheriv, createDecipheriv } from "node:crypto";
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
  private sendKey: Buffer | null = null;
  private receiveKey: Buffer | null = null;
  private sendSequence = 0;
  private receiveSequence = 0;
  /** 인증 완료 후에는 방향별 AEAD key로 business 결과와 keeper ref도 보호한다. */
  secure(sendKey: Buffer, receiveKey: Buffer): void {
    if (this.sendKey || this.receiveKey) throw new Error("session_rpc_already_secure");
    this.sendKey = sendKey; this.receiveKey = receiveKey;
  }
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
    let serialized = JSON.stringify(frame);
    if (this.sendKey) {
      if (this.sendSequence >= 0xffffffff) { this.close(); throw new Error("session_rpc_key_limit"); }
      const sequence = ++this.sendSequence;
      const nonce = Buffer.alloc(12); nonce.writeBigUInt64BE(BigInt(sequence), 4);
      const cipher = createCipheriv("aes-256-gcm", this.sendKey, nonce); cipher.setAAD(Buffer.from(String(sequence)));
      const data = Buffer.concat([cipher.update(serialized, "utf8"), cipher.final()]);
      serialized = JSON.stringify({ secure: true, sequence, tag: cipher.getAuthTag().toString("hex"), data: data.toString("base64") });
    }
    const bytes = Buffer.from(serialized + "\n");
    if (this.closed || bytes.length > SESSION_FRAME_MAX_BYTES || this.socket.writableLength > SESSION_FRAME_MAX_BYTES) { this.close(); throw new Error("session_rpc_frame_limit"); }
    this.socket.write(bytes);
  }
  private async receive(frame: Frame): Promise<void> {
    try {
      if (this.receiveKey) {
        const envelope = frame as unknown as { secure: boolean; sequence: number; tag: string; data: string };
        if (!envelope || envelope.secure !== true || !Number.isSafeInteger(envelope.sequence) || envelope.sequence > 0xffffffff || envelope.sequence !== this.receiveSequence + 1 || !/^[a-f0-9]{32}$/.test(envelope.tag) || typeof envelope.data !== "string") throw new Error("invalid_session_envelope");
        const nonce = Buffer.alloc(12); nonce.writeBigUInt64BE(BigInt(envelope.sequence), 4);
        const cipher = createDecipheriv("aes-256-gcm", this.receiveKey, nonce); cipher.setAAD(Buffer.from(String(envelope.sequence))); cipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
        frame = JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.data, "base64")), cipher.final()]).toString("utf8")) as Frame;
        this.receiveSequence = envelope.sequence;
      }
    } catch { this.close(); return; }
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
