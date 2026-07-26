import crypto from "node:crypto";
import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";

import { ChatSession, type ChatSessionLike } from "./chat-session.js";
import { SessionRegistry } from "./session-registry.js";

export interface ChatRouteDeps {
  readonly createSession?: (options: ConstructorParameters<typeof ChatSession>[0]) => ChatSessionLike;
  readonly id?: () => string;
}

export function registerChatRoutes(ctx: FleetPluginServerContext, deps: ChatRouteDeps = {}): SessionRegistry {
  const registry = new SessionRegistry();
  const createSession = deps.createSession ?? ((options) => new ChatSession(options));
  const id = deps.id ?? crypto.randomUUID;

  registerRouter(ctx, "chat", async ({ req, res, pathname }) => {
    if (!ctx.host.security.isTerminalAuthorized(req)) {
      ctx.host.http.writeJson(res, 403, { error: "forbidden" });
      return true;
    }
    const routePath = pathname.slice(`${ctx.basePath}/chat`.length) || "/";
    if (routePath === "/start") {
      return handleStart(ctx, req, res, registry, createSession, id);
    }
    const match = routePath.match(/^\/([^/]+)\/(message|stream|stop)$/u);
    if (!match) return false;
    const chatId = decodePathSegment(match[1]);
    if (chatId === null) {
      ctx.host.http.writeJson(res, 400, { error: "invalid_chat_id" });
      return true;
    }
    if (match[2] === "message") return handleMessage(ctx, req, res, chatId, registry);
    if (match[2] === "stream") return handleStream(ctx, req, res, chatId, registry);
    return handleStop(ctx, req, res, chatId, registry);
  });

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
): Promise<boolean> {
  if (req.method !== "POST") return methodNotAllowed(ctx, res);
  if (!isJsonRequest(req)) return unsupportedMediaType(ctx, res);
  const body = await ctx.host.http.readJsonBody<unknown>(req);
  if (!isRecord(body) || Object.keys(body).length > 0) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_start" });
    return true;
  }
  const chatId = id();
  const workspace = ctx.host.paths.pluginDataDir("scuttlebutt") + "/workspace";
  let result: Awaited<ReturnType<SessionRegistry["start"]>>;
  try {
    result = await registry.start(chatId, (onEvent) => createSession({
      cwd: workspace,
      onEvent,
    }));
  } catch {
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
): Promise<boolean> {
  if (req.method !== "POST") return methodNotAllowed(ctx, res);
  if (!isJsonRequest(req)) return unsupportedMediaType(ctx, res);
  const body = await ctx.host.http.readJsonBody<unknown>(req);
  if (!isMessageBody(body)) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_message" });
    return true;
  }
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

function isMessageBody(value: unknown): value is { readonly text: string } {
  return isRecord(value)
    && Object.keys(value).length === 1
    && typeof value.text === "string"
    && value.text.trim().length > 0;
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
