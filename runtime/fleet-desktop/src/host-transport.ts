import { DESKTOP_HOST_TRANSPORT_EVENT, DESKTOP_HOST_TRANSPORT_EVENTS_PATH, DESKTOP_HOST_TRANSPORT_PATH, DESKTOP_HOST_TRANSPORT_RELAY_PATH, isDesktopHostSnapshot, type DesktopHostCommand, type DesktopHostRelay } from "@fleet-console/protocol/desktop";
import { normalizeFingerprint } from "@fleet-console/protocol/remote";
import { HOST_UPLOAD_MAX_BYTES } from "@fleet-console/protocol/remote/host-transport";

import { createDesktopEventStream } from "./desktop-event-stream.js";
import { openPinnedWebSocket, type PinnedSocket } from "./host-socket.js";

export interface HostPartitionCookie {
  readonly name: string;
  readonly value: string;
  readonly path?: string;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
}

export interface HostPartition {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  readCookies(url: string): Promise<readonly HostPartitionCookie[]>;
  writeCookie(cookie: HostPartitionCookie & { readonly url: string }): Promise<void>;
  pin(hostname: string, fingerprint: string): void;
  clear(): void;
}

export interface HostTransportExecutorDeps {
  readonly confirmIdentity: (hostname: string, port: number, fingerprint: string) => Promise<void>;
  readonly openPartition: (hostKey: string) => HostPartition;
  readonly readWindowCookies: (url: string) => Promise<readonly HostPartitionCookie[]>;
  readonly writeWindowCookie: (cookie: HostPartitionCookie & { readonly url: string }) => Promise<void>;
  readonly openSocket?: typeof openPinnedWebSocket;
}

const SESSION_RESPONSE = "/api/v1/sessions";
const TICKET_PATH = "/api/v1/agent/ticket";
const TERMINAL_SOCKET_PATH = "/api/v1/terminal/ws";
const FRAME_CHARS = 32 * 1024;
const RELAY_ATTEMPTS = 3;
const RELAY_BACKOFF_MS = [200, 400];

interface HostJob {
  readonly hostKey: string;
  readonly epoch: number;
  abort(): void;
  send?(payload: { readonly text?: string; readonly dataBase64?: string }): void;
}

