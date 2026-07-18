import type http from "node:http";

import { AnalystSession, type AnalystEvent } from "@dotobokuri/fleet-analyst";
import { getProviderModels, type CliType } from "@dotobokuri/core-unified-agent";
import type { FleetPluginServerContext, OperationNode } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";

import { createDefaultAgentCliDetector } from "./agent-cli-detect.js";
import { AnalysisRegistry } from "./analysis-registry.js";
import { ANALYSIS_ERROR_CODES, analysisError, buildAnalysisCatalog, isAnalysisSelection, isMessageBody, type AnalysisCatalog, type AnalysisEvent } from "./analysis-types.js";
import { readProviderSessionCapture } from "./session-capture.js";

const AGENT_OPERATION_TYPE = "agent";
const OPERATION_DELETED_EVENT_CHANNEL = "operation:deleted";

type AnalysisRouteDeps = {
  readonly detect?: () => ReturnType<ReturnType<typeof createDefaultAgentCliDetector>["detect"]>;
  readonly createSession?: (options: ConstructorParameters<typeof AnalystSession>[0]) => AnalystSession;
  readonly modelsFor?: typeof getProviderModels;
  readonly readCapture?: typeof readProviderSessionCapture;
};

export function registerAnalysisRoutes(ctx: FleetPluginServerContext, deps: AnalysisRouteDeps = {}): void {
  const registry = new AnalysisRegistry();
  const detect = deps.detect ?? createDefaultAgentCliDetector().detect;
  const modelsFor = deps.modelsFor ?? getProviderModels;
  const readCapture = deps.readCapture ?? readProviderSessionCapture;
  const createSession = deps.createSession ?? ((options) => new AnalystSession(options));
  const catalog = async (): Promise<AnalysisCatalog> => buildAnalysisCatalog(await detect(), modelsFor);

  registerRouter(ctx, "analysis", async ({ req, res, pathname }) => {
    // The socket's bound local port is the only trustworthy expected Host port.
    const localPort = req.socket.localPort;
    if (!localPort || !ctx.host.security.validateHost(req, localPort)) {
      writeError(ctx, res, 403, ANALYSIS_ERROR_CODES.catalogInvalid, "Analysis request is not accepted by this host.");
      return true;
    }
    const path = pathname.slice(`${ctx.basePath}/analysis`.length) || "/";
    if (path === "/catalog") return handleCatalog(ctx, req, res, catalog);
    const match = path.match(/^\/([^/]+)\/(start|message|stream|stop)$/);
    if (!match) return false;
    const operationId = decodeURIComponent(match[1] ?? "");
    const action = match[2] ?? "";
    const operation = getAgentOperation(ctx, operationId);
    if (!operation) {
      writeError(ctx, res, 404, ANALYSIS_ERROR_CODES.sessionNotFound, "Analysis operation was not found.");
      return true;
    }
    if (action === "start") return handleStart(ctx, req, res, operation, registry, catalog, readCapture, createSession);
    if (action === "message") return handleMessage(ctx, req, res, operationId, registry);
    if (action === "stream") return handleStream(ctx, req, res, operationId, registry);
    return handleStop(ctx, req, res, operationId, registry);
  });

  const unsubscribeDelete = ctx.host.events.subscribe(OPERATION_DELETED_EVENT_CHANNEL, (payload) => {
    if (isOperationDeletedEvent(payload) && payload.pluginId === ctx.pluginId) void registry.stop(payload.operationId);
  });
  ctx.host.lifecycle.registerCleanup(async () => { unsubscribeDelete(); await registry.dispose(); });
}

async function handleCatalog(ctx: FleetPluginServerContext, req: http.IncomingMessage, res: http.ServerResponse, catalog: () => Promise<AnalysisCatalog>): Promise<boolean> {
  if (req.method !== "GET") return methodNotAllowed(ctx, res);
  ctx.host.http.writeJson(res, 200, await catalog());
  return true;
}

async function handleStart(ctx: FleetPluginServerContext, req: http.IncomingMessage, res: http.ServerResponse, operation: OperationNode, registry: AnalysisRegistry, catalog: () => Promise<AnalysisCatalog>, readCapture: typeof readProviderSessionCapture, createSession: (options: ConstructorParameters<typeof AnalystSession>[0]) => AnalystSession): Promise<boolean> {
  if (req.method !== "POST") return methodNotAllowed(ctx, res);
  if (!isJsonRequest(req)) return unsupportedMediaType(ctx, res);
  const body = await ctx.host.http.readJsonBody(req);
  const currentCatalog = await catalog();
  if (!isAnalysisSelection(currentCatalog, body)) {
    writeError(ctx, res, 400, ANALYSIS_ERROR_CODES.catalogInvalid, "Analysis selection is unavailable.");
    return true;
  }
  const capture = readCapture(operation.id, { capturesDir: ctx.host.paths.capturesDir });
  if (!capture) {
    writeError(ctx, res, 409, ANALYSIS_ERROR_CODES.captureMissing, "Analysis capture is unavailable.");
    return true;
  }
  if (!capture.transcriptPath) {
    writeError(ctx, res, 409, ANALYSIS_ERROR_CODES.transcriptMissing, "Analysis transcript is unavailable.");
    return true;
  }
  const cwd = ctx.host.paths.resolveTheaterPath(operation.theaterId);
  if (!cwd) {
    writeError(ctx, res, 404, ANALYSIS_ERROR_CODES.sessionNotFound, "Analysis operation was not found.");
    return true;
  }
  try {
    const result = await registry.start(operation.id, (onEvent) => createSession({ cliId: body.cliId, model: body.model, effort: body.effort, cwd, capturePath: capture.transcriptPath!, onEvent: (event: AnalystEvent) => onEvent(toBrowserEvent(event)) }));
    if (result === "exists") writeError(ctx, res, 409, ANALYSIS_ERROR_CODES.sessionExists, "Analysis session already exists.");
    else if (result === "limit") writeError(ctx, res, 429, ANALYSIS_ERROR_CODES.sessionLimit, "Analysis session limit reached.");
    else ctx.host.http.writeJson(res, 200, { started: true });
  } catch {
    writeError(ctx, res, 503, ANALYSIS_ERROR_CODES.catalogInvalid, "Analysis session could not start.");
  }
  return true;
}

