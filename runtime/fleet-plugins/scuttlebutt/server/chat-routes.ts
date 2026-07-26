import crypto from "node:crypto";
import type http from "node:http";

import {
  CliDetector,
  getProviderModels,
  type CliDetectionResult,
} from "@dotobokuri/core-unified-agent";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";

import { ChatSession, redactScratchPath, type ChatSessionLike } from "./chat-session.js";
import {
  defaultScuttlebuttSettings,
  HistoryStore,
  type ChatThreadDto,
} from "./history-store.js";
import { SessionRegistry } from "./session-registry.js";

const CHAT_CLI_IDS = ["claude", "claude-kimi", "codex"] as const;
type ChatCliId = (typeof CHAT_CLI_IDS)[number];

export type ChatCatalog = {
  readonly clis: readonly ChatCatalogCli[];
  readonly threads: readonly ChatThreadDto[];
  readonly settings: ReturnType<typeof defaultScuttlebuttSettings>;
};

export type ChatCatalogCli = {
  readonly cliId: ChatCliId;
  readonly label: string;
  readonly available: boolean;
  readonly defaultModel: string;
  readonly models: readonly {
    readonly id: string;
    readonly label: string;
    readonly effortLevels: readonly string[];
    readonly defaultEffort?: string;
  }[];
  readonly reason?: string;
};

export interface ChatRouteDeps {
  readonly detect?: () => Promise<readonly CliDetectionResult[]>;
  readonly modelsFor?: typeof getProviderModels;
  readonly createSession?: (options: ConstructorParameters<typeof ChatSession>[0]) => ChatSessionLike;
  readonly now?: () => number;
  readonly id?: () => string;
}

export function registerChatRoutes(ctx: FleetPluginServerContext, deps: ChatRouteDeps = {}): SessionRegistry {
  const pluginDataDir = ctx.host.paths.pluginDataDir("scuttlebutt");
  const history = new HistoryStore(ctx.host.storage, (text) => redactScratchPath(text, pluginDataDir));
  const registry = new SessionRegistry({
    onUserMessage: (chatId, text) => history.appendMessage(chatId, "user", text).then(() => undefined),
    onAssistantMessage: (chatId, text) => history.appendMessage(chatId, "assistant", text).then(() => undefined),
  });
  const detect = deps.detect ?? (() => new CliDetector().detectAll());
  const modelsFor = deps.modelsFor ?? getProviderModels;
  const createSession = deps.createSession ?? ((options) => new ChatSession(options));
  const now = deps.now ?? Date.now;
  const id = deps.id ?? crypto.randomUUID;

  const catalog = async (): Promise<ChatCatalog> => buildChatCatalog(await detect(), await history.list(), modelsFor);

  registerRouter(ctx, "chat", async ({ req, res, pathname }) => {
    if (!ctx.host.security.isTerminalAuthorized(req)) {
      ctx.host.http.writeJson(res, 403, { error: "forbidden" });
      return true;
    }
    const routePath = pathname.slice(`${ctx.basePath}/chat`.length) || "/";
    if (routePath === "/catalog") return handleCatalog(ctx, req, res, catalog);
    if (routePath === "/start") {
      return handleStart(ctx, req, res, registry, catalog, createSession, now, id, history);
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

export function buildChatCatalog(
  detections: readonly CliDetectionResult[],
  threads: readonly ChatThreadDto[],
  modelsFor: typeof getProviderModels = getProviderModels,
): ChatCatalog {
  const detectionByCli = new Map(detections.map((detection) => [detection.cli, detection]));
  const clis = CHAT_CLI_IDS.map((cliId): ChatCatalogCli => {
    const provider = modelsFor(cliId);
    const detection = detectionByCli.get(cliId);
    return {
      cliId,
      label: cliId === "claude-kimi" ? "Kimi (Claude Code)" : provider.name,
      available: cliId !== "codex" && detection?.available === true,
      defaultModel: provider.defaultModel,
      models: provider.models.map((model) => ({
        id: model.modelId,
        label: model.name,
        effortLevels: model.effort.supported ? [...model.effort.levels] : [],
        ...(model.effort.supported ? { defaultEffort: model.effort.default } : {}),
      })),
      ...(cliId === "codex"
        ? { reason: "web_only_policy_unsupported" }
        : detection?.available === true ? {} : { reason: "cli_unavailable" }),
    };
  });
  return {
    clis,
    threads,
    settings: defaultScuttlebuttSettings(modelsFor("claude").defaultModel),
  };
}

async function handleCatalog(
  ctx: FleetPluginServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  catalog: () => Promise<ChatCatalog>,
): Promise<boolean> {
  if (req.method !== "GET") return methodNotAllowed(ctx, res);
  ctx.host.http.writeJson(res, 200, await catalog());
  return true;
}

async function handleStart(
  ctx: FleetPluginServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  registry: SessionRegistry,
  catalog: () => Promise<ChatCatalog>,
  createSession: NonNullable<ChatRouteDeps["createSession"]>,
  now: () => number,
  id: () => string,
  history: HistoryStore,
): Promise<boolean> {
  if (req.method !== "POST") return methodNotAllowed(ctx, res);
  if (!isJsonRequest(req)) return unsupportedMediaType(ctx, res);
  const body = await ctx.host.http.readJsonBody<unknown>(req);
  const currentCatalog = await catalog();
  const selection = parseSelection(body, currentCatalog);
  if (!selection) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_selection" });
    return true;
  }
  const chatId = id();
  const createdAt = now();
  const workspace = ctx.host.paths.pluginDataDir("scuttlebutt") + "/workspace";
  const result = await registry.start(chatId, (onEvent) => createSession({
    ...selection,
    cwd: workspace,
    onEvent,
  }));
  if (result === "capacity") {
    ctx.host.http.writeJson(res, 429, { error: "session_capacity" });
    return true;
  }
  if (result !== "started") {
    ctx.host.http.writeJson(res, 409, { error: `session_${result}` });
    return true;
  }
  try {
    await history.create({ id: chatId, cliId: selection.cliId, model: selection.model, createdAt });
  } catch (error) {
    await registry.stop(chatId);
    throw error;
  }
  ctx.host.http.writeJson(res, 200, { thread: {
    id: chatId,
    title: "New chat",
    cliId: selection.cliId,
    model: selection.model,
    createdAt,
    messages: [],
  } satisfies ChatThreadDto });
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

function parseSelection(value: unknown, catalog: ChatCatalog): {
  readonly cliId: ChatCliId;
  readonly model: string;
  readonly effort?: string;
} | null {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !["cliId", "model", "effort"].includes(key))
    || typeof value.cliId !== "string"
    || typeof value.model !== "string"
    || (value.effort !== undefined && value.effort !== null && typeof value.effort !== "string")) return null;
  const cli = catalog.clis.find((candidate) => candidate.cliId === value.cliId);
  if (!cli?.available) return null;
  const model = cli.models.find((candidate) => candidate.id === value.model);
  if (!model) return null;
  const effort = value.effort;
  if (model.effortLevels.length === 0) {
    if (effort !== undefined && effort !== null && effort !== "") return null;
    return { cliId: cli.cliId, model: model.id };
  }
  if (typeof effort !== "string" || !model.effortLevels.includes(effort)) return null;
  return { cliId: cli.cliId, model: model.id, effort };
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
