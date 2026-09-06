import crypto from "node:crypto";
import fs from "node:fs/promises";
import type http from "node:http";

import { AI_GATEWAY_ROUTE_SEGMENT } from "@dotobokuri/core-ai-gateway";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";
import { DEFAULT_EXPERIMENT_SETTINGS } from "@fleet-console/sdk/settings";

import { createConsoleReadTools, isConsoleSnapshot, type ConsoleSnapshot } from "./console-tools.js";

import {
  ADMIRAL_IDS,
  ChatSession,
  type AdmiralId,
  type ChatSessionLike,
} from "./chat-session.js";
import { SessionRegistry } from "./session-registry.js";

export interface ChatRouteDeps {
  readonly createSession?: (options: ConstructorParameters<typeof ChatSession>[0]) => ChatSessionLike;
  readonly id?: () => string;
  readonly ensureDir?: (dir: string) => Promise<void>;
}

/**
 * AI gateway를 서빙하는 것은 terminal 플러그인이다. 경로 조각은 core-ai-gateway가 소유하지만
 * 어느 플러그인 아래 마운트되는지는 그 플러그인이 정하므로, 그 사실만 여기에 상수로 남긴다.
 */
const AI_GATEWAY_OWNER_PLUGIN_ID = "terminal";

function resolveAiGatewayBaseUrl(origin: string): string {
  return `${origin.replace(/\/+$/u, "")}/plugins/${AI_GATEWAY_OWNER_PLUGIN_ID}/${AI_GATEWAY_ROUTE_SEGMENT}`;
}

export function registerChatRoutes(ctx: FleetPluginServerContext, deps: ChatRouteDeps = {}): SessionRegistry {
  const registry = new SessionRegistry();
  const createSession = deps.createSession ?? ((options) => new ChatSession(options));
  const id = deps.id ?? crypto.randomUUID;
  const ensureDir = deps.ensureDir ?? (async (dir: string) => {
    await fs.mkdir(dir, { recursive: true });
  });

  // 실험 "부관의 Console 읽기"의 활동 스냅샷 — 세션마다 브라우저가 메시지에 실어 보낸 마지막 것.
  const snapshots = new Map<string, ConsoleSnapshot>();
  registerRouter(ctx, "chat", async ({ req, res, pathname }) => {
    if (!ctx.host.security.isTerminalAuthorized(req)) {
      ctx.host.http.writeJson(res, 403, { error: "forbidden" });
      return true;
    }
    const routePath = pathname.slice(`${ctx.basePath}/chat`.length) || "/";
    if (routePath === "/start") {
      return handleStart(ctx, req, res, registry, createSession, id, ensureDir, snapshots);
    }
    const match = routePath.match(/^\/([^/]+)\/(message|stream|stop)$/u);
    if (!match) return false;
    const chatId = decodePathSegment(match[1]);
    if (chatId === null) {
      ctx.host.http.writeJson(res, 400, { error: "invalid_chat_id" });
      return true;
    }
    if (match[2] === "message") return handleMessage(ctx, req, res, chatId, registry, snapshots);
    if (match[2] === "stream") return handleStream(ctx, req, res, chatId, registry);
    snapshots.delete(chatId);
    return handleStop(ctx, req, res, chatId, registry);
  }, [
    { method: "POST", path: "/start", summary: "Start a Scuttlebutt chat session.", category: "Scuttlebutt Plugin", gate: "origin-write", transport: "http" },
    { method: "POST", path: "/:chatId/message", summary: "Send a Scuttlebutt chat message.", category: "Scuttlebutt Plugin", gate: "origin-write", transport: "http" },
    { method: "GET", path: "/:chatId/stream", summary: "Stream a Scuttlebutt chat session.", category: "Scuttlebutt Plugin", gate: "origin-write", transport: "sse" },
    { method: "POST", path: "/:chatId/stop", summary: "Stop a Scuttlebutt chat session.", category: "Scuttlebutt Plugin", gate: "origin-write", transport: "http" },
  ]);

  ctx.host.lifecycle.registerCleanup(() => registry.dispose());
  return registry;
}

