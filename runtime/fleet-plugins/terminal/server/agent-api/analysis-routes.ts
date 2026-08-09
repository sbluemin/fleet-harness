import type http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";

import { resolveAiGatewaySelection, type AiGatewayStoredSettings } from "@dotobokuri/core-ai-gateway";
import { AnalystSession, type AnalystEvent } from "@dotobokuri/fleet-analyst";
import type { FleetPluginServerContext, OperationNode } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";

import { AnalysisRegistry } from "./analysis-registry.js";
import { ANALYSIS_ERROR_CODES, analysisError, buildAnalysisCatalog, nativeClaudeAnalystModels, isAnalysisSelection, isMessageBody, resolveAnalysisGatewayBaseUrl, type AnalysisCatalog, type AnalysisEvent } from "./analysis-types.js";
import { readAnalysisProviderSession } from "./provider-session.js";

const AGENT_OPERATION_TYPE = "agent";
const OPERATION_DELETED_EVENT_CHANNEL = "operation:deleted";
const OPERATION_PURGED_EVENT_CHANNEL = "operation:purged";
export const ANALYSIS_ARTIFACT_CSP = "sandbox allow-scripts; default-src 'self' data: blob: https: http:; script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https: http:; style-src 'self' 'unsafe-inline' data: blob: https: http:; img-src 'self' data: blob: https: http:; font-src 'self' data: blob: https: http:; connect-src *; frame-src 'self' data: blob: https: http:; media-src 'self' data: blob: https: http:; worker-src 'self' data: blob:; frame-ancestors 'self'";
const ANALYSIS_ARTIFACT_THEMES = new Set(["instrument", "maritime", "carbon", "whites"]);
const ANALYSIS_ARTIFACT_LIGHT_THEMES = new Set(["whites"]);
const SAFE_ARTIFACT_COLOR = /^(?:#[\da-f]{3,8}|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\([\d.e%+\-/, ]{1,96}\)|Canvas|CanvasText)$/i;
const ARTIFACT_CANVAS_STYLE_PROPERTIES = new Set(["background-color", "background-image", "color", "min-height", "color-scheme"]);
const ARTIFACT_BODY_CANVAS_STYLE_PROPERTIES = new Set([...ARTIFACT_CANVAS_STYLE_PROPERTIES, "margin"]);

type AnalysisSessionOptions = ConstructorParameters<typeof AnalystSession>[0];

type AnalysisRouteDeps = {
  readonly createSession?: (options: AnalysisSessionOptions) => AnalystSession;
  /** 사용자가 Console에서 켠 게이트웨이 모델 선별. 미주입이면 분석가를 시작할 수 없다. */
  readonly readAiGatewaySettings?: () => AiGatewayStoredSettings;
  /** 분석가가 고를 수 있는 네이티브 Claude 별칭의 출처. */
  /** 분석가가 고를 수 있는 native Claude 별칭. */
  readonly nativeModels?: typeof nativeClaudeAnalystModels;
};

type InFlightStartDeletionMarker = {
  readonly operationId: string;
  deleted: boolean;
};

export function registerAnalysisRoutes(ctx: FleetPluginServerContext, deps: AnalysisRouteDeps = {}): void {
  const registry = new AnalysisRegistry();
  const createSession = deps.createSession ?? ((options) => new AnalystSession(options));
  const readAiGatewaySettings = deps.readAiGatewaySettings;
  // 분석가가 쓸 수 있는 모델은 사용자가 켠 선별이고, 시작 가능 여부는 Console이 리슨 중인지에
  // 달렸다. 등록 시점에 고정하면 이후 설정 변경이 카탈로그에 반영되지 않는다.
  const nativeModels = deps.nativeModels ?? nativeClaudeAnalystModels;
  const catalog = async (): Promise<AnalysisCatalog> => buildAnalysisCatalog(
    nativeModels(),
    readAiGatewaySettings ? resolveAiGatewaySelection(readAiGatewaySettings()).models : [],
    ctx.host.server.origin() !== null,
  );
  const inFlightStartDeletionMarkers = new Set<InFlightStartDeletionMarker>();

  registerRouter(ctx, "analysis", async ({ req, res, pathname }) => {
    // 어느 리스너의 Host 경계인지는 호스트만 안다.
    if (!ctx.host.security.validateHost(req) || !ctx.host.security.isTerminalAuthorized(req)) {
      writeError(ctx, res, 403, ANALYSIS_ERROR_CODES.catalogInvalid, "Analysis request is not accepted by this host.");
      return true;
    }
    const path = pathname.slice(`${ctx.basePath}/analysis`.length) || "/";
    if (path === "/catalog") return handleCatalog(ctx, req, res, catalog);
    if (path === "/stream") return handleGlobalStream(ctx, req, res, registry);
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
    if (action === "ready") return handleReady(ctx, req, res, operation);
    if (action === "start") {
      const deletionMarker: InFlightStartDeletionMarker = { operationId, deleted: false };
      inFlightStartDeletionMarkers.add(deletionMarker);
      try {
        return await handleStart(ctx, req, res, operation, registry, catalog, createSession, deletionMarker);
      } finally {
        inFlightStartDeletionMarkers.delete(deletionMarker);
      }
    }
    if (action === "message") return handleMessage(ctx, req, res, operationId, registry);
    if (action === "stream") return handleStream(ctx, req, res, operationId, registry);
    return handleStop(ctx, req, res, operationId, registry);
  });

  const unsubscribeDelete = ctx.host.events.subscribe(OPERATION_DELETED_EVENT_CHANNEL, (payload) => {
    if (isOperationDeletedEvent(payload) && payload.pluginId === ctx.pluginId) {
      for (const marker of inFlightStartDeletionMarkers) {
        if (marker.operationId === payload.operationId) marker.deleted = true;
      }
      void registry.stop(payload.operationId);
    }
  });
  const unsubscribePurge = ctx.host.events.subscribe(OPERATION_PURGED_EVENT_CHANNEL, (payload) => {
    if (isOperationDeletedEvent(payload) && payload.pluginId === ctx.pluginId) {
      registry.clearArtifacts(payload.operationId);
    }
  });
  ctx.host.lifecycle.registerCleanup(async () => { unsubscribeDelete(); unsubscribePurge(); await registry.dispose(); });
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
  const surface = safeArtifactColor(query.get("surface"), canvas);
  const hairline = safeArtifactColor(query.get("hairline"), foreground);
  const accent = safeArtifactColor(query.get("accent"), foreground);
  const muted = safeArtifactColor(query.get("muted"), foreground);
  const canvasStyle = `background-color:${canvas}!important;background-image:none!important;color:${foreground}!important;min-height:100%!important;color-scheme:${ANALYSIS_ARTIFACT_LIGHT_THEMES.has(theme) ? "light" : "dark"}!important;`;
  const baseStylesheet = `<style>:root{--fleet-canvas:${canvas};--fleet-surface:${surface};--fleet-ink:${foreground};--fleet-muted:${muted};--fleet-hairline:${hairline};--fleet-accent:${accent}}a{color:var(--fleet-accent)}code{background:var(--fleet-surface);border:1px solid var(--fleet-hairline);border-radius:4px;padding:0 .3em}pre{background:var(--fleet-surface);border:1px solid var(--fleet-hairline);border-radius:8px;padding:12px;overflow-x:auto}pre code{background:none;border:none;padding:0}blockquote{border-left:3px solid var(--fleet-hairline);color:var(--fleet-muted);margin-left:0;padding-left:1em}hr{border:none;border-top:1px solid var(--fleet-hairline)}th,td{border-color:var(--fleet-hairline)}::selection{background:var(--fleet-accent);color:var(--fleet-canvas)}</style>`;
  const documentTags = findArtifactDocumentTags(html);
  if (documentTags) {
    const htmlTag = withArtifactAttribute(withArtifactAttribute(documentTags.htmlTag.source, "data-theme", theme), "style", canvasStyle, ARTIFACT_CANVAS_STYLE_PROPERTIES);
    const bodyTag = withArtifactAttribute(documentTags.bodyTag.source, "style", `${canvasStyle}margin:0!important;`, ARTIFACT_BODY_CANVAS_STYLE_PROPERTIES);
    // 베이스 시트는 항상 재작성된 <html> 시작 태그 직후에 둔다 — 파서가 head로 hoist하므로
    // <template> 안의 가짜 <head> 같은 decoy가 주입을 삼키는 경로가 성립하지 않는다.
    return `${html.slice(0, documentTags.htmlTag.start)}${htmlTag}${baseStylesheet}${html.slice(documentTags.htmlTag.end, documentTags.bodyTag.start)}${bodyTag}${html.slice(documentTags.bodyTag.end)}`;
  }
  return `<!doctype html><html data-theme="${theme}" style="${canvasStyle}"><head>${baseStylesheet}</head><body style="${canvasStyle}margin:0!important;">${html}</body></html>`;
}

type HtmlStartTag = { readonly start: number; readonly end: number; readonly source: string };

function findArtifactDocumentTags(html: string): { readonly htmlTag: HtmlStartTag; readonly bodyTag: HtmlStartTag } | null {
  let index = html.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (index < html.length) {
    while (/\s/.test(html[index] ?? "")) index += 1;
    if (html.startsWith("<!--", index)) {
      const commentEnd = html.indexOf("-->", index + 4);
      if (commentEnd < 0) return null;
      index = commentEnd + 3;
      continue;
    }
    if (html[index] === "<" && (html[index + 1] === "!" || html[index + 1] === "?")) {
      const declarationEnd = findHtmlTagEnd(html, index + 2);
      if (declarationEnd < 0) return null;
      index = declarationEnd;
      continue;
    }
    break;
  }

  const htmlTag = readHtmlStartTag(html, index);
  if (!htmlTag || htmlTag.name !== "html") return null;
  index = htmlTag.tag.end;
  while (index < html.length) {
    const tagStart = html.indexOf("<", index);
    if (tagStart < 0) return null;
    if (html.startsWith("<!--", tagStart)) {
      const commentEnd = html.indexOf("-->", tagStart + 4);
      if (commentEnd < 0) return null;
      index = commentEnd + 3;
      continue;
    }
    const tag = readHtmlStartTag(html, tagStart);
    if (!tag) {
      const tagEnd = findHtmlTagEnd(html, tagStart + 1);
      if (tagEnd < 0) return null;
      index = tagEnd;
      continue;
    }
    if (tag.name === "body") return { htmlTag: htmlTag.tag, bodyTag: tag.tag };
    index = tag.tag.end;
    if (tag.name === "script" || tag.name === "style" || tag.name === "title" || tag.name === "textarea") {
      const closeStart = html.toLowerCase().indexOf(`</${tag.name}`, index);
      if (closeStart < 0) return null;
      const closeEnd = findHtmlTagEnd(html, closeStart + tag.name.length + 2);
      if (closeEnd < 0) return null;
      index = closeEnd;
    }
  }
  return null;
}

function readHtmlStartTag(html: string, start: number): { readonly name: string; readonly tag: HtmlStartTag } | null {
  if (html[start] !== "<" || html[start + 1] === "/" || html[start + 1] === "!" || html[start + 1] === "?") return null;
  let nameEnd = start + 1;
  while (/[A-Za-z0-9:-]/.test(html[nameEnd] ?? "")) nameEnd += 1;
  if (nameEnd === start + 1 || !/[\s/>]/.test(html[nameEnd] ?? "")) return null;
  const end = findHtmlTagEnd(html, nameEnd);
  if (end < 0) return null;
  return { name: html.slice(start + 1, nameEnd).toLowerCase(), tag: { start, end, source: html.slice(start, end) } };
}

function findHtmlTagEnd(html: string, from: number): number {
  let quote = "";
  for (let index = from; index < html.length; index += 1) {
    const character = html[index] ?? "";
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index + 1;
    }
  }
  return -1;
}