async function handleMessage(ctx: FleetPluginServerContext, req: http.IncomingMessage, res: http.ServerResponse, operationId: string, registry: AnalysisRegistry): Promise<boolean> {
  if (req.method !== "POST") return methodNotAllowed(ctx, res);
  if (!isJsonRequest(req)) return unsupportedMediaType(ctx, res);
  const body = await ctx.host.http.readJsonBody(req);
  if (!isMessageBody(body)) { writeError(ctx, res, 400, ANALYSIS_ERROR_CODES.catalogInvalid, "Analysis message is invalid."); return true; }
  const result = await registry.message(operationId, body.text);
  if (result === "not_found") writeError(ctx, res, 404, ANALYSIS_ERROR_CODES.sessionNotFound, "Analysis session was not found.");
  else if (result === "busy") writeError(ctx, res, 409, ANALYSIS_ERROR_CODES.sessionBusy, "Analysis session is busy.");
  else ctx.host.http.writeJson(res, 200, { accepted: true });
  return true;
}

function handleStream(ctx: FleetPluginServerContext, req: http.IncomingMessage, res: http.ServerResponse, operationId: string, registry: AnalysisRegistry): boolean {
  if (req.method !== "GET") return methodNotAllowed(ctx, res);
  let closed = false;
  const write = (data: string) => { if (!closed && !res.writableEnded && !res.destroyed) res.write(data); };
  res.writeHead(200, securityHeaders({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" }));
  write(": connected\n\n");
  const unsubscribe = registry.subscribe(operationId, (event) => write(`data: ${JSON.stringify(event)}\n\n`));
  if (!unsubscribe) { write(`data: ${JSON.stringify(analysisError(ANALYSIS_ERROR_CODES.sessionNotFound, "Analysis session was not found."))}\n\n`); res.end(); return true; }
  const keepalive = setInterval(() => write(": keepalive\n\n"), 30_000);
  req.on("close", () => { closed = true; clearInterval(keepalive); unsubscribe(); });
  return true;
}

async function handleStop(ctx: FleetPluginServerContext, req: http.IncomingMessage, res: http.ServerResponse, operationId: string, registry: AnalysisRegistry): Promise<boolean> {
  if (req.method !== "POST") return methodNotAllowed(ctx, res);
  if (!isJsonRequest(req)) return unsupportedMediaType(ctx, res);
  const body = await ctx.host.http.readJsonBody(req);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0) { writeError(ctx, res, 400, ANALYSIS_ERROR_CODES.catalogInvalid, "Analysis stop request is invalid."); return true; }
  await registry.stop(operationId);
  ctx.host.http.writeJson(res, 200, { stopped: true });
  return true;
}

function getAgentOperation(ctx: FleetPluginServerContext, operationId: string): OperationNode | null {
  const operation = ctx.host.operations.get(operationId);
  return operation?.pluginId === ctx.pluginId && operation.type === AGENT_OPERATION_TYPE ? operation : null;
}
function toBrowserEvent(event: AnalystEvent): AnalysisEvent {
  if (event.type !== "artifact") return event;
  const createdAt = Date.parse(event.artifact.createdAt);
  return { ...event, artifact: { ...event.artifact, createdAt: Number.isFinite(createdAt) ? createdAt : 0 } };
}
function methodNotAllowed(ctx: FleetPluginServerContext, res: http.ServerResponse): true { ctx.host.http.writeJson(res, 405, analysisError(ANALYSIS_ERROR_CODES.catalogInvalid, "Method not allowed.")); return true; }
function unsupportedMediaType(ctx: FleetPluginServerContext, res: http.ServerResponse): true { ctx.host.http.writeJson(res, 415, analysisError(ANALYSIS_ERROR_CODES.catalogInvalid, "Content-Type must be application/json.")); return true; }
function writeError(ctx: FleetPluginServerContext, res: http.ServerResponse, status: number, code: keyof typeof ANALYSIS_ERROR_CODES extends never ? never : (typeof ANALYSIS_ERROR_CODES)[keyof typeof ANALYSIS_ERROR_CODES], message: string): void { ctx.host.http.writeJson(res, status, analysisError(code, message)); }
function isJsonRequest(req: http.IncomingMessage): boolean { return req.headers["content-type"]?.split(";", 1)[0] === "application/json"; }
function isOperationDeletedEvent(value: unknown): value is { readonly operationId: string; readonly pluginId: string } { return !!value && typeof value === "object" && typeof (value as { operationId?: unknown }).operationId === "string" && typeof (value as { pluginId?: unknown }).pluginId === "string"; }
function securityHeaders(headers: Record<string, string>): Record<string, string> { return { ...headers, "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Resource-Policy": "same-origin", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" }; }