async function handleStart(
  ctx: FleetPluginServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  registry: SessionRegistry,
  createSession: NonNullable<ChatRouteDeps["createSession"]>,
  id: () => string,
  ensureDir: (dir: string) => Promise<void>,
  snapshots: Map<string, ConsoleSnapshot>,
): Promise<boolean> {
  if (req.method !== "POST") return methodNotAllowed(ctx, res);
  if (!isJsonRequest(req)) return unsupportedMediaType(ctx, res);
  const body = await ctx.host.http.readJsonBody<unknown>(req);
  if (!isStartBody(body)) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_start" });
    return true;
  }
  const chatId = id();
  const workspace = `${ctx.host.paths.pluginDataDir("scuttlebutt")}/workspace/${body.admiral}`;
  let result: Awaited<ReturnType<SessionRegistry["start"]>>;
  try {
    // pluginDataDir 은 경로만 만들어 준다 — 없는 디렉터리에서 CLI를 띄우면 기동 자체가 실패한다.
    await ensureDir(workspace);
    // 리슨이 확정되기 전에는 origin이 없다. 포트를 추측하지 않고 시작을 거절한다 — 잘못된 주소로
    // 띄우면 자식이 첫 턴에서야 알 수 없는 이유로 죽는다.
    const origin = ctx.host.server.origin();
    if (!origin) throw new Error("Console origin is not available yet");
    // 실험: 세션이 시작되는 순간의 설정으로 정한다 — 대화 도중 켜고 끄면 다음 세션부터 따른다.
    const experiments = ctx.host.experiments?.read() ?? DEFAULT_EXPERIMENT_SETTINGS;
    const consoleReadModel = experiments.aideConsoleRead ? experiments.aideConsoleReadModel : null;
    const consoleRead = consoleReadModel
      ? { model: consoleReadModel, ...createConsoleReadTools(ctx, () => snapshots.get(chatId) ?? null) }
      : undefined;
    result = await registry.start(chatId, (onEvent) => createSession({
      cwd: workspace,
      admiral: body.admiral,
      baseUrl: resolveAiGatewayBaseUrl(origin),
      onEvent,
      ...(consoleRead ? { consoleRead } : {}),
    }));
  } catch (error) {
    // 시작 실패는 서버 로그에만 남긴다 — 브라우저에는 코드 한 줄이면 충분하고, 원문에는 경로가 섞일 수 있다.
    console.error("[scuttlebutt] chat session failed to start:", error instanceof Error ? error.message : error);
    ctx.host.http.writeJson(res, 503, { error: "session_unavailable" });
    return true;
  }
  if (result === "capacity") {
    ctx.host.http.writeJson(res, 429, { error: "session_capacity" });
    return true;
  }
  if (result !== "started") {
    ctx.host.http.writeJson(res, 409, { error: `session_${result}` });
    return true;
  }
  ctx.host.http.writeJson(res, 200, { chatId });
  return true;
}

async function handleMessage(
  ctx: FleetPluginServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  chatId: string,
  registry: SessionRegistry,
  snapshots: Map<string, ConsoleSnapshot>,
): Promise<boolean> {
  if (req.method !== "POST") return methodNotAllowed(ctx, res);
  if (!isJsonRequest(req)) return unsupportedMediaType(ctx, res);
  const body = await ctx.host.http.readJsonBody<unknown>(req);
  if (!isMessageBody(body)) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_message" });
    return true;
  }
  if (body.console !== undefined) snapshots.set(chatId, body.console);
  const result = await registry.message(chatId, body.text);
  if (result === "not_found") ctx.host.http.writeJson(res, 404, { error: "session_not_found" });
  else if (result === "busy") ctx.host.http.writeJson(res, 409, { error: "session_busy" });
  else ctx.host.http.writeJson(res, 200, { accepted: true });
  return true;
}

function handleStream(
  ctx: FleetPluginServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  chatId: string,
  registry: SessionRegistry,
): boolean {
  if (req.method !== "GET") return methodNotAllowed(ctx, res);
  let closed = false;
  const write = (data: string) => {
    if (!closed && !res.writableEnded && !res.destroyed) res.write(data);
  };
  res.writeHead(200, securityHeaders({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  }));
  write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
  const unsubscribe = registry.subscribe(chatId, (event) => write(`data: ${JSON.stringify(event)}\n\n`));
  if (!unsubscribe) {
    write(`data: ${JSON.stringify({ type: "error", error: { code: "session_not_found", message: "Chat session was not found." } })}\n\n`);
    res.end();
    return true;
  }
  const keepalive = setInterval(() => write(": keepalive\n\n"), 30_000);
  req.on("close", () => {
    closed = true;
    clearInterval(keepalive);
    unsubscribe();
  });
  return true;
}

async function handleStop(
  ctx: FleetPluginServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  chatId: string,
  registry: SessionRegistry,
): Promise<boolean> {
  if (req.method !== "POST") return methodNotAllowed(ctx, res);
  if (!isJsonRequest(req)) return unsupportedMediaType(ctx, res);
  const body = await ctx.host.http.readJsonBody<unknown>(req);
  if (!isRecord(body) || Object.keys(body).length > 0) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_stop" });
    return true;
  }
  await registry.stop(chatId);
  ctx.host.http.writeJson(res, 200, { stopped: true });
  return true;
}

function isMessageBody(value: unknown): value is { readonly text: string; readonly console?: ConsoleSnapshot } {
  if (!isRecord(value) || typeof value.text !== "string" || value.text.trim().length === 0) return false;
  const keys = Object.keys(value).filter((key) => key !== "text" && key !== "console");
  if (keys.length > 0) return false;
  // 스냅샷은 실험이 켜졌을 때만 실리지만, 실려 왔다면 모양은 엄격하다 — 도구가 그대로 읽는다.
  return value.console === undefined || isConsoleSnapshot(value.console);
}

function isStartBody(value: unknown): value is { readonly admiral: AdmiralId } {
  return isRecord(value)
    && Object.keys(value).length === 1
    && typeof value.admiral === "string"
    && ADMIRAL_IDS.some((admiral) => admiral === value.admiral);
}

function isJsonRequest(req: http.IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string"
    && contentType.toLowerCase().split(";")[0]?.trim() === "application/json";
}

function methodNotAllowed(ctx: FleetPluginServerContext, res: http.ServerResponse): true {
  ctx.host.http.writeJson(res, 405, { error: "method_not_allowed" });
  return true;
}

function unsupportedMediaType(ctx: FleetPluginServerContext, res: http.ServerResponse): true {
  ctx.host.http.writeJson(res, 415, { error: "unsupported_media_type" });
  return true;
}

function decodePathSegment(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function securityHeaders(headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
