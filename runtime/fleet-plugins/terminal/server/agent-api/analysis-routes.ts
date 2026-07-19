import type http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";

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
export const ANALYSIS_ARTIFACT_CSP = "sandbox allow-scripts; default-src 'self' data: blob: https: http:; script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https: http:; style-src 'self' 'unsafe-inline' data: blob: https: http:; img-src 'self' data: blob: https: http:; font-src 'self' data: blob: https: http:; connect-src *; frame-src 'self' data: blob: https: http:; media-src 'self' data: blob: https: http:; worker-src 'self' data: blob:; frame-ancestors 'self'";
const ANALYSIS_ARTIFACT_THEMES = new Set(["instrument", "maritime", "carbon"]);
const SAFE_ARTIFACT_COLOR = /^(?:#[\da-f]{3,8}|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\([\d.e%+\-/, ]{1,96}\)|Canvas|CanvasText)$/i;

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
    if (!localPort || !ctx.host.security.validateHost(req, localPort) || !ctx.host.security.isTerminalAuthorized(req)) {
      writeError(ctx, res, 403, ANALYSIS_ERROR_CODES.catalogInvalid, "Analysis request is not accepted by this host.");
      return true;
    }
    const path = pathname.slice(`${ctx.basePath}/analysis`.length) || "/";
    if (path === "/catalog") return handleCatalog(ctx, req, res, catalog);
    const artifactMatch = path.match(/^\/artifacts\/([^/]+)$/);
    if (artifactMatch) return handleArtifact(ctx, req, res, decodeURIComponent(artifactMatch[1] ?? ""), registry);
    const clearArtifactsMatch = path.match(/^\/([^/]+)\/artifacts$/);
    if (clearArtifactsMatch) return handleClearArtifacts(ctx, req, res, decodeURIComponent(clearArtifactsMatch[1] ?? ""), registry);
    const match = path.match(/^\/([^/]+)\/(ready|start|message|stream|stop)$/);
    if (!match) return false;
    const operationId = decodeURIComponent(match[1] ?? "");
    const action = match[2] ?? "";
    const operation = getAgentOperation(ctx, operationId);
    if (!operation) {
      writeError(ctx, res, 404, ANALYSIS_ERROR_CODES.sessionNotFound, "Analysis operation was not found.");
      return true;
    }
    if (action === "ready") return handleReady(ctx, req, res, operation, readCapture);
    if (action === "start") return handleStart(ctx, req, res, operation, registry, catalog, readCapture, createSession);
    if (action === "message") return handleMessage(ctx, req, res, operationId, registry);
    if (action === "stream") return handleStream(ctx, req, res, operationId, registry);
    return handleStop(ctx, req, res, operationId, registry);
  });

  const unsubscribeDelete = ctx.host.events.subscribe(OPERATION_DELETED_EVENT_CHANNEL, (payload) => {
    if (isOperationDeletedEvent(payload) && payload.pluginId === ctx.pluginId) {
      registry.clearArtifacts(payload.operationId);
      void registry.stop(payload.operationId);
    }
  });
  ctx.host.lifecycle.registerCleanup(async () => { unsubscribeDelete(); await registry.dispose(); });
}

async function handleCatalog(ctx: FleetPluginServerContext, req: http.IncomingMessage, res: http.ServerResponse, catalog: () => Promise<AnalysisCatalog>): Promise<boolean> {
  if (req.method !== "GET") return methodNotAllowed(ctx, res);
  ctx.host.http.writeJson(res, 200, await catalog());
  return true;
}

function handleArtifact(ctx: FleetPluginServerContext, req: http.IncomingMessage, res: http.ServerResponse, artifactId: string, registry: AnalysisRegistry): boolean {
  if (req.method !== "GET") return methodNotAllowed(ctx, res);
  const html = registry.artifactHtml(artifactId);
  if (html === null) {
    writeError(ctx, res, 404, ANALYSIS_ERROR_CODES.sessionNotFound, "Analysis artifact was not found.");
    return true;
  }
  res.writeHead(200, artifactHeaders());
  res.end(artifactDocument(html, req.url));
  return true;
}

function artifactDocument(html: string, requestUrl: string | undefined): string {
  const query = new URL(requestUrl ?? "/", "http://fleet.invalid").searchParams;
  const theme = safeArtifactTheme(query.get("theme"));
  const canvas = safeArtifactColor(query.get("canvas"), "Canvas");
  const foreground = safeArtifactColor(query.get("foreground"), "CanvasText");
  const canvasStyle = `background-color:${canvas}!important;background-image:none!important;color:${foreground}!important;min-height:100%!important;color-scheme:dark!important;`;
  return `<!doctype html><html data-theme="${theme}" style="${canvasStyle}"><head></head><body style="${canvasStyle}margin:0!important;">${html}</body></html>`;
}

function safeArtifactTheme(value: string | null): string {
  return value !== null && ANALYSIS_ARTIFACT_THEMES.has(value) ? value : "instrument";
}

function safeArtifactColor(value: string | null, fallback: "Canvas" | "CanvasText"): string {
  return value !== null && value.length <= 100 && SAFE_ARTIFACT_COLOR.test(value) ? value : fallback;
}

