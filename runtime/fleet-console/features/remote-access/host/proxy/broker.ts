import crypto from "node:crypto";
import http from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

import {
  DESKTOP_PROXY_BODY_LIMIT_BYTES,
  DESKTOP_PROXY_EPOCHS_PATH,
  DESKTOP_PROXY_EPOCH_STATE_EVENT,
  DESKTOP_PROXY_EVENTS_PATH,
  DESKTOP_PROXY_HEARTBEAT_MS,
  DESKTOP_PROXY_LEASE_MS,
  DESKTOP_PROXY_OWNERS_PATH,
  isDesktopProxyDelegation,
  isDesktopProxyId,
  type DesktopProxyDelegation,
  type DesktopProxyEpochState,
  type DesktopProxyEpochStateEvent,
  type DesktopProxyTerminalReason,
} from "@fleet-console/protocol/desktop";

import { sessionCookieName } from "../auth.js";
import type { RemoteHostRecord, RemoteHostStore } from "../remote-hosts.js";
import { pinnedRequest, PinRejectedError, readBounded, type PinnedTarget } from "./pinned-transport.js";
import { resolveEpochRoute, type EpochRoute } from "./route-allowlist.js";
import { createSseParser, encodeSseEvent } from "./sse-filter.js";

/**
 * 읽기 전용 원격 데이터 epoch의 broker.
 *
 * Desktop이 조인해 얻은 원격 **monitoring 세션 쿠키 하나**를 메모리에 받아, epoch마다 따로 연 루프백 리스너에서
 * 로컬 번들과 허용목록 읽기만 원격으로 잇는다. broker는 조인하지 않고 pairing을 받지 않으며, epoch 리스너에는
 * 메인 라우트 테이블도 로컬 control-plane 폴백도 없다.
 *
 * 끝낼 때의 순서는 계약이다: admission 폐기 → 진행 중 요청·스트림 abort → 리스너와 accept한 소켓 파기 →
 * (최종 떠남일 때만) 같은 세션으로 원격 leave 한 번 → 세션 폐기.
 */

export interface ProxyPresentation {
  readonly theme: "instrument" | "maritime" | "carbon" | "whites";
  readonly liquidGlass: boolean;
  readonly unfocusedPanelFade: number;
  readonly uiFont: { readonly source: "builtin"; readonly id: string; readonly size: number } | { readonly source: "system"; readonly familyName: string; readonly size: number };
  readonly language: "auto" | "en" | "ko";
}

export interface ProxyBrokerDeps {
  readonly remoteHostStore: Pick<RemoteHostStore, "find">;
  readonly isLockAuthorized: (req: http.IncomingMessage) => boolean;
  readonly localVersion: () => string;
  readonly presentation: () => ProxyPresentation;
  readonly readAsset: (relative: string, theme: ProxyPresentation["theme"], liquidGlass: boolean) => { readonly contentType: string; readonly body: Buffer | string; readonly immutable: boolean } | null;
  readonly log?: (entry: Readonly<Record<string, string | number | null>>) => void;
  /** 시험용 시계. 만료 판정은 벽시계가 아니라 단조 시계로 한다. */
  readonly monotonicNow?: () => number;
}

interface OwnerRecord {
  readonly id: string;
  expiresAt: number;
  latestSwitch: number;
  readonly issued: number[];
  readonly requests: Map<string, { readonly bodyHash: string; readonly epochId: string }>;
  readonly subscribers: Set<http.ServerResponse>;
}

interface EpochRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly generation: number;
  readonly host: RemoteHostRecord;
  readonly target: PinnedTarget;
  readonly controller: AbortController;
  state: DesktopProxyEpochState;
  reason: DesktopProxyTerminalReason | null;
  session: string | null;
  capabilityHash: Buffer | null;
  origin: string | null;
  cookieName: string;
  server: http.Server | null;
  readonly sockets: Set<Socket>;
  upstreams: number;
  streams: number;
  revalidate: ReturnType<typeof setInterval> | null;
}

const LIMITS = {
  activeEpochs: 4,
  issuesPerMinute: 6,
  upstreamPerEpoch: 16,
  streamsPerEpoch: 4,
  responseBytes: 8 * 1024 * 1024,
  statusBytes: 64 * 1024,
  revalidateMs: 60_000,
  leaveTimeoutMs: 3_000,
} as const;

