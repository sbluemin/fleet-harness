import crypto from "node:crypto";
import type http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";

import type { DesktopHostRelay } from "@fleet-console/protocol/desktop";
import {
  HOST_ERROR_STATUS,
  isHostByteRequest,
  isHostJsonRequest,
  isHostUploadRequest,
  isHostPairRequest,
  isHostPresenceRequest,
  isRemoteHostKey,
  parseHostSocketQuery,
  parseHostStreamQuery,
  type HostAccess,
  type HostCapability,
  type HostConnection,
  type HostMode,
  type HostPresence,
  type HostTransportError,
  type HostTransportKind,
} from "@fleet-console/protocol/remote/host-transport";

import { admitHostRoute } from "./host-route-table.js";

/**
 * 페이지의 same-origin GET·EventSource·이미지는 Origin을 빼는 경우가 있다.
 * Origin이 있으면 이 리스너와 같아야 하고, `null`이나 다른 출처는 거절한다.
 * Origin이 없을 때는 Fetch Metadata가 same-origin이거나 사용자가 연 탐색(none)일 때만 읽기를 연다.
 * cross-site는 거절한다. POST와 WebSocket은 Origin이 정확히 같을 때만 통과한다.
 * 이 판정은 인증이 아니다. Host 일치와 루프백 리스너는 서버가 따로 본다.
 */
export function admitHostPageOrigin(req: http.IncomingMessage, expectedOrigin: string): boolean {
  const origin = singleHeader(req.headers.origin);
  if (origin === expectedOrigin) return true;
  if (origin !== undefined) return false;
  if ((req.method ?? "GET").toUpperCase() !== "GET") return false;
  if (String(req.headers.upgrade ?? "").toLowerCase() === "websocket") return false;
  const site = singleHeader(req.headers["sec-fetch-site"]);
  return site === "same-origin" || site === "none";
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.length === 1 ? value[0] : "\u0000";
  return value.includes(",") ? "\u0000" : value;
}

export interface HostShellPort {
  call(request: {
    readonly hostKey: string;
    readonly epoch: number;
    readonly op: "presence" | "pair" | "http" | "bytes" | "sse" | "ws-open" | "ws-send" | "ws-close" | "abort";
    readonly routeId: string;
    readonly target: { readonly hostname: string; readonly port: number; readonly fingerprint: string };
    readonly params: Readonly<Record<string, unknown>>;
  }, signal?: AbortSignal): Promise<DesktopHostRelay>;
  open(request: {
    readonly hostKey: string;
    readonly epoch: number;
    readonly op: "sse" | "ws-open";
    readonly routeId: string;
    readonly target: { readonly hostname: string; readonly port: number; readonly fingerprint: string };
    readonly params: Readonly<Record<string, unknown>>;
  }, onFrame: (relay: DesktopHostRelay) => Promise<void> | void, signal?: AbortSignal): Promise<DesktopHostRelay>;
}

export interface HostGatewayTarget {
  readonly hostname: string;
  readonly port: number;
  readonly fingerprint: string;
  readonly origin: string;
}

export interface HostGatewayDeps {
  readonly isLoopback: (req: http.IncomingMessage) => boolean;
  readonly isExactOrigin: (req: http.IncomingMessage) => boolean;
  readonly findHost: (hostKey: string) => HostGatewayTarget | null;
  readonly bridge: HostShellPort;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  readonly withSecurityHeaders: (extra: http.OutgoingHttpHeaders) => http.OutgoingHttpHeaders;
}

interface HostLink {
  epoch: number;
  origin: string;
  fingerprint: string;
  mode: HostMode;
  access: HostAccess | null;
  connection: HostConnection;
  capability: HostCapability;
}

const KINDS = new Set<HostTransportKind>(["presence", "pair", "presenceEvents", "request", "bytes", "events", "resources", "socket"]);

export interface HostGateway {
  handle(context: { readonly req: http.IncomingMessage; readonly res: http.ServerResponse; readonly pathname: string }): Promise<boolean>;
  upgrade(context: { readonly req: http.IncomingMessage; readonly socket: Duplex; readonly head: Buffer; readonly pathname: string }): boolean;
}

