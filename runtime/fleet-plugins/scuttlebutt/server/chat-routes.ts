import crypto from "node:crypto";
import fs from "node:fs/promises";
import type http from "node:http";

import { AI_GATEWAY_ROUTE_SEGMENT } from "@dotobokuri/core-ai-gateway";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";
import { DEFAULT_EXPERIMENT_SETTINGS, isExperimentModelId } from "@fleet-console/sdk/settings";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";

import { createConsoleReadTools, isConsoleSnapshot, type ConsoleSnapshot } from "./console-tools.js";

import {
  ADMIRAL_IDS,
  ChatSession,
  isAideEffort,
  type AdmiralId,
  type AideEffort,
  type ChatSessionLike,
} from "./chat-session.js";
import { SessionRegistry } from "./session-registry.js";

export interface ChatRouteDeps {
  readonly createSession?: (options: ConstructorParameters<typeof ChatSession>[0]) => ChatSessionLike;
  readonly id?: () => string;
  readonly ensureDir?: (dir: string) => Promise<void>;
  readonly removeDir?: (dir: string) => Promise<void>;
}

/** 사용자 노출 이름. 플러그인 id(`scuttlebutt`)는 경로·저장 키로만 남는다. */
const API_CATEGORY = "Quaker Aides";

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
  const removeDir = deps.removeDir ?? (async (dir: string) => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  // 세션마다 자기 작업 디렉터리를 갖는다 — 같은 부관을 두 기기에서 쓰면 CLI 자식 둘이 한 cwd를
  // 나눠 갖게 되므로. 종료 시 지우고, 시작 때 죽은 세션의 잔여를 함께 걷는다.
  const workspaces = new Map<string, string>();

  // 실험 "부관의 Console 읽기"의 활동 스냅샷 — 세션마다 브라우저가 메시지에 실어 보낸 마지막 것.
  const snapshots = new Map<string, ConsoleSnapshot>();
  registerRouter(ctx, "chat", async ({ req, res, pathname }) => {
    if (!ctx.host.security.isTerminalAuthorized(req)) {
      ctx.host.http.writeJson(res, 403, { error: "forbidden" });
      return true;
    }
    const routePath = pathname.slice(`${ctx.basePath}/chat`.length) || "/";
    if (routePath === "/start") {
      // 레지스트리는 용량 초과·자식 종료로도 세션을 지운다 — 그 경로는 이 맵을 모르므로 새 세션이
      // 설 때마다 산 세션의 것만 남긴다. 맵의 크기는 언제나 동시 세션 상한을 넘지 않는다.
      const live = new Set(registry.liveIds());
      for (const key of [...snapshots.keys()]) if (!live.has(key)) snapshots.delete(key);
      for (const [key, dir] of [...workspaces]) {
        if (live.has(key)) continue;
        workspaces.delete(key);
        void removeDir(dir).catch(() => undefined);
      }
      return handleStart(ctx, req, res, registry, createSession, id, ensureDir, snapshots, workspaces);
    }
    const match = routePath.match(/^\/([^/]+)\/(message|stream|stop|cancel)$/u);
    if (!match) return false;
    const chatId = decodePathSegment(match[1]);
    if (chatId === null) {
      ctx.host.http.writeJson(res, 400, { error: "invalid_chat_id" });
      return true;
    }
    if (match[2] === "message") return handleMessage(ctx, req, res, chatId, registry, snapshots);
    if (match[2] === "stream") return handleStream(ctx, req, res, chatId, registry);
    if (match[2] === "cancel") return handleCancel(ctx, req, res, chatId, registry);
    snapshots.delete(chatId);
    const workspace = workspaces.get(chatId);
    workspaces.delete(chatId);
    const handled = await handleStop(ctx, req, res, chatId, registry);
    if (workspace) void removeDir(workspace).catch(() => undefined);
    return handled;
  }, [
    { method: "POST", path: "/start", summary: "Start a Quaker aide chat session.", category: API_CATEGORY, gate: "origin-write", transport: "http" },
    { method: "POST", path: "/:chatId/message", summary: "Send a message to a Quaker aide.", category: API_CATEGORY, gate: "origin-write", transport: "http" },
    { method: "GET", path: "/:chatId/stream", summary: "Stream a Quaker aide chat session.", category: API_CATEGORY, gate: "origin-write", transport: "sse" },
    { method: "POST", path: "/:chatId/cancel", summary: "Stop the aide's current answer, keeping the session.", category: API_CATEGORY, gate: "origin-write", transport: "http" },
    { method: "POST", path: "/:chatId/stop", summary: "Stop a Quaker aide chat session.", category: API_CATEGORY, gate: "origin-write", transport: "http" },
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
  workspaces: Map<string, string>,
): Promise<boolean> {
  if (req.method !== "POST") return methodNotAllowed(ctx, res);
  if (!isJsonRequest(req)) return unsupportedMediaType(ctx, res);
  const body = await ctx.host.http.readJsonBody<unknown>(req);
  if (!isStartBody(body)) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_start" });
    return true;
  }
  const chatId = id();
  const workspace = `${ctx.host.paths.pluginDataDir("scuttlebutt")}/workspace/${body.admiral}/${chatId}`;
  let result: Awaited<ReturnType<SessionRegistry["start"]>>;
  try {
    // pluginDataDir 은 경로만 만들어 준다 — 없는 디렉터리에서 CLI를 띄우면 기동 자체가 실패한다.
    await ensureDir(workspace);
    workspaces.set(chatId, workspace);
    // 리슨이 확정되기 전에는 origin이 없다. 포트를 추측하지 않고 시작을 거절한다 — 잘못된 주소로
    // 띄우면 자식이 첫 턴에서야 알 수 없는 이유로 죽는다.
    const origin = ctx.host.server.origin();
    if (!origin) throw new Error("Console origin is not available yet");
    // 실험: 세션이 시작되는 순간의 설정으로 정한다 — 대화 도중 켜고 끄면 다음 세션부터 따른다.
    const experiments = ctx.host.experiments?.read() ?? DEFAULT_EXPERIMENT_SETTINGS;
    const consoleRead = experiments.aideConsoleRead
      ? createConsoleReadTools(ctx, () => snapshots.get(chatId) ?? null)
      : undefined;
    result = await registry.start(chatId, (onEvent) => createSession({
      cwd: workspace,
      admiral: body.admiral,
      ...(body.model ? { model: body.model } : {}),
      ...(body.effort ? { effort: body.effort } : {}),
      ...(body.locale ? { locale: body.locale } : {}),
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
  if (body.console !== undefined) snapshots.set(chatId, { ...body.console, takenAt: new Date().toISOString() });
  const result = await registry.message(chatId, body.text);
  if (result === "not_found") {
    snapshots.delete(chatId);
    ctx.host.http.writeJson(res, 404, { error: "session_not_found" });
  } else if (result === "busy") ctx.host.http.writeJson(res, 409, { error: "session_busy" });
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

async function handleCancel(
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
    ctx.host.http.writeJson(res, 400, { error: "invalid_cancel" });
    return true;
  }
  const result = registry.cancel(chatId);
  if (result === "not_found") ctx.host.http.writeJson(res, 404, { error: "session_not_found" });
  else ctx.host.http.writeJson(res, 200, { cancelled: true });
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

const LOCALES: readonly ConsoleLocale[] = ["en", "ko"];

interface StartBody {
  readonly admiral: AdmiralId;
  readonly model?: string;
  readonly effort?: AideEffort;
  readonly locale?: ConsoleLocale;
}

/**
 * 모델·강도·언어는 선택이며 모양이 엄격하다 — 모델 id는 `--model`에 그대로 들어가는 값이라
 * 실험 설정과 같은 정제기를 쓰고, 알 수 없는 키는 거절한다.
 */
function isStartBody(value: unknown): value is StartBody {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).filter((key) => !["admiral", "model", "effort", "locale"].includes(key));
  if (keys.length > 0) return false;
  if (typeof value.admiral !== "string" || !ADMIRAL_IDS.some((admiral) => admiral === value.admiral)) return false;
  if (value.model !== undefined && !isExperimentModelId(value.model)) return false;
  if (value.effort !== undefined && !isAideEffort(value.effort)) return false;
  if (value.locale !== undefined && !(LOCALES as readonly unknown[]).includes(value.locale)) return false;
  return true;
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