export function createHostTransportExecutor(deps: HostTransportExecutorDeps): {
  execute(command: DesktopHostCommand, signal?: AbortSignal): Promise<DesktopHostRelay>;
  run(command: DesktopHostCommand, emit: (relay: DesktopHostRelay) => Promise<void>, signal?: AbortSignal): Promise<void>;
  releaseConsole(): void;
} {
  const partitions = new Map<string, { readonly origin: string; readonly fingerprint: string; readonly partition: HostPartition }>();
  const epochs = new Map<string, number>();
  const jobs = new Map<number, HostJob>();
  // 새 콘솔 프로세스는 같은 출처라도 명령 번호와 epoch를 1부터 다시 쓴다. 이 실행기가 앞 세션의 값을 남기면 새 명령이 걸리거나 stale_epoch가 된다.
  const releaseConsole = (): void => {
    epochs.clear();
    for (const [id, job] of jobs) {
      jobs.delete(id);
      job.abort();
    }
  };

  const admitEpoch = (command: DesktopHostCommand): boolean => {
    const current = epochs.get(command.hostKey);
    if (current !== undefined && command.epoch < current) return false;
    if (current !== undefined && command.epoch > current) {
      for (const [id, job] of jobs) if (job.hostKey === command.hostKey && job.epoch < command.epoch) { jobs.delete(id); job.abort(); }
    }
    epochs.set(command.hostKey, command.epoch);
    return true;
  };

  const partitionFor = async (command: DesktopHostCommand): Promise<{ origin: string; partition: HostPartition } | DesktopHostRelay> => {
    try {
      await deps.confirmIdentity(command.target.hostname, command.target.port, command.target.fingerprint);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return { id: command.id, error: message === "remote_link_fingerprint_mismatch" ? "remote_host_fingerprint_mismatch" : "remote_host_unreachable" };
    }
    const host = command.target.hostname.includes(":") ? `[${command.target.hostname}]` : command.target.hostname;
    const origin = new URL(`https://${host}:${command.target.port}`).origin;
    const existing = partitions.get(command.hostKey);
    if (existing && (existing.origin !== origin || existing.fingerprint !== command.target.fingerprint)) {
      existing.partition.clear();
      partitions.delete(command.hostKey);
    }
    const partition = partitions.get(command.hostKey)?.partition ?? deps.openPartition(command.hostKey);
    partition.pin(command.target.hostname, normalizeFingerprint(command.target.fingerprint));
    partitions.set(command.hostKey, { origin, fingerprint: normalizeFingerprint(command.target.fingerprint), partition });
    await copyPairingCookie(origin, command.target.port, partition);
    return { origin, partition };
  };

  const copyPairingCookie = async (origin: string, port: number, partition: HostPartition): Promise<void> => {
    const name = `fleet_console_pairing_${port}`;
    const pairing = (await deps.readWindowCookies(origin)).find((cookie) => cookie.name === name);
    if (!pairing) return;
    await partition.writeCookie({ ...pairing, url: origin });
  };

  const rememberPairing = async (origin: string, port: number, partition: HostPartition): Promise<void> => {
    const name = `fleet_console_pairing_${port}`;
    const renewed = (await partition.readCookies(origin)).find((cookie) => cookie.name === name);
    if (!renewed) return;
    await deps.writeWindowCookie({ ...renewed, url: origin, path: "/", secure: true, httpOnly: true });
  };

  const execute = async (command: DesktopHostCommand, signal?: AbortSignal): Promise<DesktopHostRelay> => {
    // abort는 epoch 거절보다 먼저다. 늦게 도착한 취소가 stale로 버려지면 원격 전송이 끝까지 남는다.
    if (command.op === "abort") {
      const target = command.params.commandId;
      if (typeof target === "number") { const job = jobs.get(target); jobs.delete(target); job?.abort(); }
      return { id: command.id, end: true };
    }
    if (signal?.aborted) return { id: command.id, error: "remote_host_unavailable", end: true };
    if (!admitEpoch(command)) return { id: command.id, error: "stale_epoch" };
    if (command.op === "ws-send" || command.op === "ws-close") return forwardSocket(command);
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    }
    jobs.set(command.id, { hostKey: command.hostKey, epoch: command.epoch, abort: stop });
    try {
      const opened = await partitionFor(command);
      if (controller.signal.aborted) return { id: command.id, error: "remote_host_unavailable", end: true };
      if (!("partition" in opened)) return opened;
      if (command.op === "presence") return await performPresence(command, opened.origin, opened.partition, controller.signal);
      if (command.op === "http" || command.op === "bytes") return await performHttp(command, opened.origin, opened.partition, controller.signal);
      return { id: command.id, error: "remote_host_unavailable" };
    } finally {
      if (jobs.get(command.id)?.abort === stop) jobs.delete(command.id);
      signal?.removeEventListener("abort", stop);
    }
  };

  const run = async (command: DesktopHostCommand, emit: (relay: DesktopHostRelay) => Promise<void>, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) { await emit({ id: command.id, error: "remote_host_unavailable", end: true }); return; }
    if (!admitEpoch(command)) { await emit({ id: command.id, error: "stale_epoch", end: true }); return; }
    const opened = await partitionFor(command);
    if (!("partition" in opened)) { await emit(opened); return; }
    if (command.op === "sse") { await streamEvents(command, opened.origin, opened.partition, emit, signal); return; }
    if (command.op === "ws-open") { await streamSocket(command, opened.origin, opened.partition, emit, signal); return; }
    await emit(await execute(command, signal));
  };

  return { execute, run, releaseConsole };

  function forwardSocket(command: DesktopHostCommand): DesktopHostRelay {
    const socketId = command.params.socketId;
    const job = typeof socketId === "number" ? jobs.get(socketId) : undefined;
    if (!job || job.epoch !== command.epoch || job.hostKey !== command.hostKey) return { id: command.id, error: "remote_host_unavailable" };
    if (command.op === "ws-close") { jobs.delete(socketId as number); job.abort(); return { id: command.id, end: true }; }
    const text = typeof command.params.text === "string" ? command.params.text : undefined;
    const dataBase64 = typeof command.params.dataBase64 === "string" ? command.params.dataBase64 : undefined;
    if ((text?.length ?? 0) > FRAME_CHARS * 4 || (dataBase64?.length ?? 0) > FRAME_CHARS * 8) return { id: command.id, error: "remote_host_unavailable" };
    job.send?.({ ...(text !== undefined ? { text } : {}), ...(dataBase64 !== undefined ? { dataBase64 } : {}) });
    return { id: command.id, end: true };
  }

  async function performPresence(command: DesktopHostCommand, origin: string, partition: HostPartition, signal?: AbortSignal): Promise<DesktopHostRelay> {
    const intent = command.params.intent;
    if (intent !== "observe" && intent !== "activate" && intent !== "release") return { id: command.id, error: "invalid_host_request" };
    let response: Response;
    try {
      response = await partition.fetch(`${origin}${SESSION_RESPONSE}`, {
        method: "POST", redirect: "error", headers: { "content-type": "application/json", Origin: origin }, body: JSON.stringify({ intent }), signal,
      });
    } catch {
      return { id: command.id, error: "remote_host_unavailable" };
    }
    await rememberPairing(origin, command.target.port, partition);
    if (response.status === 404 || response.status === 405) return { id: command.id, capability: "unsupported", error: "host_unsupported" };
    let body: unknown = null;
    try { body = await response.json(); } catch { body = null; }
    if (response.status === 401) return { id: command.id, error: "remote_host_not_paired" };
    if (response.status === 403) return { id: command.id, error: "observer_only" };
    if (!response.ok || !isSessionCapability(body)) return { id: command.id, capability: "unsupported", error: "host_unsupported" };
    return { id: command.id, capability: "supported", mode: body.mode, access: body.access };
  }

  async function performHttp(command: DesktopHostCommand, origin: string, partition: HostPartition, signal?: AbortSignal): Promise<DesktopHostRelay> {
    const path = safePath(command.params.path);
    const method = command.params.method === "GET" || command.params.method === "HEAD" || command.params.method === "POST" || command.params.method === "DELETE" ? command.params.method : null;
    if (!path || !method) return { id: command.id, error: "route_denied" };
    const hasJson = Object.prototype.hasOwnProperty.call(command.params, "json");
    const raw = typeof command.params.dataBase64 === "string" ? command.params.dataBase64 : null;
    if (raw !== null && hasJson) return { id: command.id, error: "route_denied" };
    let body: string | Buffer | undefined;
    let contentType: string | undefined;
    if (hasJson) {
      body = JSON.stringify(command.params.json);
      contentType = "application/json";
    } else if (raw !== null) {
      const bytes = Buffer.from(raw, "base64");
      if (bytes.length === 0 || bytes.length > HOST_UPLOAD_MAX_BYTES) return { id: command.id, error: "route_denied" };
      body = bytes;
      // 브라우저가 말한 MIME은 전달하지 않는다. 원격이 머리 바이트로 판정한다.
      contentType = "application/octet-stream";
    }
    let response: Response;
    try {
      response = await partition.fetch(`${origin}${path}`, {
        method, redirect: "error", signal,
        headers: { Origin: origin, ...(contentType ? { "content-type": contentType } : {}) },
        body,
      });
    } catch {
      return { id: command.id, error: "remote_host_unavailable" };
    }
    await rememberPairing(origin, command.target.port, partition);
    if (response.status === 204 || response.status === 205 || response.status === 304) return { id: command.id, status: response.status, contentType: null };
    const type = response.headers.get("content-type") ?? "";
    if (command.op === "bytes") {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 8 * 1024 * 1024) return { id: command.id, error: "remote_host_unavailable" };
      return { id: command.id, status: response.status, contentType: safeByteType(type), dataBase64: bytes.toString("base64") };
    }
    if (!type.includes("json")) return { id: command.id, status: response.status, contentType: null };
    try { return { id: command.id, status: response.status, contentType: "application/json", json: await response.json() }; }
    catch { return { id: command.id, status: response.status, contentType: null }; }
  }

  async function streamEvents(command: DesktopHostCommand, origin: string, partition: HostPartition, emit: (relay: DesktopHostRelay) => Promise<void>, signal?: AbortSignal): Promise<void> {
    const path = safePath(command.params.path);
    if (!path) { await emit({ id: command.id, error: "route_denied", end: true }); return; }
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    jobs.set(command.id, { hostKey: command.hostKey, epoch: command.epoch, abort: stop });
    try {
      const response = await partition.fetch(`${origin}${path}`, {
        method: "GET", redirect: "error", headers: { Accept: "text/event-stream", Origin: origin }, signal: controller.signal,
      });
      if (!response.ok || !response.body) { await emit({ id: command.id, error: "remote_host_unavailable", status: response.status, end: true }); return; }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (!controller.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        while (pending.length >= FRAME_CHARS) {
          const slice = pending.slice(0, FRAME_CHARS);
          pending = pending.slice(FRAME_CHARS);
          await emit({ id: command.id, text: slice });
        }
        if (pending.includes("\n\n")) {
          const end = pending.lastIndexOf("\n\n") + 2;
          await emit({ id: command.id, text: pending.slice(0, end) });
          pending = pending.slice(end);
        }
      }
      if (pending.length > 0 && !controller.signal.aborted) await emit({ id: command.id, text: pending });
      await emit({ id: command.id, end: true });
    } catch {
      await emit({ id: command.id, error: controller.signal.aborted ? "remote_host_unavailable" : "remote_host_unreachable", end: true });
    } finally {
      jobs.delete(command.id);
    }
  }

  async function streamSocket(command: DesktopHostCommand, origin: string, partition: HostPartition, emit: (relay: DesktopHostRelay) => Promise<void>, signal?: AbortSignal): Promise<void> {
    const channel = command.params.channel === "chat" || command.params.terminal === true || command.params.channel === "terminal" ? command.params.channel : null;
    const operationId = typeof command.params.operationId === "string" ? command.params.operationId : null;
    if ((channel !== "chat" && channel !== "terminal") || !operationId) { await emit({ id: command.id, error: "invalid_host_request", end: true }); return; }
    const ticketResponse = await partition.fetch(`${origin}${TICKET_PATH}`, {
      method: "POST", redirect: "error", headers: { "content-type": "application/json", Origin: origin },
      body: JSON.stringify(channel === "chat" ? { operationId, channel: "chat" } : { operationId }),
    });
    let ticket = "";
    try {
      const payload = await ticketResponse.json() as { readonly ticket?: unknown };
      ticket = ticketResponse.ok && typeof payload.ticket === "string" ? payload.ticket : "";
    } catch { ticket = ""; }
    if (!ticket) { await emit({ id: command.id, error: ticketResponse.status === 403 ? "not_controller" : "remote_host_unavailable", end: true }); return; }
    const cookie = (await partition.readCookies(origin)).map((entry) => `${entry.name}=${entry.value}`).join("; ");
    const controller = new AbortController();
    let chain = Promise.resolve();
    // 핀된 원격이 프레임을 쏟아도 릴레이 대기열이 메모리를 먹지 않게 한다. 넘치면 소켓을 닫는다.
    const maxRelayChars = 1024 * 1024;
    let relayChars = 0;
    let socket: PinnedSocket | null = null;
    const stop = () => { controller.abort(); socket?.close(); };
    const enqueue = (relay: DesktopHostRelay): Promise<void> => {
      const size = (relay.text?.length ?? 0) + (relay.dataBase64?.length ?? 0);
      if (size > 0 && relayChars + size > maxRelayChars) { stop(); return chain; }
      relayChars += size;
      chain = chain.then(() => emit(relay)).then(() => { relayChars -= size; }, () => { relayChars -= size; });
      return chain;
    };
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    jobs.set(command.id, {
      hostKey: command.hostKey, epoch: command.epoch,
      abort: stop,
      send: (payload) => {
        if (!socket) return;
        if (payload.text !== undefined) socket.sendText(payload.text);
        else if (payload.dataBase64 !== undefined) socket.sendBytes(Buffer.from(payload.dataBase64, "base64"));
      },
    });
    try {
      socket = await (deps.openSocket ?? openPinnedWebSocket)({
        hostname: command.target.hostname, port: command.target.port, fingerprint: command.target.fingerprint,
        path: `${TERMINAL_SOCKET_PATH}?ticket=${encodeURIComponent(ticket)}`, cookie, signal: controller.signal,
        onText: (text) => enqueue({ id: command.id, text }),
        onBytes: (bytes) => enqueue({ id: command.id, dataBase64: bytes.toString("base64") }),
      });
      await enqueue({ id: command.id, ready: true });
      await socket.closed;
      await chain; await enqueue({ id: command.id, end: true });
    } catch (error) {
      const code = error instanceof Error && error.message === "remote_host_fingerprint_mismatch" ? "remote_host_fingerprint_mismatch" : "remote_host_unavailable";
      await emit({ id: command.id, error: code, end: true });
    } finally {
      jobs.delete(command.id);
    }
  }
}

