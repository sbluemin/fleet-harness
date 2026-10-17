import crypto from "node:crypto";
import tls from "node:tls";

import { normalizeFingerprint } from "@fleet-console/protocol/remote";

/** 셸 안에서만 여는 원격 WebSocket. 티켓은 요청 줄에만 있고 relay로 나가지 않는다. */
export interface PinnedSocket {
  sendText(text: string): void;
  sendBytes(bytes: Buffer): void;
  close(): void;
  readonly closed: Promise<void>;
}

const MAX_PAYLOAD = 1024 * 1024;
const MAX_BUFFER = MAX_PAYLOAD + 64 * 1024;
const MAX_FRAGMENTS = 32;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function websocketAccept(key: string): string {
  return crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
}

function headerValue(head: string, name: string): string {
  for (const line of head.split("\r\n").slice(1)) {
    const split = line.indexOf(":");
    if (split <= 0) continue;
    if (line.slice(0, split).trim().toLowerCase() !== name) continue;
    return line.slice(split + 1).trim();
  }
  return "";
}

export function openPinnedWebSocket(input: {
  readonly hostname: string;
  readonly port: number;
  readonly path: string;
  readonly fingerprint: string;
  readonly cookie: string;
  readonly signal: AbortSignal;
  readonly onText: (text: string) => Promise<void> | void;
  readonly onBytes: (bytes: Buffer) => Promise<void> | void;
}): Promise<PinnedSocket> {
  if (input.signal.aborted) return Promise.reject(new Error("remote_host_unavailable"));
  const expected = normalizeFingerprint(input.fingerprint);
  return new Promise((resolve, reject) => {
    let settled = false;
    let handshake = false;
    let buffer = Buffer.alloc(0);
    let fragments: Buffer[] = [];
    let fragmentBytes = 0;
    let outstanding = 0;
    let accept = "";
    const fail = (error: Error): void => {
      if (settled) { socket.destroy(); return; }
      settled = true;
      socket.destroy();
      reject(error);
    };
    const socket = tls.connect({
      host: input.hostname,
      port: input.port,
      rejectUnauthorized: false,
      servername: input.hostname.includes(":") ? undefined : input.hostname,
    });
    const closed = new Promise<void>((done) => socket.once("close", () => done()));
    socket.once("close", () => { if (!settled) fail(new Error("remote_host_unavailable")); });
    const abort = (): void => { socket.destroy(); };
    input.signal.addEventListener("abort", abort, { once: true });
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerX509Certificate();
      const presented = certificate ? normalizeFingerprint(certificate.fingerprint256) : "";
      // 지문이 다르면 티켓과 쿠키가 든 요청 줄을 쓰지 않는다.
      if (presented !== expected) { fail(new Error("remote_host_fingerprint_mismatch")); return; }
      const host = input.hostname.includes(":") ? `[${input.hostname}]` : input.hostname;
      const key = crypto.randomBytes(16).toString("base64");
      accept = websocketAccept(key);
      const lines = [
        `GET ${input.path} HTTP/1.1`,
        `Host: ${host}:${input.port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        `Origin: https://${host}:${input.port}`,
        ...(input.cookie ? [`Cookie: ${input.cookie}`] : []),
        "",
        "",
      ];
      socket.write(lines.join("\r\n"));
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_BUFFER) { fail(new Error("remote_host_unavailable")); return; }
      if (!handshake) {
        const split = buffer.indexOf("\r\n\r\n");
        if (split < 0) { if (buffer.length > 8192) fail(new Error("remote_host_unavailable")); return; }
        const head = buffer.subarray(0, split).toString("latin1");
        buffer = buffer.subarray(split + 4);
        handshake = true;
        if (!head.startsWith("HTTP/1.1 101") || headerValue(head, "sec-websocket-accept") !== accept) {
          fail(new Error("remote_host_unavailable"));
          return;
        }
        settled = true;
        resolve({
          sendText: (text) => socket.write(clientFrame(0x1, Buffer.from(text))),
          sendBytes: (bytes) => socket.write(clientFrame(0x2, bytes)),
          close: () => { socket.write(clientFrame(0x8, Buffer.alloc(0))); socket.end(); },
          closed,
        });
      }
      try {
        const taken = takeServerFrames(buffer);
        buffer = Buffer.from(taken.rest);
        for (const frame of taken.frames) {
          if (frame.opcode === 0x8) { socket.end(); return; }
          if (frame.opcode === 0x9) { socket.write(clientFrame(0xa, frame.payload)); continue; }
          if (frame.opcode === 0x0) {
            if (fragments.length >= MAX_FRAGMENTS || fragmentBytes + frame.payload.length > MAX_PAYLOAD) throw new Error("frame_too_large");
            fragments.push(frame.payload);
            fragmentBytes += frame.payload.length;
            continue;
          }
          const payload = frame.opcode === 0x1 || frame.opcode === 0x2
            ? Buffer.concat([...fragments, frame.payload])
            : null;
          fragments = [];
          fragmentBytes = 0;
          if (!payload) continue;
          if (payload.length > MAX_PAYLOAD || outstanding + payload.length > MAX_PAYLOAD) throw new Error("frame_too_large");
          outstanding += payload.length;
          socket.pause();
          const delivered = frame.opcode === 0x1 ? input.onText(payload.toString("utf8")) : input.onBytes(payload);
          void Promise.resolve(delivered).finally(() => {
            outstanding -= payload.length;
            if (outstanding < MAX_PAYLOAD) socket.resume();
          });
        }
      } catch {
        fail(new Error("remote_host_unavailable"));
      }
    });
    socket.once("error", () => fail(new Error("remote_host_unreachable")));
  });
}

export function clientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = crypto.randomBytes(4);
  const length = payload.length < 126 ? Buffer.from([0x80 | payload.length]) : payload.length < 65536
    ? Buffer.from([0x80 | 126, payload.length >> 8, payload.length & 0xff])
    : Buffer.concat([Buffer.from([0x80 | 127]), bigLength(payload.length)]);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index]! ^ mask[index % 4]!;
  return Buffer.concat([Buffer.from([0x80 | opcode]), length, mask, masked]);
}

function bigLength(length: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32BE(Math.floor(length / 2 ** 32), 0);
  bytes.writeUInt32BE(length >>> 0, 4);
  return bytes;
}

export function takeServerFrames(buffer: Buffer): { readonly frames: readonly { readonly opcode: number; readonly payload: Buffer }[]; readonly rest: Buffer } {
  const frames: { opcode: number; payload: Buffer }[] = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset]! & 0x0f;
    const lengthByte = buffer[offset + 1]! & 0x7f;
    let header = 2;
    let length = lengthByte;
    if (lengthByte === 126) header = 4;
    else if (lengthByte === 127) header = 10;
    if (buffer.length - offset < header) break;
    if (lengthByte === 126) length = buffer.readUInt16BE(offset + 2);
    if (lengthByte === 127) length = Number(buffer.readBigUInt64BE(offset + 2));
    if (length > MAX_PAYLOAD) throw new Error("frame_too_large");
    if (buffer.length - offset < header + length) break;
    frames.push({ opcode, payload: buffer.subarray(offset + header, offset + header + length) });
    offset += header + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}