function handleClearArtifacts(ctx: FleetPluginServerContext, req: http.IncomingMessage, res: http.ServerResponse, operationId: string, registry: AnalysisRegistry): boolean {
  if (req.method !== "DELETE") return methodNotAllowed(ctx, res);
  if (!getAgentOperation(ctx, operationId)) {
    writeError(ctx, res, 404, ANALYSIS_ERROR_CODES.sessionNotFound, "Analysis operation was not found.");
    return true;
  }
  registry.clearArtifacts(operationId);
  ctx.host.http.writeJson(res, 200, { cleared: true });
  return true;
}

async function handleReady(ctx: FleetPluginServerContext, req: http.IncomingMessage, res: http.ServerResponse, operation: OperationNode, readCapture: typeof readProviderSessionCapture): Promise<boolean> {
  if (req.method !== "GET") return methodNotAllowed(ctx, res);
  try {
    const { transcriptPath } = await resolveOperationTranscript(ctx, operation, readCapture);
    ctx.host.http.writeJson(res, 200, { ready: transcriptPath !== null });
  } catch {
    ctx.host.http.writeJson(res, 200, { ready: false });
  }
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
  const transcript = await resolveOperationTranscript(ctx, operation, readCapture);
  if (!transcript.captureFound) {
    writeError(ctx, res, 409, ANALYSIS_ERROR_CODES.captureMissing, "Analysis capture is unavailable.");
    return true;
  }
  const transcriptPath = transcript.transcriptPath;
  if (!transcriptPath) {
    writeError(ctx, res, 409, ANALYSIS_ERROR_CODES.transcriptMissing, "No transcript yet — send a message in this session first, then ask again.");
    return true;
  }
  const cwd = ctx.host.paths.resolveTheaterPath(operation.theaterId);
  if (!cwd) {
    writeError(ctx, res, 404, ANALYSIS_ERROR_CODES.sessionNotFound, "Analysis operation was not found.");
    return true;
  }
  try {
    const result = await registry.start(operation.id, (onEvent) => createSession({ cliId: body.cliId, model: body.model, effort: body.effort || undefined, cwd, capturePath: transcriptPath, onEvent: (event: AnalystEvent) => onEvent(toBrowserEvent(event)) }));
    if (result === "exists") writeError(ctx, res, 409, ANALYSIS_ERROR_CODES.sessionExists, "Analysis session already exists.");
    else if (result === "limit") writeError(ctx, res, 429, ANALYSIS_ERROR_CODES.sessionLimit, "Analysis session limit reached.");
    else if (result === "stopped") writeError(ctx, res, 404, ANALYSIS_ERROR_CODES.sessionNotFound, "Analysis session was stopped before it started.");
    else ctx.host.http.writeJson(res, 200, { started: true });
  } catch {
    writeError(ctx, res, 503, ANALYSIS_ERROR_CODES.catalogInvalid, "Analysis session could not start.");
  }
  return true;
}

async function resolveOperationTranscript(ctx: FleetPluginServerContext, operation: OperationNode, readCapture: typeof readProviderSessionCapture): Promise<{ readonly captureFound: boolean; readonly transcriptPath: string | null }> {
  const capture = readCapture(operation.id, { capturesDir: ctx.host.paths.capturesDir });
  if (!capture) return { captureFound: false, transcriptPath: null };
  const transcriptPath = capture.transcriptPath
    ? await resolveTranscriptPath(capture.transcriptPath, operation.ts.createdAt)
    : null;
  return { captureFound: true, transcriptPath };
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
  write(`data: ${JSON.stringify({ type: "connected" } satisfies AnalysisEvent)}\n\n`);
  const unsubscribe = registry.subscribe(operationId, (event) => write(`data: ${JSON.stringify(event)}\n\n`));
  if (!unsubscribe) { write(`data: ${JSON.stringify({ type: "error", error: { code: ANALYSIS_ERROR_CODES.sessionNotFound, message: "Analysis session was not found." } } satisfies AnalysisEvent)}\n\n`); res.end(); return true; }
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

// Claude Code는 SessionStart 훅 시점의 세션 ID로 캡처를 남기지만, 실제 대화 트랜스크립트는
// 다른 세션 ID 파일로 기록될 수 있다. 캡처 경로가 비어 있으면 같은 프로젝트 디렉터리에서
// 이 Operation이 만들어진 이후에 생성된(birthtime) 트랜스크립트가 정확히 하나일 때만 폴백한다 —
// 같은 프로젝트에서 동시 진행 중인 다른 세션(예: 별개 CLI 세션)의 파일을 집지 않기 위한 경계다.
// birthtime을 못 주는 파일시스템(0 이하)은 후보에 포함하되, 역시 단일 후보여야 한다.
async function resolveTranscriptPath(capturePath: string, operationCreatedAt: number): Promise<string | null> {
  if (await fileExists(capturePath)) return capturePath;
  const dir = path.dirname(capturePath);
  const bornCutoff = operationCreatedAt - 60_000;
  try {
    const entries = await fs.readdir(dir);
    const candidates: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const candidate = path.join(dir, entry);
      const stat = await fs.stat(candidate).catch(() => null);
      if (!stat?.isFile()) continue;
      if (stat.birthtimeMs > 0 && stat.birthtimeMs < bornCutoff) continue;
      candidates.push(candidate);
      if (candidates.length > 1) return null;
    }
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  const stat = await fs.stat(filePath).catch(() => null);
  return stat?.isFile() ?? false;
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
function artifactHeaders(): Record<string, string> { return { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": ANALYSIS_ARTIFACT_CSP, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" }; }