function safePath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("://") || value.includes("\\")) return null;
  return value;
}

function isSessionCapability(value: unknown): value is { capability: "host-session"; mode: "off" | "observer" | "controller"; access: "full" | "monitoring" | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (body.capability !== "host-session") return false;
  if (body.mode !== "off" && body.mode !== "observer" && body.mode !== "controller") return false;
  if (body.access !== null && body.access !== "full" && body.access !== "monitoring") return false;
  if (body.mode === "controller" && body.access !== "full") return false;
  if (body.mode === "off" && body.access !== null) return false;
  return true;
}

function safeByteType(value: string): string {
  const [rawType, ...params] = value.split(";").map((part) => part.trim().toLowerCase());
  const type = rawType ?? "";
  if (type === "image/png" || type === "image/jpeg" || type === "image/gif" || type === "image/webp") return type;
  // 증거 텍스트는 charset까지 제품이 보낸 그대로다. 그 외 매개변수나 PDF는 닫힌 타입으로 접지 않는다.
  if (type === "text/plain") return params.some((part) => part.replace(/\s+/gu, "") === "charset=utf-8") ? "text/plain; charset=utf-8" : "text/plain";
  return "application/octet-stream";
}

export function createDesktopHostTransport(deps: HostTransportExecutorDeps & { readonly fetch: typeof fetch; readonly log?: (message: string) => void }): { start(origin: string): Promise<void>; stop(): void } {
  const executor = createHostTransportExecutor(deps);
  const running = new Set<number>();
  const streams = new Map<number, AbortController>();
  const calls = new Map<number, AbortController>();
  let activeOrigin: string | null = null;
  // 같은 출처로 콘솔이 다시 떠도 instanceId가 같으면 살아 있는 스트림을 끊지 않는다. 달라질 때만 앞 프로세스의 번호와 epoch를 잊는다.
  let consoleInstance: string | null = null;
  const postRelay = async (relay: DesktopHostRelay, owner: string): Promise<boolean> => {
    const origin = activeOrigin;
    if (!origin || owner !== consoleInstance) return false;
    // 이미 끝난 원격 호출을 다시 실행하지 않는다. 거절된 결과만 몇 번 더 전달한다.
    for (let attempt = 0; attempt < RELAY_ATTEMPTS; attempt += 1) {
      if (activeOrigin !== origin || owner !== consoleInstance) return false;
      try {
        const response = await deps.fetch(`${origin}${DESKTOP_HOST_TRANSPORT_RELAY_PATH}`, {
          method: "POST", headers: { "content-type": "application/json", Origin: origin }, body: JSON.stringify(relay),
        });
        if (response.ok) return true;
        if (owner === consoleInstance) deps.log?.(`host transport relay rejected status=${response.status}`);
      } catch (error) {
        if (owner === consoleInstance) deps.log?.(`host transport relay failed: ${error instanceof Error ? error.message : "unknown"}`);
      }
      if (attempt + 1 < RELAY_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RELAY_BACKOFF_MS[attempt] ?? 400));
    }
    if (owner === consoleInstance) deps.log?.(`host transport relay dropped id=${relay.id}`);
    return false;
  };
  const stream = createDesktopEventStream({
    snapshotPath: DESKTOP_HOST_TRANSPORT_PATH,
    eventsPath: DESKTOP_HOST_TRANSPORT_EVENTS_PATH,
    eventName: DESKTOP_HOST_TRANSPORT_EVENT,
    parseSnapshot: (value) => isDesktopHostSnapshot(value) ? value : null,
    maxFrameChars: 2_000_000,
    normalizeOrigin: (origin) => new URL(origin).origin,
    fetch: deps.fetch,
    apply: (snapshot) => {
      if (snapshot.instanceId !== consoleInstance) {
        const replacing = consoleInstance !== null;
        consoleInstance = snapshot.instanceId;
        if (replacing) {
          running.clear();
          for (const controller of streams.values()) controller.abort();
          for (const controller of calls.values()) controller.abort();
          streams.clear();
          calls.clear();
          executor.releaseConsole();
        }
      }
      const owner = consoleInstance ?? snapshot.instanceId;
      const live = new Set(snapshot.commands.map((command) => command.id));
      for (const [id, controller] of streams) if (!live.has(id)) controller.abort();
      for (const [id, controller] of calls) if (!live.has(id)) controller.abort();
      for (const id of running) if (!live.has(id)) running.delete(id);
      for (const command of snapshot.commands) {
        if (running.has(command.id)) continue;
        running.add(command.id);
        const streaming = command.op === "sse" || command.op === "ws-open";
        const controller = new AbortController();
        (streaming ? streams : calls).set(command.id, controller);
        const deliver = async (relay: DesktopHostRelay): Promise<void> => {
          if (owner !== consoleInstance) return;
          if (streaming && controller.signal.aborted && relay.end !== true && relay.error === undefined) return;
          const accepted = await postRelay(relay, owner);
          if (!accepted && owner === consoleInstance) controller.abort();
        };
        const done = streaming
          ? executor.run(command, deliver, controller.signal)
          : executor.execute(command, controller.signal).then((relay) => deliver(relay));
        void done.catch((error: unknown) => {
          deps.log?.(`host transport failed: ${error instanceof Error ? error.message : "unknown"}`);
          return postRelay({ id: command.id, error: "remote_host_unavailable", end: true }, owner);
        }).finally(() => {
          const map = streaming ? streams : calls;
          if (map.get(command.id) === controller) map.delete(command.id);
        });
      }
    },
  });
  return {
    start(origin) { activeOrigin = new URL(origin).origin; return stream.start(activeOrigin); },
    stop() {
      activeOrigin = null;
      running.clear();
      for (const controller of streams.values()) controller.abort();
      for (const controller of calls.values()) controller.abort();
      streams.clear();
      calls.clear();
      executor.releaseConsole();
      stream.stop();
    },
  };
}