const SESSION_VALUE = /^[A-Za-z0-9_-]{43}$/u;
const EPOCH_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";
const PROXY_SURFACE_META = '<meta name="fleet-surface" content="proxy-data">';
const BASE_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin" } as const;

export interface ProxyBroker {
  /** 메인 루프백 리스너의 `/api/v1/proxy/*`. 처리했으면 true. */
  handle(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, loopbackPort: number): boolean;
  shutdown(): void;
}

export function createProxyBroker(deps: ProxyBrokerDeps): ProxyBroker {
  const now = deps.monotonicNow ?? (() => performance.now());
  const owners = new Map<string, OwnerRecord>();
  const epochs = new Map<string, EpochRecord>();
  let generationSeq = 0;
  const sweep = setInterval(() => { for (const owner of [...owners.values()]) if (now() >= owner.expiresAt) expireOwner(owner, "owner_expired"); }, 1_000);
  sweep.unref();

  const log = (entry: Readonly<Record<string, string | number | null>>): void => { try { deps.log?.(entry); } catch { /* 로그 실패가 경로를 바꾸지 않는다. */ } };
  const newId = (): string => crypto.randomBytes(12).toString("base64url");
  const hash = (value: string): Buffer => crypto.createHash("sha256").update(value).digest();

  function liveOwner(id: string): OwnerRecord | null {
    const owner = owners.get(id);
    if (!owner) return null;
    // 타이머가 아직 돌지 않았어도 기한이 지났으면 만료다 — 이벤트 루프가 멎은 틈에 권한이 되살아나지 않는다.
    if (now() >= owner.expiresAt) { expireOwner(owner, "owner_expired"); return null; }
    return owner;
  }

  function expireOwner(owner: OwnerRecord, reason: DesktopProxyTerminalReason): void {
    owners.delete(owner.id);
    for (const epoch of epochs.values()) if (epoch.ownerId === owner.id) terminate(epoch, reason, false);
    for (const subscriber of owner.subscribers) subscriber.end();
    owner.subscribers.clear();
  }

  function publish(epoch: EpochRecord): void {
    const owner = owners.get(epoch.ownerId);
    if (!owner) return;
    const event: DesktopProxyEpochStateEvent = { epochId: epoch.id, generation: epoch.generation, state: epoch.state, ...(epoch.reason ? { reason: epoch.reason } : {}) };
    const frame = `event: ${DESKTOP_PROXY_EPOCH_STATE_EVENT}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const subscriber of owner.subscribers) subscriber.write(frame);
  }

  /** terminal 전이. 순서가 계약이다 — admission을 먼저 거두고, 그다음 흐름과 소켓, 마지막에 세션. */
  function terminate(epoch: EpochRecord, reason: DesktopProxyTerminalReason, leave: boolean): void {
    if (epoch.state === "terminal") return;
    epoch.state = "terminal";
    epoch.reason = reason;
    epoch.capabilityHash = null;
    epoch.controller.abort(new Error("epoch_terminal"));
    if (epoch.revalidate) clearInterval(epoch.revalidate);
    epoch.revalidate = null;
    epoch.server?.close();
    for (const socket of epoch.sockets) socket.destroy();
    epoch.sockets.clear();
    epoch.server = null;
    const session = epoch.session;
    epoch.session = null;
    if (leave && session) void leaveOnce(epoch, session);
    log({ event: "epoch_terminal", epochId: epoch.id, generation: epoch.generation, reason });
    publish(epoch);
    epochs.delete(epoch.id);
  }

  /** 최종 떠남에서만. 세션 비밀은 이 요청 하나에만 잠깐 실리고, 결과와 무관하게 여기서 끝난다. */
  async function leaveOnce(epoch: EpochRecord, session: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("leave_timeout")), LIMITS.leaveTimeoutMs);
    try {
      const response = await pinnedRequest(epoch.target, {
        method: "POST",
        path: "/api/v1/access/self/leave",
        headers: { cookie: `${sessionCookieName(epoch.host.port)}=${session}`, origin: epoch.host.origin, "content-length": "0" },
        signal: controller.signal,
        timeoutMs: LIMITS.leaveTimeoutMs,
      });
      response.resume();
      log({ event: "epoch_leave", epochId: epoch.id, status: response.statusCode ?? 0 });
    } catch {
      log({ event: "epoch_leave", epochId: epoch.id, status: null });
    } finally {
      clearTimeout(timer);
    }
  }

  function upstreamHeaders(epoch: EpochRecord, accept: string): http.OutgoingHttpHeaders {
    return { cookie: `${sessionCookieName(epoch.host.port)}=${epoch.session ?? ""}`, accept };
  }

  async function upstreamJson(epoch: EpochRecord, path: string, limit: number): Promise<{ status: number; body: unknown }> {
    const response = await pinnedRequest(epoch.target, { method: "GET", path, headers: upstreamHeaders(epoch, "application/json"), signal: epoch.controller.signal });
    const body = await readBounded(response, limit);
    const status = response.statusCode ?? 502;
    if (status === 401) terminate(epoch, "expired", false);
    if (!String(response.headers["content-type"] ?? "").startsWith("application/json")) return { status: 502, body: null };
    try { return { status, body: JSON.parse(body.toString("utf8")) as unknown }; } catch { return { status: 502, body: null }; }
  }

  /** broker 전용 control stream. 회수·인계·만료·단절을 여기서만 판정하고, 데이터 뷰의 신호는 믿지 않는다. */
  async function openControlStream(epoch: EpochRecord): Promise<void> {
    const response = await pinnedRequest(epoch.target, { method: "GET", path: "/api/v1/operations/events", headers: upstreamHeaders(epoch, "text/event-stream"), signal: epoch.controller.signal, timeoutMs: 10_000 });
    if (response.statusCode === 401) { response.resume(); throw Object.assign(new Error("upstream_unauthorized"), { reason: "expired" as const }); }
    if (response.statusCode !== 200 || !String(response.headers["content-type"] ?? "").startsWith("text/event-stream")) {
      response.resume();
      throw new Error("upstream_unavailable");
    }
    const parser = createSseParser();
    response.on("data", (chunk: Buffer) => {
      const fed = parser.feed(chunk);
      if (!fed.ok) { terminate(epoch, "protocol_error", false); return; }
      for (const event of fed.events) {
        if (event.event !== "control:reclaimed") continue;
        const reason = (event.data as { reason?: unknown } | null)?.reason;
        if (reason === "reclaimed" || reason === "superseded") terminate(epoch, reason, false);
        else terminate(epoch, "protocol_error", false);
      }
    });
    const lost = (): void => { if (epoch.state !== "terminal") terminate(epoch, "disconnected", false); };
    response.once("end", lost);
    response.once("close", lost);
    response.once("error", lost);
  }

  /** 열린 SSE는 원격 유휴 타이머를 밀지 않는다 — 세션이 조용히 만료되지 않았는지 주기적으로 다시 묻는다. */
  function scheduleRevalidation(epoch: EpochRecord): void {
    epoch.revalidate = setInterval(() => {
      void upstreamJson(epoch, "/api/v1/access/self", LIMITS.statusBytes).then(({ status, body }) => {
        if (status === 200 && (body as { access?: unknown } | null)?.access !== "monitoring") terminate(epoch, "expired", false);
      }).catch(() => { if (epoch.state !== "terminal") terminate(epoch, "disconnected", false); });
    }, LIMITS.revalidateMs);
    epoch.revalidate.unref();
  }

  // ───────────────────────── epoch 리스너 ─────────────────────────

  function listen(epoch: EpochRecord): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => { void serveEpoch(epoch, req, res); });
      server.headersTimeout = 10_000;
      server.requestTimeout = 0;
      server.on("connection", (socket: Socket) => {
        if (epoch.state === "terminal") { socket.destroy(); return; }
        epoch.sockets.add(socket);
        socket.once("close", () => epoch.sockets.delete(socket));
      });
      // 프록시 터널은 받지 않는다 — 데이터 뷰의 외부·다른 루프백 행 요청은 여기서 바이트 없이 끝난다.
      server.on("connect", (_req: http.IncomingMessage, socket: Duplex) => { socket.destroy(); });
      server.on("upgrade", (_req: http.IncomingMessage, socket: Duplex) => {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") { server.close(); reject(new Error("listen_failed")); return; }
        epoch.server = server;
        epoch.origin = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  }

  function refuse(res: http.ServerResponse, status: 400 | 401 | 403 | 404 | 429 | 502): void {
    // 인증 실패와 거부는 고정 문장 하나 — capability도 원인도 싣지 않는다.
    const text = status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not found" : status === 429 ? "busy" : status === 502 ? "unavailable" : "bad request";
    res.writeHead(status, { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", Connection: "close" });
    res.end(text);
  }

  function capabilityOf(req: http.IncomingMessage, name: string): string | null {
    const header = req.headers.cookie;
    if (typeof header !== "string") return null;
    const values = header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`)).map((part) => part.slice(name.length + 1));
    // 같은 이름이 둘 이상이면 어느 쪽도 믿지 않는다.
    return values.length === 1 ? values[0]! : null;
  }

  function admitted(epoch: EpochRecord, req: http.IncomingMessage, route: EpochRoute | null): boolean {
    if (epoch.state !== "ready" || epoch.capabilityHash === null) return false;
    if (!liveOwner(epoch.ownerId)) return false;
    const current = deps.remoteHostStore.find(epoch.host.id);
    if (!current) { terminate(epoch, "host_removed", false); return false; }
    if (current.pinGeneration !== epoch.host.pinGeneration || current.fingerprint !== epoch.host.fingerprint) { terminate(epoch, "pin_changed", false); return false; }
    const presented = capabilityOf(req, epoch.cookieName);
    if (presented === null) return false;
    const presentedHash = hash(presented);
    if (!crypto.timingSafeEqual(presentedHash, epoch.capabilityHash)) return false;
    // capability가 인증이다. Origin·Fetch Metadata는 교차 사이트 요청을 거르는 보조 신호일 뿐이다.
    const origin = req.headers.origin;
    if (typeof origin === "string") return origin === epoch.origin;
    const site = req.headers["sec-fetch-site"];
    if (site === "same-origin") return true;
    return route?.kind === "static" && site === "none" && req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document";
  }

  async function serveEpoch(epoch: EpochRecord, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const decision = resolveEpochRoute(req.method, req.url);
    // Host가 이 리스너가 아니면 프록시를 거쳐 다른 목적지로 가려던 요청이다 — 인증 전에 끝낸다.
    if (req.headers.host !== new URL(epoch.origin ?? "http://invalid").host) { refuse(res, 400); return; }
    if (!decision.ok && decision.status === 400) { refuse(res, 400); return; }
    if (!admitted(epoch, req, decision.ok ? decision.route : null)) { refuse(res, 401); return; }
    if (!decision.ok) { refuse(res, 404); return; }
    const route = decision.route;
    try {
      if (route.kind === "static") serveStatic(res, route.relative);
      else if (route.kind === "synthetic") await serveSynthetic(epoch, req, res, route.id);
      else if (route.transport === "sse") await relayStream(epoch, req, res, route.path, route.events ?? []);
      else await relayJson(epoch, res, route.path);
    } catch (error) {
      if (!res.headersSent) refuse(res, error instanceof PinRejectedError ? 502 : 502);
      else res.destroy();
    }
  }

  function serveStatic(res: http.ServerResponse, relative: string): void {
    const presentation = deps.presentation();
    const asset = deps.readAsset(relative, presentation.theme, presentation.liquidGlass);
    if (!asset) { refuse(res, 404); return; }
    // 진입 문서에만 표면 표식을 넣는다. SPA는 이 표식으로 읽기 전용 모드를 알고, 평소 부팅은 요청을 더 보내지 않는다.
    const body = relative === "index.html" ? String(asset.body).replace("</head>", `${PROXY_SURFACE_META}</head>`) : asset.body;
    res.writeHead(200, { ...BASE_HEADERS, "Content-Type": asset.contentType, "Content-Security-Policy": EPOCH_CSP, "Cache-Control": asset.immutable ? "public, max-age=31536000, immutable" : "no-store" });
    res.end(body);
  }

  function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "sandbox" });
    res.end(JSON.stringify(body));
  }

  async function serveSynthetic(epoch: EpochRecord, req: http.IncomingMessage, res: http.ServerResponse, id: "status" | "settings" | "manifest" | "proxy-state" | "join"): Promise<void> {
    if (id === "join") {
      // 절대 조인하지 않는다. SPA의 재개 규율은 401을 보고 스스로 멈춘다.
      req.resume();
      writeJson(res, 401, { error: "session_resume_refused", reason: epoch.state === "terminal" ? epoch.reason : "proxy_epoch" });
      return;
    }
    if (id === "manifest") { writeJson(res, 200, { plugins: [], skipped: [] }); return; }
    if (id === "proxy-state") {
      writeJson(res, 200, { surface: "proxy-data", state: epoch.state, reason: epoch.reason, access: "monitoring", host: { label: sanitizeLabel(epoch.host.label) } });
      return;
    }
    if (id === "settings") {
      const presentation = deps.presentation();
      const uiFont = presentation.uiFont.source === "builtin" ? presentation.uiFont : { source: "builtin", id: "manrope", size: presentation.uiFont.size };
      writeJson(res, 200, {
        consolePortMode: "dynamic",
        consoleStaticPort: null,
        seenFeatureTours: [],
        theme: presentation.theme,
        liquidGlass: presentation.liquidGlass,
        unfocusedPanelFade: presentation.unfocusedPanelFade,
        uiFont,
        language: presentation.language,
        experiments: {},
        shortcuts: {},
      });
      return;
    }
    // status 분할: 이름·workspaces·Wiki 상태는 표시 중인 원격, 번들 버전은 로컬, 업데이트 정보는 싣지 않는다.
    const theaterId = new URL(req.url ?? "/", "http://epoch").searchParams.get("theaterId");
    const remote = await upstreamJson(epoch, theaterId ? `/api/v1/status?theaterId=${theaterId}` : "/api/v1/status", LIMITS.statusBytes);
    if (remote.status !== 200 || !remote.body || typeof remote.body !== "object") { refuse(res, remote.status === 401 ? 401 : 502); return; }
    const body = remote.body as Record<string, unknown>;
    const port = Number(new URL(epoch.origin!).port);
    writeJson(res, 200, {
      name: sanitizeLabel(typeof body.name === "string" ? body.name : epoch.host.label),
      workspaces: Number.isSafeInteger(body.workspaces) && (body.workspaces as number) >= 0 && (body.workspaces as number) < 100_000 ? body.workspaces : 0,
      version: deps.localVersion(),
      remoteVersion: typeof body.version === "string" ? body.version.slice(0, 64) : null,
      channel: "unknown",
      updateAvailable: false,
      port,
      portMode: "dynamic",
      requestedPort: null,
      effectivePort: port,
      portHonored: true,
      wikiServerStatus: body.wikiServerStatus === "available" || body.wikiServerStatus === "unavailable" ? body.wikiServerStatus : "unknown",
      surface: "proxy-data",
    });
  }

  async function relayJson(epoch: EpochRecord, res: http.ServerResponse, path: string): Promise<void> {
    if (epoch.upstreams >= LIMITS.upstreamPerEpoch) { refuse(res, 429); return; }
    epoch.upstreams += 1;
    try {
      const upstream = await upstreamJson(epoch, path, LIMITS.responseBytes);
      if (epoch.state === "terminal") { refuse(res, 401); return; }
      if (upstream.status === 502 || upstream.body === null) { refuse(res, 502); return; }
      writeJson(res, upstream.status, upstream.body);
    } finally {
      epoch.upstreams -= 1;
    }
  }

  async function relayStream(epoch: EpochRecord, req: http.IncomingMessage, res: http.ServerResponse, path: string, allowed: readonly string[]): Promise<void> {
    if (epoch.streams >= LIMITS.streamsPerEpoch) { refuse(res, 429); return; }
    epoch.streams += 1;
    const controller = new AbortController();
    const onEpochEnd = (): void => controller.abort(new Error("epoch_terminal"));
    epoch.controller.signal.addEventListener("abort", onEpochEnd, { once: true });
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      epoch.streams -= 1;
      epoch.controller.signal.removeEventListener("abort", onEpochEnd);
      controller.abort(new Error("stream_closed"));
      if (!res.writableEnded) res.destroy();
    };
    req.once("close", finish);
    try {
      const upstream = await pinnedRequest(epoch.target, { method: "GET", path, headers: upstreamHeaders(epoch, "text/event-stream"), signal: controller.signal, timeoutMs: 10_000 });
      if (upstream.statusCode === 401) { upstream.resume(); terminate(epoch, "expired", false); refuse(res, 401); finish(); return; }
      if (upstream.statusCode !== 200 || !String(upstream.headers["content-type"] ?? "").startsWith("text/event-stream")) { upstream.resume(); refuse(res, 502); finish(); return; }
      res.writeHead(200, { ...BASE_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.flushHeaders();
      const parser = createSseParser();
      upstream.on("data", (chunk: Buffer) => {
        const fed = parser.feed(chunk);
        if (!fed.ok) { finish(); return; }
        if (fed.keepalive) res.write(": keepalive\n\n");
        for (const event of fed.events) if (allowed.includes(event.event)) res.write(encodeSseEvent(event));
      });
      // upstream이 어떤 식으로든 끝나면 downstream도 끝낸다 — 그래야 EventSource가 다시 묻고, 상태를 다시 본다.
      upstream.once("end", finish);
      upstream.once("close", finish);
      upstream.once("error", finish);
    } catch (error) {
      if (!res.headersSent) refuse(res, error instanceof PinRejectedError ? 502 : 502);
      finish();
    }
  }

  // ───────────────────────── 메인 리스너 broker API ─────────────────────────

  function nativeJson(res: http.ServerResponse, status: number, body?: unknown): void {
    if (body === undefined) { res.writeHead(status, { ...BASE_HEADERS, "Cache-Control": "no-store" }); res.end(); return; }
    res.writeHead(status, { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  }

  async function readBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > DESKTOP_PROXY_BODY_LIMIT_BYTES) throw new Error("body_too_large");
      chunks.push(chunk as Buffer);
    }
    if (size === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  }

  async function delegate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: unknown;
    try { body = await readBody(req); } catch { nativeJson(res, 400, { error: "invalid_delegation" }); return; }
    if (!isDesktopProxyDelegation(body)) { nativeJson(res, 400, { error: "invalid_delegation" }); return; }
    const delegation: DesktopProxyDelegation = body;
    const owner = liveOwner(delegation.ownerLeaseId);
    if (!owner) { nativeJson(res, 410, { error: "owner_lease_expired" }); return; }
    const bodyHash = crypto.createHash("sha256").update(JSON.stringify(delegation)).digest("hex");
    const previous = owner.requests.get(delegation.requestId);
    if (previous) {
      if (previous.bodyHash !== bodyHash) { nativeJson(res, 409, { error: "request_conflict" }); return; }
      const existing = epochs.get(previous.epochId);
      // capability는 다시 싣지 않는다. 첫 응답을 잃었다면 Desktop이 이 epoch를 폐기하고 새로 받는다.
      nativeJson(res, 200, { epochId: previous.epochId, generation: existing?.generation ?? 0, state: existing?.state ?? "terminal" });
      return;
    }
    if (delegation.switchGeneration < owner.latestSwitch) { nativeJson(res, 409, { error: "stale_switch" }); return; }
    owner.latestSwitch = delegation.switchGeneration;
    const minuteAgo = now() - 60_000;
    while (owner.issued.length > 0 && owner.issued[0]! < minuteAgo) owner.issued.shift();
    if (owner.issued.length >= LIMITS.issuesPerMinute) { nativeJson(res, 429, { error: "rate_limited" }); return; }
    owner.issued.push(now());
    const host = deps.remoteHostStore.find(delegation.hostId);
    if (!host) { nativeJson(res, 404, { error: "remote_host_unknown" }); return; }
    if (host.pinGeneration !== delegation.pinGeneration) { nativeJson(res, 409, { error: "pin_mismatch" }); return; }
    // 정확히 그 포트의 세션 쿠키 하나만. pairing이나 다른 이름은 받지 않고 곧바로 버린다.
    if (delegation.session.name !== sessionCookieName(host.port) || !SESSION_VALUE.test(delegation.session.value)) { nativeJson(res, 400, { error: "invalid_delegation" }); return; }
    const active = [...epochs.values()].filter((epoch) => epoch.state !== "terminal");
    if (active.some((epoch) => epoch.host.id === host.id)) { nativeJson(res, 409, { error: "host_busy" }); return; }
    if (active.length >= LIMITS.activeEpochs) { nativeJson(res, 429, { error: "rate_limited" }); return; }

    const epoch: EpochRecord = {
      id: newId(),
      ownerId: owner.id,
      generation: ++generationSeq,
      host,
      target: { hostname: host.hostname, port: host.port, fingerprint: host.fingerprint },
      controller: new AbortController(),
      state: "preparing",
      reason: null,
      session: delegation.session.value,
      capabilityHash: null,
      origin: null,
      cookieName: "",
      server: null,
      sockets: new Set(),
      upstreams: 0,
      streams: 0,
      revalidate: null,
    };
    epochs.set(epoch.id, epoch);
    owner.requests.set(delegation.requestId, { bodyHash, epochId: epoch.id });
    publish(epoch);
    const fail = (status: number, error: string, reason: DesktopProxyTerminalReason = "released"): void => {
      terminate(epoch, reason, false);
      nativeJson(res, status, { error });
    };
    try {
      const self = await upstreamJson(epoch, "/api/v1/access/self", LIMITS.statusBytes);
      if (self.status === 401) { fail(502, "upstream_unavailable", "expired"); return; }
      if (self.status !== 200 || (self.body as { access?: unknown } | null)?.access !== "monitoring") { fail(409, "access_not_monitoring"); return; }
      const status = await upstreamJson(epoch, "/api/v1/status", LIMITS.statusBytes);
      if (status.status !== 200) { fail(502, "upstream_unavailable"); return; }
      if ((status.body as { version?: unknown } | null)?.version !== deps.localVersion()) { fail(409, "version_mismatch", "version_drift"); return; }
      await openControlStream(epoch);
      await listen(epoch);
      // 기다리는 사이 전환이 취소됐거나 owner가 사라졌다면 발급하지 않는다.
      if (epoch.state === "terminal") { nativeJson(res, 409, { error: "stale_switch" }); return; }
      const current = liveOwner(owner.id);
      if (!current || current.latestSwitch !== delegation.switchGeneration) { fail(409, "stale_switch"); return; }
      const capability = crypto.randomBytes(32).toString("base64url");
      epoch.capabilityHash = hash(capability);
      epoch.cookieName = `fleet_epoch_${epoch.id}`;
      epoch.state = "ready";
      scheduleRevalidation(epoch);
      publish(epoch);
      log({ event: "epoch_ready", epochId: epoch.id, generation: epoch.generation });
      nativeJson(res, 201, { epochId: epoch.id, generation: epoch.generation, origin: epoch.origin, cookieName: epoch.cookieName, capability, leaseExpiresAt: Date.now() + Math.max(0, current.expiresAt - now()) });
    } catch (error) {
      const reason = (error as { reason?: DesktopProxyTerminalReason }).reason ?? "released";
      fail(502, error instanceof PinRejectedError ? "pin_rejected" : "upstream_unavailable", reason);
    }
  }

  function openEvents(req: http.IncomingMessage, res: http.ServerResponse, ownerId: string): void {
    const owner = liveOwner(ownerId);
    if (!owner) { nativeJson(res, 410, { error: "owner_lease_expired" }); return; }
    res.writeHead(200, { ...BASE_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.flushHeaders();
    owner.subscribers.add(res);
    // 이 연결은 lease를 연장하지 않는다 — 명시 heartbeat만이 owner가 살아 있다는 증거다.
    for (const epoch of epochs.values()) if (epoch.ownerId === owner.id) res.write(`event: ${DESKTOP_PROXY_EPOCH_STATE_EVENT}\ndata: ${JSON.stringify({ epochId: epoch.id, generation: epoch.generation, state: epoch.state })}\n\n`);
    const keepalive = setInterval(() => res.write(": keepalive\n\n"), 15_000);
    keepalive.unref();
    req.once("close", () => { clearInterval(keepalive); owner.subscribers.delete(res); });
  }

  function handle(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, loopbackPort: number): boolean {
    if (pathname !== DESKTOP_PROXY_OWNERS_PATH && !pathname.startsWith(`${DESKTOP_PROXY_OWNERS_PATH}/`)
      && pathname !== DESKTOP_PROXY_EPOCHS_PATH && !pathname.startsWith(`${DESKTOP_PROXY_EPOCHS_PATH}/`)
      && pathname !== DESKTOP_PROXY_EVENTS_PATH) return false;
    // 네이티브 전용 문. 정확한 루프백 Host, lock token, 브라우저 Origin 없음.
    if (req.headers.host !== `127.0.0.1:${loopbackPort}` || req.headers.origin !== undefined || !deps.isLockAuthorized(req)) {
      nativeJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const url = new URL(req.url ?? "/", "http://broker");
    if (pathname === DESKTOP_PROXY_OWNERS_PATH && req.method === "POST") {
      const owner: OwnerRecord = { id: newId(), expiresAt: now() + DESKTOP_PROXY_LEASE_MS, latestSwitch: 0, issued: [], requests: new Map(), subscribers: new Set() };
      owners.set(owner.id, owner);
      req.resume();
      nativeJson(res, 201, { ownerLeaseId: owner.id, heartbeatMs: DESKTOP_PROXY_HEARTBEAT_MS, expiresInMs: DESKTOP_PROXY_LEASE_MS, leaseExpiresAt: Date.now() + DESKTOP_PROXY_LEASE_MS });
      return true;
    }
    const ownerPath = /^\/api\/v1\/proxy\/owners\/([^/]+)(?:\/(heartbeat|switch))?$/u.exec(pathname);
    if (ownerPath && isDesktopProxyId(ownerPath[1])) {
      const action = ownerPath[2];
      if (!action && req.method === "DELETE") {
        const owner = owners.get(ownerPath[1]!);
        if (owner) expireOwner(owner, "owner_released");
        nativeJson(res, 204);
        return true;
      }
      const owner = liveOwner(ownerPath[1]!);
      if (req.method !== "POST" || !action) { nativeJson(res, 404, { error: "not_found" }); return true; }
      if (!owner) { req.resume(); nativeJson(res, 410, { error: "owner_lease_expired" }); return true; }
      if (action === "heartbeat") {
        req.resume();
        owner.expiresAt = now() + DESKTOP_PROXY_LEASE_MS;
        nativeJson(res, 204);
        return true;
      }
      void readBody(req).then((body) => {
        const next = (body as { switchGeneration?: unknown } | null)?.switchGeneration;
        if (!Number.isSafeInteger(next) || (next as number) < owner.latestSwitch) { nativeJson(res, 409, { error: "stale_switch" }); return; }
        owner.latestSwitch = next as number;
        nativeJson(res, 204);
      }, () => nativeJson(res, 400, { error: "invalid_request" }));
      return true;
    }
    if (pathname === DESKTOP_PROXY_EPOCHS_PATH && req.method === "POST") {
      void delegate(req, res).catch(() => { if (!res.headersSent) nativeJson(res, 502, { error: "upstream_unavailable" }); });
      return true;
    }
    const epochPath = /^\/api\/v1\/proxy\/epochs\/([^/]+)$/u.exec(pathname);
    if (epochPath && req.method === "DELETE" && isDesktopProxyId(epochPath[1])) {
      req.resume();
      const owner = url.searchParams.get("owner") ?? "";
      const mode = url.searchParams.get("mode");
      const epoch = epochs.get(epochPath[1]!);
      if (epoch && epoch.ownerId !== owner) { nativeJson(res, 404, { error: "not_found" }); return true; }
      if (mode !== "final" && mode !== "transfer") { nativeJson(res, 400, { error: "invalid_request" }); return true; }
      if (epoch && String(epoch.generation) === url.searchParams.get("generation")) terminate(epoch, "released", mode === "final");
      nativeJson(res, 204);
      return true;
    }
    if (pathname === DESKTOP_PROXY_EVENTS_PATH && req.method === "GET") {
      const owner = url.searchParams.get("owner") ?? "";
      if (!isDesktopProxyId(owner)) { nativeJson(res, 400, { error: "invalid_request" }); return true; }
      openEvents(req, res, owner);
      return true;
    }
    nativeJson(res, 404, { error: "not_found" });
    return true;
  }

  return {
    handle,
    shutdown() {
      clearInterval(sweep);
      for (const owner of [...owners.values()]) expireOwner(owner, "owner_released");
      for (const epoch of [...epochs.values()]) terminate(epoch, "owner_released", false);
    },
  };
}

/** 원격이 준 이름·라벨을 화면에 내기 전에 길이와 문자(제어·양방향 서식)를 제한한다. */
function sanitizeLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/gu, "").trim().slice(0, 64) || "Console";
}