function withArtifactAttribute(tag: string, attributeName: "data-theme" | "style", value: string, replacedStyleProperties?: ReadonlySet<string>): string {
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  let index = 1;
  while (/[A-Za-z0-9:-]/.test(tag[index] ?? "")) index += 1;
  while (index < tag.length - 1) {
    while (/\s/.test(tag[index] ?? "")) index += 1;
    if (tag[index] === "/" || tag[index] === ">") break;
    const nameStart = index;
    while (!/[\s=/>]/.test(tag[index] ?? ">")) index += 1;
    const nameEnd = index;
    while (/\s/.test(tag[index] ?? "")) index += 1;
    let attributeEnd = nameEnd;
    let currentValue = "";
    if (tag[index] === "=") {
      index += 1;
      while (/\s/.test(tag[index] ?? "")) index += 1;
      const quote = tag[index] === '"' || tag[index] === "'" ? tag[index++] : "";
      const valueStart = index;
      if (quote) {
        while (index < tag.length - 1 && tag[index] !== quote) index += 1;
        currentValue = tag.slice(valueStart, index);
        if (tag[index] === quote) index += 1;
      } else {
        while (!/[\s>]/.test(tag[index] ?? ">")) index += 1;
        currentValue = tag.slice(valueStart, index);
      }
      attributeEnd = index;
    }
    if (tag.slice(nameStart, nameEnd).toLowerCase() === attributeName) {
      const preservedStyle = replacedStyleProperties ? withoutArtifactCanvasDeclarations(currentValue, replacedStyleProperties) : "";
      const nextValue = replacedStyleProperties && preservedStyle.length > 0
        ? `${preservedStyle}${preservedStyle.trimEnd().endsWith(";") ? "" : ";"}${value}`
        : value;
      replacements.push({ start: nameStart, end: attributeEnd, value: `${tag.slice(nameStart, nameEnd)}="${nextValue.replaceAll('"', "&quot;")}"` });
    }
  }
  if (replacements.length === 0) {
    const insertAt = tag.search(/\s*\/?\s*>$/);
    return `${tag.slice(0, insertAt)} ${attributeName}="${value}"${tag.slice(insertAt)}`;
  }
  let result = tag;
  for (const replacement of replacements.reverse()) {
    result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`;
  }
  return result;
}

function withoutArtifactCanvasDeclarations(style: string, replacedProperties: ReadonlySet<string>): string {
  let result = "";
  let segmentStart = 0;
  let quote = "";
  let escaped = false;
  let comment = false;
  let nesting = 0;
  for (let index = 0; index <= style.length; index += 1) {
    const character = style[index] ?? "";
    const next = style[index + 1] ?? "";
    const encodedQuote = readHtmlEncodedQuote(style, index);
    if (comment) {
      if (character === "*" && next === "/") { comment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      else if (encodedQuote?.quote === quote) { quote = ""; index += encodedQuote.length - 1; }
      continue;
    }
    if (character === "/" && next === "*") { comment = true; index += 1; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (encodedQuote) { quote = encodedQuote.quote; index += encodedQuote.length - 1; continue; }
    if (character === "(" || character === "[" || character === "{") { nesting += 1; continue; }
    if (character === ")" || character === "]" || character === "}") { nesting = Math.max(0, nesting - 1); continue; }
    if ((character === ";" && nesting === 0) || index === style.length) {
      const segmentEnd = character === ";" ? index + 1 : index;
      const segment = style.slice(segmentStart, segmentEnd);
      if (!replacedProperties.has(cssDeclarationName(segment))) result += segment;
      segmentStart = segmentEnd;
    }
  }
  return result;
}

function cssDeclarationName(declaration: string): string {
  let comment = false;
  for (let index = 0; index < declaration.length; index += 1) {
    if (comment) {
      if (declaration[index] === "*" && declaration[index + 1] === "/") { comment = false; index += 1; }
    } else if (declaration[index] === "/" && declaration[index + 1] === "*") {
      comment = true;
      index += 1;
    } else if (declaration[index] === ":") {
      return declaration.slice(0, index).replace(/\/\*[\s\S]*?\*\//g, "").trim().toLowerCase();
    }
  }
  return "";
}

function readHtmlEncodedQuote(value: string, index: number): { readonly quote: string; readonly length: number } | null {
  const match = value.slice(index).match(/^&(?:quot|#0*34|#x0*22);/i);
  if (match) return { quote: '"', length: match[0].length };
  const apostropheMatch = value.slice(index).match(/^&(?:apos|#0*39|#x0*27);/i);
  return apostropheMatch ? { quote: "'", length: apostropheMatch[0].length } : null;
}

function safeArtifactTheme(value: string | null): string {
  return value !== null && ANALYSIS_ARTIFACT_THEMES.has(value) ? value : "instrument";
}

function safeArtifactColor(value: string | null, fallback: string): string {
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

async function handleReady(ctx: FleetPluginServerContext, req: http.IncomingMessage, res: http.ServerResponse, operation: OperationNode): Promise<boolean> {
  if (req.method !== "GET") return methodNotAllowed(ctx, res);
  try {
    const { transcriptPath } = await resolveOperationTranscript(operation);
    ctx.host.http.writeJson(res, 200, { ready: transcriptPath !== null });
  } catch {
    ctx.host.http.writeJson(res, 200, { ready: false });
  }
  return true;
}

async function handleStart(
  ctx: FleetPluginServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  operation: OperationNode,
  registry: AnalysisRegistry,
  catalog: () => Promise<AnalysisCatalog>,
  createSession: (options: AnalysisSessionOptions) => AnalystSession,
  deletionMarker: InFlightStartDeletionMarker,
): Promise<boolean> {
  if (req.method !== "POST") return methodNotAllowed(ctx, res);
  if (!isJsonRequest(req)) return unsupportedMediaType(ctx, res);
  const body = await ctx.host.http.readJsonBody(req);
  const currentCatalog = await catalog();
  if (!isAnalysisSelection(currentCatalog, body)) {
    writeError(ctx, res, 400, ANALYSIS_ERROR_CODES.catalogInvalid, "Analysis selection is unavailable.");
    return true;
  }
  const transcript = await resolveOperationTranscript(operation);
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
  if (deletionMarker.deleted || !getAgentOperation(ctx, operation.id)) {
    writeError(ctx, res, 404, ANALYSIS_ERROR_CODES.sessionNotFound, "Analysis operation was not found.");
    return true;
  }
  try {
    const origin = ctx.host.server.origin();
    // 포트를 추측해 띄우면 자식이 첫 턴에서야 알 수 없는 이유로 죽는다.
    if (!origin) throw new Error("analysis_gateway_unavailable");
    const result = await registry.start(operation.id, (onEvent) => createSession({
      baseUrl: resolveAnalysisGatewayBaseUrl(origin),
      model: body.model,
      effort: body.effort || undefined,
      language: body.language,
      cwd,
      capturePath: transcriptPath,
      onEvent: (event: AnalystEvent) => onEvent(toBrowserEvent(event)),
    }));
    if (result === "exists") writeError(ctx, res, 409, ANALYSIS_ERROR_CODES.sessionExists, "Analysis session already exists.");
    else if (result === "stopped") writeError(ctx, res, 404, ANALYSIS_ERROR_CODES.sessionNotFound, "Analysis session was stopped before it started.");
    else ctx.host.http.writeJson(res, 200, { started: true });
  } catch {
    if (deletionMarker.deleted) writeError(ctx, res, 404, ANALYSIS_ERROR_CODES.sessionNotFound, "Analysis session was stopped before it started.");
    else writeError(ctx, res, 503, ANALYSIS_ERROR_CODES.catalogInvalid, "Analysis session could not start.");
  }
  return true;
}

async function resolveOperationTranscript(operation: OperationNode): Promise<{ readonly captureFound: boolean; readonly transcriptPath: string | null }> {
  const providerSession = readAnalysisProviderSession(operation.payload?.providerSession);
  if (!providerSession) return { captureFound: false, transcriptPath: null };
  const transcriptPath = providerSession.transcriptPath
    ? await resolveTranscriptPath(providerSession.transcriptPath, operation.ts.createdAt)
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

function handleGlobalStream(ctx: FleetPluginServerContext, req: http.IncomingMessage, res: http.ServerResponse, registry: AnalysisRegistry): boolean {
  if (req.method !== "GET") return methodNotAllowed(ctx, res);
  let closed = false;
  const write = (data: string) => { if (!closed && !res.writableEnded && !res.destroyed) res.write(data); };
  const writeRoster = (operationIds: readonly string[]) => {
    write(`data: ${JSON.stringify({ type: "connected", operationIds: [...operationIds] })}\n\n`);
  };
  res.writeHead(200, securityHeaders({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" }));
  writeRoster(registry.activeOperationIds());
  const unsubscribeEvents = registry.subscribeAll((operationId, event) => {
    write(`data: ${JSON.stringify({ type: "event", operationId, event })}\n\n`);
  });
  const unsubscribeRoster = registry.subscribeRoster((operationIds) => writeRoster(operationIds));
  const keepalive = setInterval(() => write(": keepalive\n\n"), 30_000);
  req.on("close", () => {
    closed = true;
    clearInterval(keepalive);
    unsubscribeEvents();
    unsubscribeRoster();
  });
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
function isJsonRequest(req: http.IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().split(";")[0]?.trim() === "application/json";
}
function isOperationDeletedEvent(value: unknown): value is { readonly operationId: string; readonly pluginId: string } { return !!value && typeof value === "object" && typeof (value as { operationId?: unknown }).operationId === "string" && typeof (value as { pluginId?: unknown }).pluginId === "string"; }
function securityHeaders(headers: Record<string, string>): Record<string, string> { return { ...headers, "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Resource-Policy": "same-origin", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" }; }
function artifactHeaders(): Record<string, string> { return { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": ANALYSIS_ARTIFACT_CSP, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" }; }
