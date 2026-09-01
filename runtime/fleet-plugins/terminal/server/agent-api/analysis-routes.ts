import type http from "node:http";

import { resolveAiGatewaySelection, type AiGatewayStoredSettings } from "@dotobokuri/core-ai-gateway";
import { AnalystSession, type AnalystEvent } from "@dotobokuri/fleet-analyst";
import type { FleetPluginServerContext, OperationNode } from "@fleet-console/sdk/plugin";
import { registerRouter } from "@fleet-console/sdk/plugin/node";

import { AnalysisRegistry } from "./analysis-registry.js";
import { ANALYSIS_ERROR_CODES, analysisError, buildAnalysisCatalog, nativeClaudeAnalystModels, isAnalysisSelection, isMessageBody, resolveAnalysisGatewayBaseUrl, type AnalysisCatalog, type AnalysisEvent } from "./analysis-types.js";
import { readAnalysisProviderSession } from "./provider-session.js";
import { resolveTranscriptPath } from "./transcript-path.js";

const AGENT_OPERATION_TYPE = "agent";
const OPERATION_DELETED_EVENT_CHANNEL = "operation:deleted";
const OPERATION_PURGED_EVENT_CHANNEL = "operation:purged";
const ANALYSIS_ARTIFACT_CSP_DIRECTIVES = [
  "sandbox allow-scripts",
  `default-src 'self' data: blob:`,
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:`,
  `style-src 'self' 'unsafe-inline' data: blob:`,
  `img-src 'self' data: blob:`,
  `font-src 'self' data: blob:`,
  "connect-src 'none'",
  // form-action은 default-src로 폴백하지 않는다 — 빠뜨리면 내려받은 사본에서 폼 자동 제출이 열린다.
  "form-action 'none'",
  `frame-src 'self' data: blob:`,
  `media-src 'self' data: blob:`,
  `worker-src 'self' data: blob:`,
];

/**
 * 아티팩트 문서의 격리 정책.
 *
 * 아티팩트는 관찰 대상 세션의 신뢰할 수 없는 transcript에서 나온다. 인젝션이 심은 원격 참조
 * 하나면 미리보기가 바깥으로 요청을 보내 "이 세션이 분석 중"이라는 사실을 알린다. 그래서
 * 오프라인 보장은 프롬프트의 권고가 아니라 여기서 강제한다 — 원격 스킴은 전부 닫고, 인라인과
 * data:/blob:만 연다. `frame-ancestors`는 Console이 iframe으로 감쌀 수 있어야 하므로 남는다.
 */
export const ANALYSIS_ARTIFACT_CSP = `${ANALYSIS_ARTIFACT_CSP_DIRECTIVES.join("; ")}; frame-ancestors 'self'`;

/**
 * 내려받은 사본에는 응답 헤더가 따라가지 않으므로 같은 리소스 정책을 문서 안에 싣는다.
 *
 * 경계를 정확히 적어 둔다. 이 meta가 막는 것은 **리소스 로드와 폼 제출**이다 — 원격 이미지·폰트·
 * 스크립트·fetch, 그리고 form-action. 막지 못하는 것은 **문서 네비게이션**이다: CSP에는 top-level
 * 이동을 막는 지시어가 없고(`navigate-to`는 폐기됐다), meta는 `sandbox`를 실을 수 없다. 그래서
 * `<meta http-equiv="refresh">`나 인라인 스크립트의 `location` 할당은 내려받은 파일에서 여전히
 * 나갈 수 있다.
 *
 * 그걸 막으려면 내보낼 때 스크립트를 걷어내야 하는데, 인라인 `<script>`와 `<canvas>`는 아티팩트가
 * 지원하는 표현 수단이다. 완전한 격리가 필요한 표면은 미리보기이고 거기는 응답 헤더의 sandbox가
 * 전부 막는다. 내려받은 파일은 사용자가 스스로 저장하고 스스로 여는 로컬 문서이므로, 여기서는
 * 심층 방어까지가 몫이다.
 */
const ANALYSIS_ARTIFACT_META_CSP = `<meta http-equiv="Content-Security-Policy" content="${ANALYSIS_ARTIFACT_CSP_DIRECTIVES.filter((directive) => !directive.startsWith("sandbox")).join("; ")}">`;
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
  }, [
    { method: "GET", path: "/catalog", summary: "Read Analyst model catalog.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
    { method: "GET", path: "/stream", summary: "Stream all Analyst events.", category: "Terminal Plugin", gate: "origin-write", transport: "sse" },
    { method: "GET", path: "/artifacts/:artifactId", summary: "Read an Analyst artifact.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
    { method: "DELETE", path: "/:operationId/artifacts", summary: "Clear Analyst artifacts.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
    { method: "GET", path: "/:operationId/ready", summary: "Read Analyst readiness.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
    { method: "POST", path: "/:operationId/start", summary: "Start an Analyst session.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
    { method: "POST", path: "/:operationId/message", summary: "Send an Analyst message.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
    { method: "GET", path: "/:operationId/stream", summary: "Stream Analyst session events.", category: "Terminal Plugin", gate: "origin-write", transport: "sse" },
    { method: "POST", path: "/:operationId/stop", summary: "Stop an Analyst session.", category: "Terminal Plugin", gate: "origin-write", transport: "http" },
  ]);

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
  // v2 브리지는 콘솔 패널면 기준의 ground/card를 보낸다. 옛 이름(canvas/surface)은 내보내기·
  // 북마크로 살아남은 v1 URL의 폴백으로만 남는다 — v1은 ink-veil/ink-deep을 보냈으므로 그대로
  // 그리면 깊이 역전이 재현되지만, 최소한 색은 성립한다.
  const ground = safeArtifactColor(query.get("ground"), safeArtifactColor(query.get("canvas"), "Canvas"));
  const foreground = safeArtifactColor(query.get("foreground"), "CanvasText");
  const card = safeArtifactColor(query.get("card"), safeArtifactColor(query.get("surface"), ground));
  const inset = safeArtifactColor(query.get("inset"), ground);
  const hairline = safeArtifactColor(query.get("hairline"), foreground);
  const hairlineStrong = safeArtifactColor(query.get("hairlineStrong"), hairline);
  const accent = safeArtifactColor(query.get("accent"), foreground);
  const muted = safeArtifactColor(query.get("muted"), foreground);
  const faint = safeArtifactColor(query.get("faint"), muted);
  const positive = safeArtifactColor(query.get("positive"), foreground);
  const warn = safeArtifactColor(query.get("warn"), foreground);
  const critical = safeArtifactColor(query.get("critical"), foreground);
  const focus = safeArtifactColor(query.get("focus"), accent);
  const sansFont = safeArtifactFontPath(query.get("sansFont"));
  const monoFont = safeArtifactFontPath(query.get("monoFont"));
  const canvasStyle = `background-color:${ground}!important;background-image:none!important;color:${foreground}!important;min-height:100%!important;color-scheme:${ANALYSIS_ARTIFACT_LIGHT_THEMES.has(theme) ? "light" : "dark"}!important;`;
  const baseHead = `${ANALYSIS_ARTIFACT_META_CSP}${artifactBaseStylesheet({ ground, card, inset, foreground, muted, faint, hairline, hairlineStrong, accent, positive, warn, critical, focus, sansFont, monoFont })}`;
  const documentTags = findArtifactDocumentTags(html);
  if (documentTags) {
    const htmlTag = withArtifactAttribute(withArtifactAttribute(documentTags.htmlTag.source, "data-theme", theme), "style", canvasStyle, ARTIFACT_CANVAS_STYLE_PROPERTIES);
    const bodyTag = withArtifactAttribute(documentTags.bodyTag.source, "style", `${canvasStyle}margin:0!important;`, ARTIFACT_BODY_CANVAS_STYLE_PROPERTIES);
    // 베이스 시트는 항상 재작성된 <html> 시작 태그 직후에 둔다 — 파서가 head로 hoist하므로
    // <template> 안의 가짜 <head> 같은 decoy가 주입을 삼키는 경로가 성립하지 않는다.
    return `${html.slice(0, documentTags.htmlTag.start)}${htmlTag}${baseHead}${html.slice(documentTags.htmlTag.end, documentTags.bodyTag.start)}${bodyTag}${html.slice(documentTags.bodyTag.end)}`;
  }
  return `<!doctype html><html data-theme="${theme}" style="${canvasStyle}"><head>${baseHead}</head><body style="${canvasStyle}margin:0!important;">${html}</body></html>`;
}

/** 색과 무관한 조판 바닥 v2 — 토큰만 갈아끼우면 되도록 상수로 고정한다.
 *
 * v1과 달라진 방향: ① 페이지는 중앙 measure를 진다 — 전폭 드로어에서 본문이 좌측에 응집하지
 * 않도록 body의 직계 블록을 880px 컬럼으로 모은다(모델이 스스로 margin을 쥔 요소는 그 뜻이
 * 이긴다 — 바닥이지 감옥이 아니다). ② 섹션 머리는 색이 아니라 형태로 말한다 — h2는 조용한
 * 키커, 잉크·웨이트가 위계를 진다. accent는 링크·인용에만 남는다. ③ 면은 카드·인셋 두 층만
 * 쓴다 — 카드(fleet-card 계열)는 ground보다 한 단 들리고, 코드·웰은 한 단 가라앉는다. */
const ARTIFACT_BASE_RULES = [
  `*,*::before,*::after{box-sizing:border-box}`,
  `body{font-family:var(--fleet-sans);font-size:14px;line-height:1.65;letter-spacing:-.004em;-webkit-font-smoothing:antialiased;padding:30px clamp(20px,4.5vw,48px) 46px}`,
  `body>*{max-width:880px;margin-inline:auto}`,
  `h1,h3,h4,h5,h6{margin:1.6em 0 .5em;line-height:1.25;text-wrap:balance;letter-spacing:-.014em;font-weight:700;color:var(--fleet-ink)}`,
  `h1{font-size:1.42rem;margin-top:.2em}`,
  // 섹션 머리 = 키커: 모노 소형 대문자 + 오른쪽으로 사라지는 헤어라인. 색은 쓰지 않는다.
  `h2{display:flex;align-items:center;gap:10px;margin:2.1em 0 .75em;font-family:var(--fleet-mono);font-size:.74rem;font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:var(--fleet-muted)}`,
  `h2::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--fleet-hairline),transparent)}`,
  `h3{font-size:.98rem}`,
  `h4,h5,h6{font-size:.9rem}`,
  `:is(body,main,section,article,aside,li,td,th,details)>:first-child{margin-top:0}`,
  `p{margin:0 0 .85em}`,
  `p,li{max-width:72ch}`,
  `:is(td,th,figcaption) p{max-width:none}`,
  `ul,ol{margin:0 0 .95em;padding-left:1.3em}`,
  `li{margin:.3em 0}`,
  `strong,b{font-weight:650;color:var(--fleet-ink)}`,
  `small{font-size:.84em;color:var(--fleet-faint)}`,
  `a{color:var(--fleet-accent);text-underline-offset:2px}`,
  `img,svg,canvas{max-width:100%}`,
  `img{height:auto}`,
  `table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:.93em}`,
  `th{text-align:left;font-family:var(--fleet-mono);font-weight:500;font-size:.7rem;letter-spacing:.09em;text-transform:uppercase;color:var(--fleet-faint);padding:8px 12px;border-bottom:1px solid var(--fleet-hairline)}`,
  `td{padding:8px 12px;border-bottom:1px solid color-mix(in oklch,var(--fleet-hairline) 55%,transparent);vertical-align:top}`,
  `tr:last-child td{border-bottom:0}`,
  `td:first-child{color:var(--fleet-ink);font-weight:600}`,
  `code{font-family:var(--fleet-mono);font-size:.88em;background:var(--fleet-inset);border:1px solid var(--fleet-hairline);border-radius:4px;padding:.03em .32em}`,
  `pre{font-family:var(--fleet-mono);font-size:.86em;line-height:1.55;background:var(--fleet-inset);border:1px solid var(--fleet-hairline);border-radius:10px;padding:13px 15px;overflow-x:auto}`,
  `pre code{background:none;border:none;padding:0;font-size:1em}`,
  `blockquote{border-left:3px solid var(--fleet-hairline);color:var(--fleet-muted);margin-left:0;padding-left:1em}`,
  `hr{border:none;height:1px;background:linear-gradient(90deg,var(--fleet-hairline),transparent);margin:1.6em 0}`,
  // 증거 인용은 구조 정보다 — accent 틴트의 조용한 첨자 칩. accent가 남는 유일한 표면이다.
  `cite{display:inline-block;font-style:normal;font-family:var(--fleet-mono);font-size:.68em;line-height:1.4;vertical-align:.32em;color:var(--fleet-accent);background:color-mix(in oklch,var(--fleet-accent) 9%,transparent);border:1px solid color-mix(in oklch,var(--fleet-accent) 30%,var(--fleet-hairline));border-radius:4px;padding:0 4px;margin-left:4px;white-space:nowrap;text-decoration:none}`,
  `cite+cite{margin-left:2px}`,
  `details{border:1px solid var(--fleet-hairline);border-radius:10px;background:var(--fleet-card);padding:10px 13px;margin:0 0 .9em}`,
  `summary{cursor:pointer;font-weight:650;color:var(--fleet-ink)}`,
  `summary::marker{color:var(--fleet-faint)}`,
  // ── 호스트 제공 컴포넌트 — 모델은 구조만 결정하고 면 품질은 바닥이 보장한다. ──
  `.fleet-kicker{font-family:var(--fleet-mono);font-size:.68rem;font-weight:500;letter-spacing:.15em;text-transform:uppercase;color:var(--fleet-faint);margin:0 0 .5em}`,
  `.fleet-lede{color:var(--fleet-muted);font-size:.95em;margin:0 0 1em;max-width:72ch}`,
  `.fleet-meta{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 1.4em;padding:0;list-style:none}`,
  `.fleet-meta>*{font-family:var(--fleet-mono);font-size:.72rem;color:var(--fleet-muted);border:1px solid var(--fleet-hairline);border-radius:6px;background:color-mix(in oklch,var(--fleet-card) 60%,transparent);padding:3px 9px}`,
  `.fleet-card{background:var(--fleet-card);border:1px solid var(--fleet-hairline);border-radius:10px;padding:13px 15px;margin:0 0 .9em}`,
  `.fleet-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:0 0 .95em}`,
  `.fleet-kpi{background:var(--fleet-card);border:1px solid var(--fleet-hairline);border-radius:10px;padding:11px 13px}`,
  `.fleet-kpi b,.fleet-kpi strong{display:block;font-size:1.3rem;font-weight:750;letter-spacing:-.015em;color:var(--fleet-ink);font-variant-numeric:tabular-nums}`,
  `.fleet-kpi span,.fleet-kpi small{font-family:var(--fleet-mono);font-size:.66rem;letter-spacing:.08em;color:var(--fleet-faint)}`,
  `.fleet-timeline{list-style:none;margin:0 0 .95em;padding:0}`,
  `.fleet-timeline>li{position:relative;padding:0 0 .95em 22px;margin:0}`,
  `.fleet-timeline>li::before{content:"";position:absolute;left:5px;top:15px;bottom:-3px;width:2px;border-radius:2px;background:var(--fleet-hairline)}`,
  `.fleet-timeline>li:last-child::before{display:none}`,
  `.fleet-timeline>li::after{content:"";position:absolute;left:1px;top:5px;width:8px;height:8px;border-radius:50%;border:2px solid var(--fleet-faint);background:var(--fleet-canvas)}`,
  `.fleet-timeline>li[data-state="done"]::after{border-color:var(--fleet-positive)}`,
  `.fleet-timeline>li[data-state="active"]::after{border-color:var(--fleet-accent)}`,
  `.fleet-callout{display:grid;grid-template-columns:3px minmax(0,1fr);gap:12px;border:1px solid var(--fleet-hairline);border-radius:10px;background:var(--fleet-card);padding:11px 13px;margin:0 0 .7em}`,
  `.fleet-callout::before{content:"";border-radius:2px;background:var(--fleet-hairline-strong)}`,
  `.fleet-callout[data-tone="warn"]{border-color:color-mix(in oklch,var(--fleet-warn) 26%,var(--fleet-hairline));background:color-mix(in oklch,var(--fleet-warn) 6%,var(--fleet-card))}`,
  `.fleet-callout[data-tone="warn"]::before{background:var(--fleet-warn)}`,
  `.fleet-callout[data-tone="critical"]{border-color:color-mix(in oklch,var(--fleet-critical) 26%,var(--fleet-hairline));background:color-mix(in oklch,var(--fleet-critical) 6%,var(--fleet-card))}`,
  `.fleet-callout[data-tone="critical"]::before{background:var(--fleet-critical)}`,
  `.fleet-callout[data-tone="positive"]{border-color:color-mix(in oklch,var(--fleet-positive) 26%,var(--fleet-hairline));background:color-mix(in oklch,var(--fleet-positive) 6%,var(--fleet-card))}`,
  `.fleet-callout[data-tone="positive"]::before{background:var(--fleet-positive)}`,
  `.fleet-callout>:last-child{margin-bottom:0}`,
  `.fleet-status{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--fleet-muted);margin-right:7px;vertical-align:1px}`,
  `.fleet-status[data-tone="positive"]{background:var(--fleet-positive)}`,
  `.fleet-status[data-tone="warn"]{background:var(--fleet-warn)}`,
  `.fleet-status[data-tone="critical"]{background:var(--fleet-critical)}`,
  // 표는 카드 그릇에 앉힌다 — 모델이 fleet-table로 감싸면 테두리·radius·스크롤을 바닥이 진다.
  `.fleet-table{border:1px solid var(--fleet-hairline);border-radius:10px;background:var(--fleet-card);overflow-x:auto;margin:0 0 .95em}`,
  `.fleet-table table{margin:0}`,
  `.fleet-table th{padding-top:10px}`,
  // 넓은 표·코드·다이어그램의 가로 스크롤 그릇 — 페이지 자체가 옆으로 흐르지 않게 한다.
  `.fleet-scroll{overflow-x:auto;max-width:100%}`,
  // 포커스는 signal이 아니라 위치 채널이다 — Console과 같은 brass 계열을 쓴다.
  `:focus-visible{outline:2px solid var(--fleet-focus);outline-offset:2px}`,
  // 선택 하이라이트도 위치 채널이다 — accent 채움은 상태를 주장하는 것처럼 읽힌다.
  `::selection{background:color-mix(in oklch,var(--fleet-focus) 30%,transparent)}`,
  `@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}`,
].join("");

/**
 * 아티팩트 문서의 바닥 스타일시트.
 *
 * 아티팩트를 쓰는 것은 게이트웨이 너머의 임의 모델이므로, 판독 품질을 프롬프트 준수에만
 * 맡기지 않는다. 호스트가 타이포·표·코드·인용의 바닥을 깔고 Console 테마 토큰을 넘겨,
 * 모델은 그 위에서 위계와 구조만 결정하면 되게 한다. 이 시트는 문서 맨 앞(<html> 직후)에
 * 들어가므로 모델이 뒤에서 같은 선택자로 덮을 수 있다 — 바닥이지 감옥이 아니다.
 *
 * 폰트는 시스템 스택만 쓴다. iframe은 Console의 @font-face를 상속하지 않고, 외부 폰트
 * 호스트를 부르는 것은 아티팩트의 격리 계약(프로세스 메모리 전용·바깥으로 신호 없음)을
 * 깨기 때문이다.
 */
function artifactBaseStylesheet(tokens: {
  readonly ground: string;
  readonly card: string;
  readonly inset: string;
  readonly foreground: string;
  readonly muted: string;
  readonly faint: string;
  readonly hairline: string;
  readonly hairlineStrong: string;
  readonly accent: string;
  readonly positive: string;
  readonly warn: string;
  readonly critical: string;
  readonly focus: string;
  readonly sansFont?: string;
  readonly monoFont?: string;
}): string {
  // 콘솔 자기 자산의 same-origin 서체 — 외부 신호 0. 응답 헤더의 sandbox가 문서를 opaque
  // origin으로 만들므로 폰트 fetch는 CORS 경로를 탄다(정적 서버가 woff2에 ACAO를 싣는 이유).
  // 내려받은 사본에서는 상대 경로가 죽고 폴백 스택이 선다 — 오프라인 계약은 그대로다.
  const sansFace = tokens.sansFont ? `@font-face{font-family:"Fleet Console Sans";src:url("${tokens.sansFont}") format("woff2");font-weight:100 999;font-style:normal;font-display:swap}` : "";
  const monoFace = tokens.monoFont ? `@font-face{font-family:"Fleet Console Mono";src:url("${tokens.monoFont}") format("woff2");font-weight:100 999;font-style:normal;font-display:swap}` : "";
  const sansStack = `${tokens.sansFont ? `"Fleet Console Sans",` : ""}ui-sans-serif,system-ui,-apple-system,"Segoe UI","Apple SD Gothic Neo","Malgun Gothic",Roboto,sans-serif`;
  const monoStack = `${tokens.monoFont ? `"Fleet Console Mono",` : ""}ui-monospace,"SF Mono",Menlo,Consolas,"D2Coding",monospace`;
  const root = `:root{--fleet-canvas:${tokens.ground};--fleet-surface:${tokens.card};--fleet-card:${tokens.card};--fleet-inset:${tokens.inset};--fleet-ink:${tokens.foreground};--fleet-muted:${tokens.muted};--fleet-faint:${tokens.faint};--fleet-hairline:${tokens.hairline};--fleet-hairline-strong:${tokens.hairlineStrong};--fleet-accent:${tokens.accent};--fleet-positive:${tokens.positive};--fleet-warn:${tokens.warn};--fleet-critical:${tokens.critical};--fleet-focus:${tokens.focus};--fleet-sans:${sansStack};--fleet-mono:${monoStack}}`;
  return `<style>${sansFace}${monoFace}${root}${ARTIFACT_BASE_RULES}</style>`;
}

/**
 * 서체 자산 경로 검증 — 클라이언트가 콘솔 번들의 @font-face에서 읽어 넘긴 same-origin 상대
 * 경로만 통과시킨다. 스킴·호스트가 실리면 버린다(오프라인 계약: 아티팩트 문서는 자기 origin
 * 밖을 부르지 않는다).
 */
const SAFE_ARTIFACT_FONT_PATH = /^\/[A-Za-z0-9_\-./]{1,200}\.woff2$/;

function safeArtifactFontPath(value: string | null): string | undefined {
  if (!value || !SAFE_ARTIFACT_FONT_PATH.test(value) || value.includes("..") || value.includes("//")) return undefined;
  return value;
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
  const providerSession = readAnalysisProviderSession(operation.payload?.session);
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