export function createHostGateway(deps: HostGatewayDeps): HostGateway {
  // Desktop bridge의 instanceId와 다른 값이다. 이 gateway가 살아있는 동안만 유지된다.
  const gatewayInstanceId = crypto.randomUUID();
  const links = new Map<string, HostLink>();
  const listeners = new Map<string, Set<http.ServerResponse>>();
  const live = new Set<{ readonly hostKey: string; abort(): void }>();
  const retire = (hostKey: string): void => { for (const channel of [...live]) if (channel.hostKey === hostKey) channel.abort(); };

  const linkFor = (hostKey: string, target: HostGatewayTarget): HostLink => {
    const current = links.get(hostKey);
    if (!current) {
      const created: HostLink = { epoch: 1, origin: target.origin, fingerprint: target.fingerprint, mode: "off", access: null, connection: "closed", capability: "supported" };
      links.set(hostKey, created);
      return created;
    }
    if (current.origin !== target.origin || current.fingerprint !== target.fingerprint) {
      current.epoch += 1;
      current.origin = target.origin;
      current.fingerprint = target.fingerprint;
      current.mode = "off";
      current.access = null;
      current.connection = "blocked";
      current.capability = "supported";
      publish(hostKey);
    }
    return current;
  };

  const presenceOf = (hostKey: string, link: HostLink): HostPresence => ({
    hostKey, epoch: link.epoch, instanceId: gatewayInstanceId, mode: link.mode, access: link.access, connection: link.connection, capability: link.capability,
  });

  const publish = (hostKey: string): void => {
    const link = links.get(hostKey);
    const group = listeners.get(hostKey);
    if (!link || !group) return;
    const frame = `event: host-presence\ndata: ${JSON.stringify(presenceOf(hostKey, link))}\n\n`;
    for (const res of group) if (!res.destroyed) res.write(frame);
  };

  // 공개 오류 본문 계약: `stale_epoch`만 현재 세대를 함께 싣고, 나머지는 정확히 `{ error }`다. 브라우저 validator가 그 밖의 형태를
  // 거절하므로(예: 첫 observe의 not_paired), 호출 지점이 epoch를 넘겨도 여기서 한 번에 거른다 — 모든 오류 경로가 이 함수를 지난다.
  const fail = (res: http.ServerResponse, error: HostTransportError, epoch?: number): void => {
    deps.writeJson(res, HOST_ERROR_STATUS[error], error === "stale_epoch" && epoch !== undefined ? { error, epoch } : { error });
  };

  const handle = async ({ req, res, pathname }: { readonly req: http.IncomingMessage; readonly res: http.ServerResponse; readonly pathname: string }): Promise<boolean> => {
    const match = pathname.match(/^\/api\/v1\/hosts\/([^/]+)\/([^/]+)$/u);
    if (!match) return false;
    const abort = new AbortController();
    // 요청 본문이 끝나면 Node는 req 'close'를 쏜다. 그때 끊으면 아직 응답을 기다리는 호출이 취소된다.
    // 클라이언트가 실제로 떠난 경우만 — 응답이 끝나기 전의 close — 취소한다.
    res.on("close", () => { if (!res.writableEnded) abort.abort(); });
    if (!deps.isLoopback(req)) { deps.writeJson(res, 404, { error: "not_found" }); return true; }
    if (!deps.isExactOrigin(req)) { fail(res, "invalid_host_request"); return true; }
    const hostKey = decodeURIComponent(match[1] ?? "");
    const kind = match[2] as HostTransportKind;
    if (!isRemoteHostKey(hostKey) || !KINDS.has(kind)) { fail(res, "remote_host_unknown"); return true; }
    const target = deps.findHost(hostKey);
    if (!target) { fail(res, "remote_host_unknown"); return true; }
    const link = linkFor(hostKey, target);
    if (kind === "presence" && req.method === "GET") { deps.writeJson(res, 200, presenceOf(hostKey, link)); return true; }
    if (kind === "presenceEvents" && req.method === "GET") return writePresenceEvents(hostKey, link);
    if (kind === "presence" && req.method === "POST") return handlePresence(hostKey, target, link);
    if (kind === "pair") {
      if (req.method !== "POST") { fail(res, "invalid_host_request"); return true; }
      return handlePair(hostKey, target, link);
    }
    if (kind === "request" && req.method === "POST") return handleJson(hostKey, target, link);
    if (kind === "bytes" && req.method === "POST") return handleBytes(hostKey, target, link);
    if ((kind === "events" || kind === "resources") && req.method === "GET") return handleStream(hostKey, target, link, kind);
    if (kind === "socket" && (req.method === "GET" || String(req.headers.upgrade ?? "").toLowerCase() === "websocket")) return handleSocket();
    if (link.capability === "unsupported" || link.mode === "off") { fail(res, "host_inactive", link.epoch); return true; }
    fail(res, "invalid_host_request");
    return true;

    function writePresenceEvents(hostKey: string, link: HostLink): boolean {
      res.writeHead(200, deps.withSecurityHeaders({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }));
      const group = listeners.get(hostKey) ?? new Set<http.ServerResponse>();
      group.add(res);
      listeners.set(hostKey, group);
      res.write(`event: host-presence\ndata: ${JSON.stringify(presenceOf(hostKey, link))}\n\n`);
      res.on("close", () => group.delete(res));
      return true;
    }

    async function handlePresence(hostKey: string, target: HostGatewayTarget, link: HostLink): Promise<boolean> {
      const body = await deps.readJsonBody(req);
      if (!isHostPresenceRequest(body)) { fail(res, "invalid_host_request"); return true; }
      if (body.expectedInstanceId !== gatewayInstanceId) { fail(res, "stale_instance"); return true; }
      if (body.expectedEpoch !== link.epoch) { fail(res, "stale_epoch", link.epoch); return true; }
      const relay = await deps.bridge.call({
        hostKey, epoch: link.epoch, op: "presence", routeId: "presence",
        target: { hostname: target.hostname, port: target.port, fingerprint: target.fingerprint },
        params: { intent: body.intent },
      }, abort.signal);
      retire(hostKey); applyPresence(link, relay);
      publish(hostKey);
      if (relay.error) { fail(res, asError(relay.error), link.epoch); return true; }
      res.writeHead(204, deps.withSecurityHeaders({}));
      res.end();
      return true;
    }

    async function handlePair(hostKey: string, target: HostGatewayTarget, link: HostLink): Promise<boolean> {
      const body = await deps.readJsonBody(req);
      if (!isHostPairRequest(body)) { fail(res, "invalid_host_request"); return true; }
      if (body.expectedInstanceId !== gatewayInstanceId) { fail(res, "stale_instance"); return true; }
      if (body.expectedEpoch !== link.epoch) { fail(res, "stale_epoch", link.epoch); return true; }
      const relay = await deps.bridge.call({
        hostKey, epoch: link.epoch, op: "pair", routeId: "pair",
        target: { hostname: target.hostname, port: target.port, fingerprint: target.fingerprint },
        params: {},
      }, abort.signal);
      const current = deps.findHost(hostKey);
      if (!current) { fail(res, "remote_host_unknown"); return true; }
      if (current.origin !== target.origin || current.hostname !== target.hostname || current.port !== target.port || current.fingerprint !== target.fingerprint) {
        const refreshed = linkFor(hostKey, current);
        fail(res, "stale_epoch", refreshed.epoch);
        return true;
      }
      if (relay.error === "stale_epoch") { fail(res, "stale_epoch", link.epoch); return true; }
      if (relay.error || relay.capability === "unsupported") { fail(res, asError(relay.error ?? "host_unsupported")); return true; }
      // pair는 관찰로 이어지기 전의 쿠키다. 제어·관찰 모드가 오면 성공으로 받지 않는다.
      if (relay.mode !== "off" || relay.access != null) { fail(res, "remote_host_unavailable"); return true; }
      res.writeHead(204, deps.withSecurityHeaders({}));
      res.end();
      return true;
    }

    async function handleJson(hostKey: string, target: HostGatewayTarget, link: HostLink): Promise<boolean> {
      const body = await deps.readJsonBody(req);
      if (!isHostJsonRequest(body)) { fail(res, "invalid_host_request"); return true; }
      if (body.expectedInstanceId !== gatewayInstanceId) { fail(res, "stale_instance"); return true; }
      if (link.capability === "unsupported" || link.mode === "off") { fail(res, "host_inactive", link.epoch); return true; }
      if (body.expectedEpoch !== link.epoch) { fail(res, "stale_epoch", link.epoch); return true; }
      const admitted = admitHostRoute({ kind: "json", method: body.method, path: body.path, mode: link.mode === "controller" ? "controller" : "observer" });
      if ("error" in admitted) { fail(res, admitted.error); return true; }
      const relay = await deps.bridge.call({
        hostKey, epoch: link.epoch, op: "http", routeId: admitted.id,
        target: { hostname: target.hostname, port: target.port, fingerprint: target.fingerprint },
        params: { method: admitted.method, path: admitted.path, ...(Object.prototype.hasOwnProperty.call(body, "json") ? { json: body.json } : {}) },
      }, abort.signal);
      if (relay.error) { fail(res, asError(relay.error), link.epoch); return true; }
      const status = relay.status ?? 502;
      const empty = status === 204 || status === 205 || status === 304 || relay.contentType === null;
      deps.writeJson(res, 200, empty
        ? { requestId: body.requestId, epoch: link.epoch, instanceId: gatewayInstanceId, status, contentType: null }
        : { requestId: body.requestId, epoch: link.epoch, instanceId: gatewayInstanceId, status, contentType: "application/json", json: relay.json ?? null });
      return true;
    }

    async function handleBytes(hostKey: string, target: HostGatewayTarget, link: HostLink): Promise<boolean> {
      const body = await deps.readJsonBody(req);
      if (isHostUploadRequest(body)) return relayUpload(hostKey, target, link, body);
      if (!isHostByteRequest(body)) { fail(res, "invalid_host_request"); return true; }
      if (body.expectedInstanceId !== gatewayInstanceId) { fail(res, "stale_instance"); return true; }
      if (link.capability === "unsupported" || link.mode === "off") { fail(res, "host_inactive", link.epoch); return true; }
      if (body.expectedEpoch !== link.epoch) { fail(res, "stale_epoch", link.epoch); return true; }
      const admitted = admitHostRoute({ kind: "bytes", method: "POST", path: body.path, mode: link.mode === "controller" ? "controller" : "observer" });
      if ("error" in admitted) { fail(res, admitted.error); return true; }
      const relay = await deps.bridge.call({
        hostKey, epoch: link.epoch, op: "bytes", routeId: admitted.id,
        target: { hostname: target.hostname, port: target.port, fingerprint: target.fingerprint },
        params: { method: "POST", path: admitted.path },
      }, abort.signal);
      if (relay.error || relay.dataBase64 === undefined || typeof relay.contentType !== "string") { fail(res, asError(relay.error ?? "remote_host_unavailable"), link.epoch); return true; }
      deps.writeJson(res, 200, { requestId: body.requestId, epoch: link.epoch, instanceId: gatewayInstanceId, status: relay.status ?? 200, contentType: relay.contentType, dataBase64: relay.dataBase64 });
      return true;
    }

    async function relayUpload(hostKey: string, target: HostGatewayTarget, link: HostLink, body: { readonly requestId: string; readonly expectedEpoch: number; readonly expectedInstanceId: string; readonly path: string; readonly dataBase64: string }): Promise<boolean> {
      if (body.expectedInstanceId !== gatewayInstanceId) { fail(res, "stale_instance"); return true; }
      if (link.capability === "unsupported" || link.mode === "off") { fail(res, "host_inactive", link.epoch); return true; }
      if (body.expectedEpoch !== link.epoch) { fail(res, "stale_epoch", link.epoch); return true; }
      const admitted = admitHostRoute({ kind: "upload", method: "POST", path: body.path, mode: link.mode === "controller" ? "controller" : "observer" });
      if ("error" in admitted) { fail(res, admitted.error); return true; }
      const relay = await deps.bridge.call({
        hostKey, epoch: link.epoch, op: "http", routeId: admitted.id,
        target: { hostname: target.hostname, port: target.port, fingerprint: target.fingerprint },
        params: { method: "POST", path: admitted.path, dataBase64: body.dataBase64 },
      }, abort.signal);
      if (relay.error) { fail(res, asError(relay.error), link.epoch); return true; }
      const status = relay.status ?? 502;
      deps.writeJson(res, 200, relay.contentType === null
        ? { requestId: body.requestId, epoch: link.epoch, instanceId: gatewayInstanceId, status, contentType: null }
        : { requestId: body.requestId, epoch: link.epoch, instanceId: gatewayInstanceId, status, contentType: "application/json", json: relay.json ?? null });
      return true;
    }

    async function handleStream(hostKey: string, target: HostGatewayTarget, link: HostLink, kind: "events" | "resources"): Promise<boolean> {
      const query = parseHostStreamQuery(new URL(req.url ?? "/", "http://127.0.0.1").searchParams);
      if (!query) { fail(res, "invalid_host_request"); return true; }
      if (query.instanceId !== gatewayInstanceId) { fail(res, "stale_instance"); return true; }
      if (link.capability === "unsupported" || link.mode === "off") { fail(res, "host_inactive", link.epoch); return true; }
      if (query.epoch !== link.epoch) { fail(res, "stale_epoch", link.epoch); return true; }
      const admitted = admitHostRoute({ kind, method: "GET", path: query.path, mode: link.mode === "controller" ? "controller" : "observer" });
      if ("error" in admitted) { fail(res, admitted.error); return true; }
      if (kind === "resources") {
        const relay = await deps.bridge.call({
          hostKey, epoch: link.epoch, op: "bytes", routeId: admitted.id,
          target: { hostname: target.hostname, port: target.port, fingerprint: target.fingerprint },
          params: { method: "GET", path: admitted.path },
        }, abort.signal);
        if (relay.error || relay.dataBase64 === undefined || typeof relay.contentType !== "string") { fail(res, asError(relay.error ?? "remote_host_unavailable"), link.epoch); return true; }
        const bytes = Buffer.from(relay.dataBase64, "base64");
        res.writeHead(relay.status ?? 200, deps.withSecurityHeaders({ "Content-Type": relay.contentType, "Content-Length": String(bytes.length), "Cache-Control": "private, no-store" }));
        res.end(bytes);
        return true;
      }
      return streamEvents(hostKey, target, link, admitted.id, admitted.path);
    }

    async function streamEvents(hostKey: string, target: HostGatewayTarget, link: HostLink, routeId: string, path: string): Promise<boolean> {
      const epoch = link.epoch;
      const controller = new AbortController();
      const channel = { hostKey, abort: () => controller.abort() };
      live.add(channel);
      res.on("close", () => { if (!res.writableEnded) controller.abort(); });
      res.writeHead(200, deps.withSecurityHeaders({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }));
      const relay = await deps.bridge.open({
        hostKey, epoch, op: "sse", routeId,
        target: { hostname: target.hostname, port: target.port, fingerprint: target.fingerprint },
        params: { path },
      }, async (frame) => {
        if (link.epoch !== epoch) { controller.abort(); return; }
        if (frame.text !== undefined && !res.destroyed) {
          if (!res.write(frame.text)) await new Promise<void>((done) => res.once("drain", () => done()));
        }
      }, controller.signal);
      live.delete(channel);
      if (!res.writableEnded) res.end();
      void relay;
      return true;
    }

    function handleSocket(): boolean {
      fail(res, "invalid_host_request");
      return true;
    }
  };

  const upgrade = (context: { readonly req: http.IncomingMessage; readonly socket: Duplex; readonly head: Buffer; readonly pathname: string }): boolean => {
    const match = context.pathname.match(/^\/api\/v1\/hosts\/([^/]+)\/socket$/u);
    if (!match) return false;
    const reject = (status: number, error: string): void => {
      const body = JSON.stringify({ error });
      context.socket.write(`HTTP/1.1 ${status} ${error}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      context.socket.destroy();
    };
    if (!deps.isLoopback(context.req) || !deps.isExactOrigin(context.req)) { reject(404, "not_found"); return true; }
    const hostKey = decodeURIComponent(match[1] ?? "");
    const target = isRemoteHostKey(hostKey) ? deps.findHost(hostKey) : null;
    if (!target) { reject(404, "remote_host_unknown"); return true; }
    const link = linkFor(hostKey, target);
    const query = parseHostSocketQuery(new URL(context.req.url ?? "/", "http://127.0.0.1").searchParams);
    if (!query) { reject(400, "invalid_host_request"); return true; }
    if (query.instanceId !== gatewayInstanceId) { reject(409, "stale_instance"); return true; }
    if (link.mode !== "controller" || query.epoch !== link.epoch) {
      reject(403, link.mode !== "controller" ? "not_controller" : "stale_epoch");
      return true;
    }
    const sockets = new WebSocketServer({ noServer: true });
    sockets.handleUpgrade(context.req, context.socket, context.head, (ws) => { void bindSocket(hostKey, target, link, query.channel, query.operationId, ws); });
    return true;
  };

  return { handle, upgrade };

  async function bindSocket(hostKey: string, target: HostGatewayTarget, link: HostLink, channel: "chat" | "terminal", operationId: string, ws: WebSocket): Promise<void> {
    const epoch = link.epoch;
    const controller = new AbortController();
    const entry = { hostKey, abort: () => controller.abort() };
    live.add(entry);
    // 원격 ready 이전의 resize·flow와 붙여넣기 폭주는 깊이로 끊지 않는다. 바이트가 상한을 넘을 때만 닫는다.
    const softBytes = 256 * 1024;
    const hardBytes = 1024 * 1024;
    let socketId = 0;
    let ready = false;
    let chain: Promise<void> = Promise.resolve();
    let queuedBytes = 0;
    let depthBytes = 0;
    const queued: { readonly text?: string; readonly dataBase64?: string; readonly bytes: number }[] = [];
    const targetWire = { hostname: target.hostname, port: target.port, fingerprint: target.fingerprint };
    const flush = (): void => {
      if (!ready || socketId === 0) return;
      while (queued.length > 0 && depthBytes < softBytes) {
        const next = queued.shift();
        if (!next) break;
        queuedBytes -= next.bytes;
        depthBytes += next.bytes;
        const payload = next.text !== undefined ? { text: next.text } : { dataBase64: next.dataBase64 };
        chain = chain.then(() => deps.bridge.call({
          hostKey, epoch, op: "ws-send", routeId: "terminal-ws", target: targetWire,
          params: { socketId, ...payload },
        }).then(() => undefined, () => undefined)).finally(() => { depthBytes -= next.bytes; flush(); });
      }
      if (queuedBytes + depthBytes < softBytes) ws.resume();
    };
    ws.on("close", () => {
      controller.abort();
      if (socketId === 0) return;
      void deps.bridge.call({ hostKey, epoch, op: "ws-close", routeId: "terminal-ws", target: targetWire, params: { socketId } });
    });
    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      const payload = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      const bytes = payload.length;
      if (queuedBytes + depthBytes + bytes > hardBytes) { ws.close(); return; }
      queued.push(isBinary ? { dataBase64: payload.toString("base64"), bytes } : { text: payload.toString("utf8"), bytes });
      queuedBytes += bytes;
      if (queuedBytes + depthBytes >= softBytes) ws.pause();
      flush();
    });
    await deps.bridge.open({
      hostKey, epoch, op: "ws-open", routeId: "terminal-ws", target: targetWire,
      params: { channel, operationId },
    }, async (frame) => {
      socketId = frame.id;
      if (link.epoch !== epoch) { controller.abort(); return; }
      if (frame.ready === true) { ready = true; flush(); return; }
      if (frame.text !== undefined) ws.send(frame.text);
      else if (frame.dataBase64 !== undefined) ws.send(Buffer.from(frame.dataBase64, "base64"));
    }, controller.signal);
    live.delete(entry);
    ws.close();
  }
}

function applyPresence(link: HostLink, relay: DesktopHostRelay): void {
  if (relay.capability === "unsupported" || relay.error === "host_unsupported") {
    link.capability = "unsupported";
    link.mode = "off";
    link.access = null;
    link.connection = "blocked";
    link.epoch += 1;
    return;
  }
  if (relay.error) {
    link.connection = relay.error === "remote_host_fingerprint_mismatch" ? "blocked" : "closed";
    return;
  }
  const mode = relay.mode === "observer" || relay.mode === "controller" || relay.mode === "off" ? relay.mode : "off";
  const access = relay.access === "full" || relay.access === "monitoring" ? relay.access : null;
  if (mode === "controller" && access !== "full") {
    link.capability = "unsupported";
    link.mode = "off";
    link.access = null;
    link.connection = "blocked";
    link.epoch += 1;
    return;
  }
  link.capability = "supported";
  link.mode = mode;
  link.access = mode === "off" ? null : access;
  link.connection = mode === "off" ? "closed" : "ready";
  link.epoch += 1;
}

function asError(value: string): HostTransportError {
  return value in HOST_ERROR_STATUS ? value as HostTransportError : "remote_host_unavailable";
}
