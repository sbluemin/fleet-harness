import { React } from "@fleet-console/sdk/plugin/browser";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import { CaptionBrowserUseGlyph } from "@fleet-console/sdk/components/caption-actions";
import { Select } from "@fleet-console/sdk/react/browser";

import { getT } from "../agent/i18n/index.js";
import { pushComposerInbox } from "../agent/chat/composer-inbox.js";
import { publishBrowserEngine, publishBrowserPanel, useBrowserPanel } from "./browser-panel-store.js";
import { themePolarity } from "../store.js";
import { isDesktopShell } from "../desktop-shell.js";
import "./browser-panel.css";

/**
 * Operation Browser companion — Console 서버가 소유한 탭을 창을 든 Fleet Desktop 이 이 패널 자리에 실제 브라우저 뷰로
 * 그린다. 사람은 그 뷰를 직접 보고 만진다. 에이전트가 조작 중이면 배지 채널로 테두리를 칠하고 「중단」을 둔다.
 *
 * 이 패널은 픽셀을 받지 않는다. 자기 자리를 서버에 알리고(셸이 그 자리에 뷰를 놓는다), 가려지는 부분이 있으면 그만큼
 * 잘라 알린다 — 네이티브 뷰는 언제나 페이지 위에 그려지므로, 위에 떠야 하는 것(확장 표면·대화상자)은 뷰를 물러서게 해야
 * 보인다. 브라우저 탭·모바일로 연 Console 에는 뷰가 없으므로 문이 닫혀 있다.
 *
 * 주석 도구 하나가 요소 댓글·펜·화살표·사각형을 품는다. 주석 모드에 들어가면 한 장을 찍어 그 위에 그리고 그동안 뷰는 감춘다.
 * 첨부는 스크린샷 한 장이고 붙여넣기로 간다: 채팅 Operation 이면 그 컴포저에 붙여넣은 것처럼 칩을 세우고, 터미널
 * Operation 이면 서버가 CLI 가 도는 기계의 클립보드에 올린 뒤 Ctrl+V 를 눌러 준다. 보내는 것은 언제나 사람이다.
 *
 * 로그인 상태는 창을 든 기계의 Google Chrome 프로필에서 쿠키로 가져올 수 있다 — Desktop 셸이 읽어 그 Operation 의
 * 세션에만 넣는다.
 */

interface TabState { readonly id: string; readonly url: string; readonly title: string; readonly favicon: string | null; readonly loading: boolean; readonly canGoBack: boolean; readonly canGoForward: boolean }
interface Viewport { readonly width: number; readonly height: number; readonly scale: number; readonly preset: "responsive" | "mobile" | "tablet"; readonly setBy: "user" | "agent" | null; readonly colorScheme: "light" | "dark" | null }
type UnavailableReason = "desktop_required" | "shared";
interface BrowserState {
  readonly tabs: readonly TabState[]; readonly activeTabId: string | null; readonly viewport: Viewport; readonly driving: boolean;
  readonly consoleErrors: number; readonly engine: "idle" | "starting" | "ready" | "failed"; readonly engineError: string | null;
  readonly available: boolean; readonly reason: UnavailableReason | null;
}
interface ImportSources { readonly available: boolean; readonly reason: "chrome_required" | "no_profiles" | null; readonly profiles: readonly { readonly id: string; readonly name: string; readonly account: string | null }[] }
interface Frame { readonly tabId: string; readonly data: string; readonly mime: "image/jpeg" | "image/png"; readonly width: number; readonly height: number }
interface ElementInfo { readonly ref?: string; readonly selector: string; readonly tag: string; readonly id: string | null; readonly classes: readonly string[]; readonly text: string; readonly role: string | null; readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }; readonly component: string | null; readonly source: string | null; readonly styles: Record<string, string> }

type Connection = "connecting" | "open" | "closed" | "disabled";
type Mode = "none" | "annotate";
type AnnotateTool = "comment" | "pen" | "arrow" | "rect";
type Stroke = { tool: "pen"; color: string; points: { x: number; y: number }[] } | { tool: "arrow" | "rect"; color: string; a: { x: number; y: number }; b: { x: number; y: number } };
interface Pin { readonly x: number; readonly y: number; readonly text: string; readonly element: ElementInfo | null }
/** 주석 하나 — 요소에 단 댓글(번호 핀)이거나 손으로 그린 표시. 순서가 곧 번호다. */
type Mark = { readonly kind: "stroke"; readonly stroke: Stroke } | { readonly kind: "pin"; readonly pin: Pin };

const base = (operationId: string) => `/api/v1/browser/operations/${encodeURIComponent(operationId)}`;

async function post(operationId: string, action: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base(operationId)}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/** Blob → base64 본문. 데이터 URL 의 머리(`data:…;base64,`)를 뗀다. */
function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read_failed"));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(blob);
  });
}

function useBrowserStream(operationId: string, enabled: boolean) {
  const [state, setState] = React.useState<BrowserState | null>(null);
  const [connection, setConnection] = React.useState<Connection>(enabled ? "connecting" : "disabled");
  React.useEffect(() => {
    if (!enabled) { setConnection("disabled"); setState(null); return; }
    let disposed = false;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (disposed) return;
      setConnection("connecting");
      source = new EventSource(`${base(operationId)}/stream`);
      source.addEventListener("state", (event) => { try { setState(JSON.parse((event as MessageEvent).data) as BrowserState); setConnection("open"); } catch { /* 무시 */ } });
      source.onerror = () => { source?.close(); source = null; if (!disposed) { setConnection("closed"); retry = setTimeout(connect, 1500); } };
    };
    connect();
    return () => { disposed = true; source?.close(); if (retry) clearTimeout(retry); };
  }, [operationId, enabled]);
  return { state, connection };
}

/** 네이티브 뷰 자리를 다시 재는 간격 — 패널 드래그·리사이즈는 이벤트로도 오지만 캔버스 이동·덮개의 등장은 오지 않는다. */
const NATIVE_PLACE_POLL_MS = 200;
/** 가림을 재는 표본 격자와 경계 탐색 횟수. 6×4 로 덮개를 찾고, 그 변의 경계는 이분으로 1px 까지 좁힌다. */
const OCCLUSION_COLUMNS = 6;
const OCCLUSION_ROWS = 4;
const OCCLUSION_REFINE_STEPS = 8;
/** 이보다 작게 남으면 잘라 보이지 않고 감춘다 — 손톱만 한 조각은 쓸모가 없고 덮개가 뷰에 가려진 것처럼 보인다. */
const MIN_VISIBLE_FRACTION = 0.2;

interface Rect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/**
 * 이 자리 가운데 실제로 보이는 사각형. 네이티브 뷰는 페이지 위에 그려지므로, 페이지에서 이 자리 위에 뜬 것(확장 표면·
 * 대화상자·팝오버)이 있으면 그만큼 물러서야 그것이 보인다. 격자 표본으로 덮개를 찾고, 한 변에서만 덮였으면 그 변을
 * 이분 탐색으로 잘라 낸다. 안쪽이 덮였거나 너무 많이 잘리면 통째로 감춘다(null).
 */
function visibleRect(host: HTMLElement, rect: DOMRect): Rect | null {
  const inside = (x: number, y: number): boolean => { const hit = document.elementFromPoint(x, y); return hit !== null && host.contains(hit); };
  const xs = Array.from({ length: OCCLUSION_COLUMNS }, (_, i) => rect.left + (i + 0.5) * rect.width / OCCLUSION_COLUMNS);
  const ys = Array.from({ length: OCCLUSION_ROWS }, (_, i) => rect.top + (i + 0.5) * rect.height / OCCLUSION_ROWS);
  const covered: { x: number; y: number }[] = [];
  for (const x of xs) for (const y of ys) if (!inside(x, y)) covered.push({ x, y });
  const full = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  if (covered.length === 0) return full;
  if (covered.length === xs.length * ys.length) return null;
  // 한 변을 잘라 덮인 표본을 모두 내보낼 수 있는지 — 네 변 가운데 가장 넓게 남는 쪽을 고른다.
  const cuts: { side: "left" | "right" | "top" | "bottom"; keep: number }[] = [];
  const minX = Math.min(...covered.map((p) => p.x)), maxX = Math.max(...covered.map((p) => p.x));
  const minY = Math.min(...covered.map((p) => p.y)), maxY = Math.max(...covered.map((p) => p.y));
  const columnsCovered = (x: number) => covered.filter((p) => p.x === x).length === ys.length;
  const rowsCovered = (y: number) => covered.filter((p) => p.y === y).length === xs.length;
  if (xs.filter((x) => x >= minX).every(columnsCovered)) cuts.push({ side: "right", keep: (minX - rect.left) / rect.width });
  if (xs.filter((x) => x <= maxX).every(columnsCovered)) cuts.push({ side: "left", keep: (rect.right - maxX) / rect.width });
  if (ys.filter((y) => y >= minY).every(rowsCovered)) cuts.push({ side: "bottom", keep: (minY - rect.top) / rect.height });
  if (ys.filter((y) => y <= maxY).every(rowsCovered)) cuts.push({ side: "top", keep: (rect.bottom - maxY) / rect.height });
  const cut = cuts.sort((a, b) => b.keep - a.keep)[0];
  if (!cut) return null;
  // 경계를 이분으로 좁힌다 — 모든 표본 행(열)이 안쪽인 마지막 자리가 뷰의 끝이다.
  const clear = (side: typeof cut.side, at: number) => (side === "left" || side === "right" ? ys.every((y) => inside(at, y)) : xs.every((x) => inside(x, at)));
  let lo: number, hi: number;
  if (cut.side === "right") { lo = rect.left; hi = minX; }
  else if (cut.side === "left") { lo = maxX; hi = rect.right; }
  else if (cut.side === "bottom") { lo = rect.top; hi = minY; }
  else { lo = maxY; hi = rect.bottom; }
  // lo 쪽은 보이고 hi 쪽은 덮였다(left/top 은 반대). 경계는 그 사이 어딘가다.
  const flipped = cut.side === "left" || cut.side === "top";
  for (let step = 0; step < OCCLUSION_REFINE_STEPS; step += 1) {
    const mid = (lo + hi) / 2;
    if (clear(cut.side, mid) !== flipped) lo = mid; else hi = mid;
  }
  const edge = flipped ? hi : lo;
  const next: Rect = cut.side === "right" ? { ...full, width: edge - rect.left }
    : cut.side === "left" ? { x: edge, y: rect.top, width: rect.right - edge, height: rect.height }
      : cut.side === "bottom" ? { ...full, height: edge - rect.top }
        : { x: rect.left, y: edge, width: rect.width, height: rect.bottom - edge };
  if (next.width * next.height < rect.width * rect.height * MIN_VISIBLE_FRACTION) return null;
  return next;
}

/** 주소 표시 — 호스트는 또렷하게, 스킴은 감추고 경로·쿼리는 흐리게. 편집 중에는 원문 input 이 보인다. */
function UrlParts({ url }: { url: string }) {
  try {
    const parsed = new URL(url);
    const rest = `${parsed.pathname === "/" && !parsed.search && !parsed.hash ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
    return <><span className="op-browser__url-host">{parsed.host}</span>{rest ? <span className="op-browser__url-rest">{rest}</span> : null}</>;
  } catch { return <span className="op-browser__url-host">{url}</span>; }
}

function ExternalGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M6.5 3.5H4A1.5 1.5 0 0 0 2.5 5v7A1.5 1.5 0 0 0 4 13.5h7a1.5 1.5 0 0 0 1.5-1.5V9.5M9.5 2.5H13.5V6.5M13.5 2.5 7.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CommentGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M2.5 3.5A1.5 1.5 0 0 1 4 2h8a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 12 11H7l-3.2 2.6V11H4a1.5 1.5 0 0 1-1.5-1.5v-6Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M5.5 5.5h5M5.5 8h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

const glyph = (paths: string) => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: paths }} />
);
/* 모던 아웃라인 글리프 한 벌 — 뷰포트 프리셋·파비콘 대체. 굵기와 모서리는 카메라·말풍선과 같다. */
const MonitorGlyph = () => glyph('<rect x="1.5" y="2.5" width="13" height="8.5" rx="1.5"/><path d="M5.5 14h5M8 11v3"/>');
const PhoneGlyph = () => glyph('<rect x="4.5" y="1.5" width="7" height="13" rx="1.5"/><path d="M7 12.2h2"/>');
const TabletGlyph = () => glyph('<rect x="2.5" y="1.5" width="11" height="13" rx="1.5"/><path d="M7 12.4h2"/>');
const ReloadGlyph = () => glyph('<path d="M13 8A5 5 0 1 1 8 3"/><path d="M8 1v3M6.5 2.5 8 4l1.5-1.5"/>');
const ImportGlyph = () => glyph('<path d="M8 2v8M4.8 6.8 8 10l3.2-3.2"/><path d="M2.5 10.5V12A1.5 1.5 0 0 0 4 13.5h8a1.5 1.5 0 0 0 1.5-1.5v-1.5"/>');
/** Google Chrome 로고 — 브랜드 색은 브랜드의 것이라 토큰이 아닌 고정값이다. */
const ChromeGlyph = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="11" fill="#ffffff" />
    <path d="M12 1a11 11 0 0 1 9.53 5.5H12a5.5 5.5 0 0 0-4.76 2.75L3.47 4.7A11 11 0 0 1 12 1Z" fill="#db4437" />
    <path d="M3.47 4.7 7.24 9.25a5.5 5.5 0 0 0 .96 6.3L4.1 20.1A11 11 0 0 1 3.47 4.7Z" fill="#0f9d58" />
    <path d="M21.94 6.5a11 11 0 0 1-9.98 16.47 11 11 0 0 1-7.86-2.87l4.1-4.55a5.5 5.5 0 0 0 9.3-3.05h4.44Z" fill="#f4b400" />
    <circle cx="12" cy="12" r="4.2" fill="#4285f4" stroke="#ffffff" strokeWidth="1.3" />
  </svg>
);
const GlobeGlyph = () => glyph('<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/>');

/** 탭 아이콘 — 파비콘은 서버 프록시로 받고, 없거나 깨지면 지구본. */
function TabIcon({ operationId, tab }: { readonly operationId: string; readonly tab: { readonly id: string; readonly favicon: string | null; readonly loading: boolean } }) {
  const [broken, setBroken] = React.useState<string | null>(null);
  if (tab.favicon && broken !== tab.favicon) return <img className="op-browser__tab-icon" src={`${base(operationId)}/favicon?tabId=${encodeURIComponent(tab.id)}&v=${encodeURIComponent(tab.favicon)}`} alt="" draggable={false} onError={() => setBroken(tab.favicon)} />;
  return <span className="op-browser__tab-icon is-fallback" aria-hidden="true"><GlobeGlyph /></span>;
}

function CameraGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M5.5 3.5 6.6 2h2.8l1.1 1.5H13a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V5A1.5 1.5 0 0 1 3 3.5h2.5Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <circle cx="8" cy="8.5" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/** 계산값 rgb(...) 를 #hex 로 — 검사 카드에서 디자이너가 읽는 형태다. 알파가 있으면 그대로 둔다. */
function hexColor(value: string | undefined): string {
  if (!value) return "";
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(value.trim());
  if (!m || (m[4] !== undefined && Number(m[4]) < 1)) return value;
  return `#${[m[1], m[2], m[3]].map((part) => Number(part).toString(16).padStart(2, "0").toUpperCase()).join("")}`;
}

function hostOf(url: string): string { try { const parsed = new URL(url); return parsed.host || url; } catch { return url; } }

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, scale: number): void {
  ctx.strokeStyle = stroke.color; ctx.fillStyle = stroke.color; ctx.lineWidth = 2.5 * scale; ctx.lineCap = "round"; ctx.lineJoin = "round";
  const s = (p: { x: number; y: number }) => ({ x: p.x * scale, y: p.y * scale });
  if (stroke.tool === "pen") { ctx.beginPath(); stroke.points.forEach((p, i) => { const q = s(p); if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); }); ctx.stroke(); return; }
  if (stroke.tool === "rect") { const a = s(stroke.a), b = s(stroke.b); ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); return; }
  if (stroke.tool === "arrow") {
    const a = s(stroke.a), b = s(stroke.b); const ang = Math.atan2(b.y - a.y, b.x - a.x); const head = 12 * scale;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - head * Math.cos(ang - 0.4), b.y - head * Math.sin(ang - 0.4)); ctx.lineTo(b.x - head * Math.cos(ang + 0.4), b.y - head * Math.sin(ang + 0.4)); ctx.closePath(); ctx.fill();
    return;
  }
}

/** 번호 핀 — 첨부 이미지에도 화면과 같은 자리에 같은 번호로 찍힌다. */
function drawPin(ctx: CanvasRenderingContext2D, pin: Pin, n: number, scale: number, color: string, canvasWidth: number): void {
  const x = pin.x * scale, y = pin.y * scale, r = 11 * scale;
  // 댓글은 문장으로 따로 가지 않으므로 이미지 안에 적는다 — 핀 오른쪽의 라벨 상자, 오른쪽 끝에 닿으면 왼쪽으로.
  ctx.font = `500 ${12 * scale}px system-ui, sans-serif`; ctx.textBaseline = "middle";
  const pad = 6 * scale, gap = 6 * scale, h = 22 * scale;
  const w = Math.min(ctx.measureText(pin.text).width + pad * 2, canvasWidth * 0.6);
  const left = x + r + gap + w <= canvasWidth ? x + r + gap : Math.max(0, x - r - gap - w);
  ctx.fillStyle = "#ffffff"; ctx.strokeStyle = color; ctx.lineWidth = 1.5 * scale;
  ctx.beginPath(); ctx.roundRect(left, y - h / 2, w, h, 4 * scale); ctx.fill(); ctx.stroke();
  ctx.save(); ctx.beginPath(); ctx.rect(left, y - h / 2, w, h); ctx.clip();
  ctx.fillStyle = "#111111"; ctx.textAlign = "left"; ctx.fillText(pin.text, left + pad, y);
  ctx.restore();
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  ctx.lineWidth = 2 * scale; ctx.strokeStyle = "#ffffff"; ctx.stroke();
  ctx.fillStyle = "#ffffff"; ctx.font = `700 ${12 * scale}px system-ui, sans-serif`; ctx.textAlign = "center"; ctx.fillText(String(n), x, y);
}

/** 브라우저를 열 수 없는 까닭을 사람의 말로. 브라우저 탭에서는 서버에 묻지 않아도 답이 정해져 있다. */
function unavailableText(t: ReturnType<typeof getT>, reason: UnavailableReason | null): { title: string; body: string | null } {
  if (!isDesktopShell()) return { title: t("terminal.browser.desktopOnly"), body: t("terminal.browser.desktopOnlyBody") };
  if (reason === "shared") return { title: t("terminal.browser.shared"), body: t("terminal.browser.sharedBody") };
  return { title: t("terminal.browser.desktopMissing"), body: null };
}

/**
 * companion 캡션 = 브라우저 탭 스트립. 「브라우저」 한 단어 대신 지구본 + 탭 + 새 탭, 오른쪽에 뷰포트.
 * 에이전트 세션 중이면 지구본이 agent-control 채움이 되고 「사용 중 · 중단」이 선다. 본문이 올린 스냅샷을 읽는다.
 */
export function BrowserCaption({ context }: { readonly context: OperationRenderContext }) {
  const t = getT(context.language ?? "en");
  const panel = useBrowserPanel(context.operationId);
  const [viewportMenu, setViewportMenu] = React.useState(false);
  const stop = (event: React.SyntheticEvent) => { event.stopPropagation(); };
  const driving = panel?.driving === true;
  const ready = panel !== null && panel.available && !panel.busy;
  const viewport = panel?.viewport ?? null;
  const viewportTip = viewport ? `${viewport.width}×${viewport.height} · ${t(`terminal.browser.preset.${viewport.preset}`)}${viewport.setBy === "agent" ? ` · ${t("terminal.browser.setByAgent")}` : ""}` : t("terminal.browser.viewport");
  const presetGlyph = (preset: "responsive" | "mobile" | "tablet") => preset === "mobile" ? <PhoneGlyph /> : preset === "tablet" ? <TabletGlyph /> : <MonitorGlyph />;
  return (
    <div className={`op-browser-cap${driving ? " is-driving" : ""}`} onPointerDown={stop} onWheel={stop} {...(driving ? { role: "status", "aria-label": t("terminal.browser.driving") } : {})}>
      <div className="op-browser-cap__tabs" role="tablist" aria-label={t("terminal.browser.tabs")}>
        {(panel?.tabs ?? []).map((tab) => (
          <div key={tab.id} role="tab" aria-selected={tab.id === panel?.activeTabId} className={`op-browser__tab${tab.id === panel?.activeTabId ? " is-active" : ""}`} onMouseDown={(event) => { if (event.button === 1) { event.preventDefault(); panel?.actions.closeTab(tab.id); } }} onClick={() => { if (tab.id !== panel?.activeTabId) panel?.actions.selectTab(tab.id); }} title={tab.url}>
            <TabIcon operationId={context.operationId} tab={tab} />
            <span className="op-browser__tab-title">{tab.title || hostOf(tab.url) || t("terminal.browser.newTab")}</span>
            <button type="button" className="op-browser__tab-close" aria-label={t("terminal.browser.closeTab")} onClick={(event) => { event.stopPropagation(); panel?.actions.closeTab(tab.id); }}>×</button>
          </div>
        ))}
        <button type="button" className="op-browser__icon" aria-label={t("terminal.browser.newTab")} data-tip={t("terminal.browser.newTab")} disabled={!ready} onClick={() => panel?.actions.createTab()}>+</button>
      </div>
      <button type="button" className="op-browser__icon" data-tip={t("terminal.browser.import.title")} aria-label={t("terminal.browser.import.title")} disabled={!ready} onClick={() => panel?.actions.openImport()}><ImportGlyph /></button>
      <div className="op-browser__viewport-menu">
        <button type="button" className={`op-browser__icon op-browser__tool${viewport && viewport.preset !== "responsive" ? " is-set" : ""}`} aria-haspopup="menu" aria-expanded={viewportMenu} aria-label={viewportTip} data-tip={viewportTip} disabled={!panel || !panel.available} onClick={() => setViewportMenu((open) => !open)}>
          {presetGlyph(viewport?.preset ?? "responsive")}
        </button>
        {viewportMenu ? (
          <div className="op-browser__menu op-browser__menu--row" role="menu">
            {(["responsive", "mobile", "tablet"] as const).map((preset) => (
              <button key={preset} type="button" role="menuitemradio" aria-checked={viewport?.preset === preset} className="op-browser__icon op-browser__tool" aria-pressed={viewport?.preset === preset} aria-label={t(`terminal.browser.preset.${preset}`)} data-tip={t(`terminal.browser.preset.${preset}`)} onClick={() => { setViewportMenu(false); panel?.actions.setViewport(preset); }}>{presetGlyph(preset)}</button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function BrowserPanel({ context }: { readonly context: OperationRenderContext }) {
  const t = getT(context.language ?? "en");
  const operationId = context.operationId;
  // 브라우저 탭·모바일에는 뷰를 그릴 셸이 없다 — 서버에 묻지 않고 닫힌 문만 보인다.
  const desktop = isDesktopShell();
  const { state, connection } = useBrowserStream(operationId, desktop);
  const available = desktop && state?.available === true;
  const [urlDraft, setUrlDraft] = React.useState("");
  const [editingUrl, setEditingUrl] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [info, setInfo] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<Mode>("none");
  const [importSources, setImportSources] = React.useState<ImportSources | null>(null);
  const [importProfile, setImportProfile] = React.useState("");
  const [importing, setImporting] = React.useState(false);
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const nativeRef = React.useRef<HTMLDivElement | null>(null);
  const imageRef = React.useRef<HTMLImageElement | null>(null);
  const lastMove = React.useRef(0);
  const activeTab = available ? state?.tabs.find((tab) => tab.id === state.activeTabId) ?? null : null;
  // 뷰가 사라지면(다른 클라이언트가 붙어 멈춤) 글리프도 같은 사실을 안다 — 문은 패널 밖에 있다.
  React.useEffect(() => { if (state) publishBrowserEngine(state.available ? { available: true } : { available: false, reason: state.reason ?? "desktop_required" }); }, [state?.available, state?.reason]);
  // 네이티브 뷰는 주석을 얹을 표면이 없다 — 주석 모드에 들어갈 때 한 장을 찍어 그 위에 그리고, 그동안 뷰는 감춘다.
  const [stillFrame, setStillFrame] = React.useState<Frame | null>(null);
  React.useEffect(() => {
    if (mode !== "annotate" || !activeTab) { setStillFrame(null); return; }
    let disposed = false;
    void fetch(`${base(operationId)}/screenshot`).then(async (response) => {
      if (!response.ok || disposed) return;
      const shot = await response.json() as { data: string; mimeType: "image/png" | "image/jpeg"; width: number; height: number };
      if (!disposed) setStillFrame({ tabId: activeTab.id, data: shot.data, mime: shot.mimeType, width: shot.width, height: shot.height });
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [mode, activeTab?.id, operationId]);
  const shownFrame = stillFrame && activeTab && stillFrame.tabId === activeTab.id ? stillFrame : null;
  React.useEffect(() => { if (mode === "annotate" && !activeTab) setMode("none"); }, [mode, activeTab]);

  // ---- 네이티브 뷰의 자리 ----
  // 셸은 렌더러와 말을 섞지 않는다. 이 패널이 자기 자리(가려지지 않은 부분)를 서버에 알리고, 셸은 서버의 스냅샷을 보고
  // 뷰를 놓는다. 가려질 때(주석·모달·접힘·다른 화면)는 감춘다 — 네이티브 뷰는 언제나 페이지 위에 그려지기 때문이다.
  const placeRef = React.useRef<string>("");
  React.useEffect(() => {
    if (!available) return;
    const element = nativeRef.current;
    const host = viewportRef.current;
    if (!element || !host) return;
    const post_ = (body: Record<string, unknown>) => { const key = JSON.stringify(body); if (placeRef.current === key) return; placeRef.current = key; void post(operationId, "place", body).catch(() => undefined); };
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const covered = document.querySelector('[aria-modal="true"]') !== null;
      const shown = activeTab !== null && mode === "none" && !covered && document.visibilityState === "visible" && context.bodyLive !== false && rect.width >= 1 && rect.height >= 1;
      const visible = shown ? visibleRect(host, rect) : null;
      if (!visible) { post_({ x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height), visible: false }); return; }
      post_({ x: Math.round(visible.x), y: Math.round(visible.y), width: Math.round(visible.width), height: Math.round(visible.height), visible: true });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    document.addEventListener("visibilitychange", measure);
    const timer = setInterval(measure, NATIVE_PLACE_POLL_MS);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); document.removeEventListener("visibilitychange", measure); clearInterval(timer); };
  // 가져오기 대화상자는 aria-modal 이라 뷰가 물러선다 — 열고 닫는 순간 바로 다시 재도록 의존성에 둔다.
  }, [available, operationId, activeTab !== null, mode, context.bodyLive, importSources !== null]);
  // 패널이 사라지면 뷰도 감춘다 — 자리를 알린 사람이 없는 뷰는 남지 않는다.
  React.useEffect(() => () => { if (placeRef.current) { placeRef.current = ""; void post(operationId, "place", { visible: false }).catch(() => undefined); } }, [operationId]);

  React.useEffect(() => { if (!editingUrl) setUrlDraft(activeTab?.url === "about:blank" ? "" : activeTab?.url ?? ""); }, [activeTab?.url, editingUrl]);
  React.useEffect(() => { if (!info) return; const timer = setTimeout(() => setInfo(null), 4000); return () => clearTimeout(timer); }, [info]);

  // 페이지의 prefers-color-scheme 은 Console 테마 극성을 따른다 — 뷰가 OS 설정을 그대로 쓰면 라이트 테마에서도
  // 사이트가 어둡게 뜬다. 에이전트가 resize_window 로 따로 정한 값은 테마가 바뀔 때까지 존중한다.
  const polarity = themePolarity(context.theme);
  const schemeSetBy = state?.viewport.setBy ?? null;
  const schemeNow = state?.viewport.colorScheme ?? null;
  React.useEffect(() => {
    if (!available) return;
    if (schemeNow === polarity) return;
    if (schemeNow !== null && schemeSetBy === "agent") return;
    void post(operationId, "viewport", { colorScheme: polarity });
  }, [operationId, polarity, available, schemeNow, schemeSetBy]);

  const fail = async (response: Response) => {
    let message = t("terminal.browser.requestFailed");
    try {
      const body = await response.json() as { error?: string; message?: string; reason?: UnavailableReason | null };
      if (body.error === "browser_unavailable") message = unavailableText(t, body.reason ?? null).title;
      else if (body.message) message = body.message;
      else if (body.error) message = body.error;
    } catch { /* 본문 없음 */ }
    setNotice(message);
  };
  const run = async <T,>(action: string, body: Record<string, unknown>): Promise<T | null> => {
    setBusy(true);
    setNotice(null);
    try { const response = await post(operationId, action, body); if (!response.ok) { await fail(response); return null; } return await response.json() as T; }
    catch { setNotice(t("terminal.browser.requestFailed")); return null; }
    finally { setBusy(false); }
  };

  const submitUrl = () => {
    const value = urlDraft.trim();
    setEditingUrl(false);
    if (!value) return;
    void run("navigate", { url: value });
  };

  // ---- 좌표 변환(주석 모드) ----
  // 찍은 한 장은 자신의 크기를 CSS px 로 선언한다(픽셀은 배율만큼 크다). 이미지에는 좌표계가 둘이다. 레이아웃 px(clientWidth)는
  // 오버레이·핀·스케치 캔버스가 사는 곳이고, 화면 px(getBoundingClientRect · 이벤트의 clientX)는 조상 transform 만큼 다르다.
  /** 페이지 CSS px 하나가 레이아웃 px 몇 개인가의 역수 — 오버레이를 앉힐 때 쓴다. */
  const layoutScale = () => {
    const image = imageRef.current;
    if (!image || !shownFrame || image.clientWidth === 0 || shownFrame.width === 0) return null;
    return { x: shownFrame.width / image.clientWidth, y: shownFrame.height / image.clientHeight };
  };
  /** 화면 px → 페이지 CSS px. */
  const point = (event: { clientX: number; clientY: number }) => {
    const image = imageRef.current;
    if (!image || !shownFrame || shownFrame.width === 0) return null;
    const rect = image.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return { x: (event.clientX - rect.left) * (shownFrame.width / rect.width), y: (event.clientY - rect.top) * (shownFrame.height / rect.height) };
  };

  // ---- 요소 조회 (주석의 댓글 도구가 쓴다) ----
  const [hover, setHover] = React.useState<ElementInfo | null>(null);
  const inspectPending = React.useRef(false);
  const inspect = async (x: number, y: number): Promise<ElementInfo | null> => {
    const response = await post(operationId, "inspect", { x, y, tabId: activeTab?.id ?? null }).catch(() => null);
    if (!response || !response.ok) return null;
    const body = await response.json() as { element: ElementInfo | null };
    return body.element;
  };

  // ---- 첨부 → 이 Operation 의 입력창 ----
  const chatMode = context.operation.payload.chatMode === true;
  /**
   * 스크린샷을 이 Operation 의 입력에 붙여넣는다. 채팅 Operation 이면 그 컴포저에 붙여넣은 것처럼 칩을 세우고, 터미널
   * Operation 이면 서버가 CLI 가 도는 기계의 클립보드에 이미지를 올린 뒤 Ctrl+V 를 눌러 준다 — 렌더러의 클립보드는
   * 창을 든 기계의 것이라 원격 콘솔이면 엉뚱하고, 같은 기계여도 키보다 늦게 실려 CLI 가 빈 클립보드를 읽었다. 보내지는 않는다.
   */
  const deliver = async (kind: "annotation" | "screenshot", blob: Blob): Promise<boolean> => {
    setBusy(true); setNotice(null);
    try {
      if (chatMode) {
        pushComposerInbox(operationId, { files: [new File([blob], `browser-${kind}-${Date.now()}.png`, { type: "image/png" })] });
        setInfo(t("terminal.browser.deliveredChat"));
        return true;
      }
      const response = await post(operationId, "paste", { data: await base64Of(blob) });
      if (!response.ok) {
        let code: string | null = null;
        try { code = ((await response.json()) as { error?: string }).error ?? null; } catch { /* 본문 없음 */ }
        setNotice(code === "terminal_not_running" ? t("terminal.browser.terminalNotRunning") : code === "clipboard_failed" ? t("terminal.browser.clipboardFailed") : t("terminal.browser.requestFailed"));
        return false;
      }
      setInfo(t("terminal.browser.deliveredTerminal"));
      return true;
    } catch { setNotice(t("terminal.browser.requestFailed")); return false; }
    finally { setBusy(false); }
  };
  /** 찍어 둔 한 장을 PNG 로 — 주석은 그 위에 그린다. 프레임은 CSS px 를 선언하고 픽셀은 배율만큼 크다. */
  const composeFrame = (draw?: (ctx: CanvasRenderingContext2D, factor: number, width: number) => void): Blob | null => {
    const image = imageRef.current; if (!image || !shownFrame) return null;
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d"); if (!ctx) return null;
    ctx.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight);
    draw?.(ctx, image.naturalWidth / shownFrame.width, image.naturalWidth);
    const dataUrl = canvas.toDataURL("image/png").split(",")[1] ?? "";
    return new Blob([Uint8Array.from(atob(dataUrl), (char) => char.charCodeAt(0))], { type: "image/png" });
  };
  const attachScreenshot = () => {
    // 뷰에는 이미지가 없다 — 서버가 한 장을 찍어 준다(CSS px 크기의 PNG).
    void fetch(`${base(operationId)}/screenshot`).then(async (response) => {
      if (!response.ok) { setNotice(t("terminal.browser.requestFailed")); return; }
      const shot = await response.json() as { data: string };
      const bytes = Uint8Array.from(atob(shot.data), (char) => char.charCodeAt(0));
      await deliver("screenshot", new Blob([bytes], { type: "image/png" }));
    }).catch(() => setNotice(t("terminal.browser.requestFailed")));
  };
  /** 주석·첨부는 보이는 화면이 있어야 한다 — 탭이 열려 있으면 그 자리에서 한 장을 찍을 수 있다. */
  const captureReady = activeTab !== null;

  // ---- 주석: 요소 댓글 + 스케치 ----
  const sketchRef = React.useRef<HTMLCanvasElement | null>(null);
  const [marks, setMarks] = React.useState<Mark[]>([]);
  const [tool, setTool] = React.useState<AnnotateTool>("comment");
  const [colorKey, setColorKey] = React.useState<"red" | "blue" | "green" | "black">("red");
  const [draftPin, setDraftPin] = React.useState<{ x: number; y: number; element: ElementInfo | null } | null>(null);
  const [draftText, setDraftText] = React.useState("");
  const swatchRefs = React.useRef<Record<string, HTMLButtonElement | null>>({});
  const drawing = React.useRef<Stroke | null>(null);
  const swatchColor = (key: string, fallback: string) => { const swatch = swatchRefs.current[key]; return swatch ? getComputedStyle(swatch).backgroundColor : fallback; };
  const inkColor = () => swatchColor(colorKey, "#d64545");
  const redraw = React.useCallback(() => {
    const canvas = sketchRef.current; const image = imageRef.current;
    if (!canvas || !image || !shownFrame) return;
    const width = image.clientWidth, height = image.clientHeight;
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    const factor = width / shownFrame.width;
    for (const mark of marks) if (mark.kind === "stroke") drawStroke(ctx, mark.stroke, factor);
    if (drawing.current) drawStroke(ctx, drawing.current, factor);
  }, [marks, shownFrame]);
  React.useEffect(() => { if (mode === "annotate") redraw(); }, [mode, redraw, shownFrame?.width, shownFrame?.height]);
  React.useEffect(() => { if (mode !== "annotate") { setMarks([]); drawing.current = null; setDraftPin(null); setDraftText(""); setHover(null); setTool("comment"); } }, [mode]);
  React.useEffect(() => { setHover(null); }, [tool]);

  const cancelPin = () => { setDraftPin(null); setDraftText(""); };
  const sketchDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const p = point(event); if (!p) return;
    event.preventDefault();
    if (tool === "comment") {
      // 열린 댓글이 있으면 그 클릭은 닫기다 — 페이지의 다른 곳을 눌러 새 핀을 얹지 않는다.
      if (draftPin) { cancelPin(); return; }
      setDraftPin({ x: p.x, y: p.y, element: hover });
      void inspect(p.x, p.y).then((element) => setDraftPin((current) => current && current.x === p.x && current.y === p.y ? { ...current, element } : current));
      return;
    }
    drawing.current = tool === "pen" ? { tool: "pen", color: inkColor(), points: [p] } : { tool, color: inkColor(), a: p, b: p };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const sketchMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const current = drawing.current;
    if (current) { const p = point(event); if (!p) return; if (current.tool === "pen") current.points.push(p); else current.b = p; redraw(); return; }
    if (tool !== "comment" || draftPin) return;
    const now = performance.now();
    if (inspectPending.current || now - lastMove.current < 90) return;
    lastMove.current = now;
    const p = point(event); if (!p) return;
    inspectPending.current = true;
    void inspect(p.x, p.y).then((element) => { setHover(element); }).finally(() => { inspectPending.current = false; });
  };
  const sketchUp = () => { const current = drawing.current; if (!current) return; drawing.current = null; setMarks((prev) => [...prev, { kind: "stroke", stroke: current }]); };
  const confirmPin = () => {
    const text = draftText.trim();
    if (!draftPin || !text) return;
    setMarks((prev) => [...prev, { kind: "pin", pin: { x: draftPin.x, y: draftPin.y, text, element: draftPin.element } }]);
    cancelPin(); setHover(null);
  };
  const attachMarks = async () => {
    if (marks.length === 0) return;
    const pinColor = swatchColor("blue", "#2f6fdd");
    const blob = composeFrame((ctx, factor, width) => { marks.forEach((mark, index) => { if (mark.kind === "stroke") drawStroke(ctx, mark.stroke, factor); else drawPin(ctx, mark.pin, index + 1, factor, pinColor, width); }); });
    if (!blob) return;
    if (await deliver("annotation", blob)) setMode("none");
  };
  /** 페이지 CSS px → 레이아웃 px. 핀과 댓글 말풍선을 이미지 위 같은 자리에 앉힌다. */
  const stagePoint = (p: { x: number; y: number }) => { const factor = layoutScale(); return factor ? { left: p.x / factor.x, top: p.y / factor.y } : { left: 0, top: 0 }; };
  // 말풍선은 핀 아래에 선다 — 좁은 패널에서 오른쪽으로 밀리면 핀을 덮기 때문이다.
  const commentStyle = (p: { x: number; y: number }) => { const at = stagePoint(p); const width = imageRef.current?.clientWidth ?? 0; return { left: Math.max(8, Math.min(at.left - 14, width - 328)), top: at.top + 18 }; };

  const setViewport = (preset: Viewport["preset"]) => { void run("viewport", { preset }); };
  // ---- Chrome 에서 가져오기 — 창을 든 기계의 Chrome 프로필을 셸이 세고, 고른 프로필의 쿠키를 이 Operation 의 세션에 넣는다 ----
  const openImport = async () => {
    try {
      const response = await fetch("/api/v1/browser/import-sources");
      if (!response.ok) { setNotice(t("terminal.browser.requestFailed")); return; }
      const sources = await response.json() as ImportSources;
      if (!sources.available) { setNotice(sources.reason === "no_profiles" ? t("terminal.browser.import.noProfiles") : t("terminal.browser.import.chromeRequired")); return; }
      setImportProfile(sources.profiles[0]?.id ?? "");
      setImportSources(sources);
    } catch { setNotice(t("terminal.browser.requestFailed")); }
  };
  const runImport = async () => {
    if (!importProfile) return;
    setImporting(true);
    try {
      const result = await run<{ cookies: number }>("import", { profileId: importProfile });
      if (result) { setImportSources(null); setInfo(t("terminal.browser.import.done", { count: String(result.cookies) })); }
    } finally { setImporting(false); }
  };
  const toggleMode = (next: Mode) => setMode((current) => current === next ? "none" : next);

  // 캡션(탭 스트립)이 읽는 스냅샷 — 상태와 손잡이를 함께 올린다. 언마운트하면 거둔다.
  React.useEffect(() => {
    publishBrowserPanel(operationId, {
      tabs: available ? state?.tabs ?? [] : [], activeTabId: available ? state?.activeTabId ?? null : null, driving: state?.driving === true,
      viewport: state ? { width: state.viewport.width, height: state.viewport.height, preset: state.viewport.preset, setBy: state.viewport.setBy } : null,
      busy,
      available,
      actions: {
        selectTab: (tabId) => { void run("tabs", { action: "select", tabId }); },
        closeTab: (tabId) => { void run("tabs", { action: "close", tabId }); },
        createTab: () => { void run("tabs", { action: "create" }); setEditingUrl(true); },
        openImport: () => { void openImport(); },
        setViewport,
      },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 손잡이는 매 렌더 새로 만들어도 같은 뜻이다; 상태·busy 가 바뀔 때만 올린다.
  }, [operationId, state, busy, available]);
  React.useEffect(() => () => publishBrowserPanel(operationId, null), [operationId]);

  const highlightBox = (element: ElementInfo | null) => {
    const factor = layoutScale();
    if (!element || !factor) return null;
    return { left: element.box.x / factor.x, top: element.box.y / factor.y, width: element.box.width / factor.x, height: element.box.height / factor.y };
  };
  const hoverInfo = draftPin?.element ?? hover;
  const hoverBox = highlightBox(hoverInfo);
  const closedDoor = !available ? unavailableText(t, state?.reason ?? null) : null;

  return (
    <div className={`op-browser${state?.driving ? " is-driving" : ""}`}>
      <div className="op-browser__nav">
        <button type="button" className="op-browser__icon" aria-label={t("terminal.browser.back")} disabled={!activeTab?.canGoBack || busy} onClick={() => void run("navigate", { url: "back" })}>←</button>
        <button type="button" className="op-browser__icon" aria-label={t("terminal.browser.forward")} disabled={!activeTab?.canGoForward || busy} onClick={() => void run("navigate", { url: "forward" })}>→</button>
        <button type="button" className={`op-browser__icon op-browser__reload${activeTab?.loading ? " is-loading" : ""}`} aria-label={t("terminal.browser.reload")} disabled={!activeTab || busy} onClick={() => void run("navigate", { url: "reload" })}><ReloadGlyph /></button>
        <form className={`op-browser__url${!editingUrl && urlDraft ? " is-display" : ""}`} onSubmit={(event) => { event.preventDefault(); submitUrl(); }}>
          {!editingUrl && urlDraft ? <span className="op-browser__url-display" aria-hidden="true"><UrlParts url={urlDraft} /></span> : null}
          <input
            id={`op-browser-url-${operationId}`}
            className="op-browser__url-input"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("terminal.browser.urlPlaceholder")}
            aria-label={t("terminal.browser.pageUrl")}
            value={urlDraft}
            disabled={!available}
            onFocus={(event) => { setEditingUrl(true); event.currentTarget.select(); }}
            onBlur={() => setEditingUrl(false)}
            onChange={(event) => setUrlDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") { setEditingUrl(false); event.currentTarget.blur(); } }}
          />
          {activeTab && activeTab.url !== "about:blank" ? <a className="op-browser__url-external" href={activeTab.url} target="_blank" rel="noreferrer noopener" aria-label={t("terminal.browser.openExternal")} title={t("terminal.browser.openExternal")}><ExternalGlyph /></a> : null}
        </form>
        {activeTab && activeTab.url !== "about:blank" ? <button type="button" className="op-browser__icon" aria-label={t("terminal.browser.attachScreenshot")} title={t("terminal.browser.attachScreenshot")} disabled={busy || !captureReady} onClick={attachScreenshot}><CameraGlyph /></button> : null}
        <button type="button" className="op-browser__icon op-browser__tool" aria-pressed={mode === "annotate"} aria-label={mode === "annotate" ? t("terminal.browser.exitAnnotate") : t("terminal.browser.annotate")} title={mode === "annotate" ? t("terminal.browser.exitAnnotate") : t("terminal.browser.annotate")} disabled={!captureReady} onClick={() => toggleMode("annotate")}><CommentGlyph /></button>
      </div>
      <div className={`op-browser__viewport is-${state?.viewport.preset ?? "responsive"}`} ref={viewportRef}>
        {notice ? <div className="op-browser__toast is-error" role="alert">{notice}</div> : info ? <div className="op-browser__toast" role="status">{info}</div> : null}
        {importSources ? (
          <div className="op-browser__scrim" onClick={() => { if (!importing) setImportSources(null); }}>
            <div className="op-browser__dialog" role="dialog" aria-modal="true" aria-label={t("terminal.browser.import.title")} onClick={(event) => event.stopPropagation()}>
              <div className="op-browser__dialog-head">
                <div><h3>{t("terminal.browser.import.title")}</h3><p>{t("terminal.browser.import.body")}</p></div>
                <button type="button" className="op-browser__icon" aria-label={t("terminal.browser.close")} disabled={importing} onClick={() => setImportSources(null)}>×</button>
              </div>
              <label className="op-browser__dialog-row">
                <span className="op-browser__dialog-key">{t("terminal.browser.import.source")}</span>
                <span className="op-browser__dialog-brand" aria-hidden="true"><ChromeGlyph /></span>
                <span className="op-browser__select"><Select label="Google Chrome" value={importProfile} disabled={importing} onChange={(value) => setImportProfile(value)} options={importSources.profiles.map((profile) => ({ value: profile.id, label: `${profile.name}${profile.account ? ` · ${profile.account}` : ""}` }))} /></span>
              </label>
              <div className="op-browser__dialog-item">
                <span className="op-browser__dialog-glyph" aria-hidden="true"><GlobeGlyph /></span>
                <span><strong>{t("terminal.browser.import.cookies")}</strong><span className="op-browser__help">{t("terminal.browser.import.cookiesHelp")}</span></span>
              </div>
              <div className="op-browser__dialog-actions">
                <button type="button" className="op-browser__button" disabled={importing} onClick={() => setImportSources(null)}>{t("terminal.browser.import.cancel")}</button>
                <button type="button" className="op-browser__button op-browser__button--primary" disabled={importing || !importProfile} onClick={() => void runImport()}>{importing ? t("terminal.browser.import.busy") : t("terminal.browser.import.run")}</button>
              </div>
            </div>
          </div>
        ) : null}
        {mode === "annotate" && shownFrame ? (
          // 찍은 한 장을 선언한 CSS 크기 그대로 놓는다 — 패널이 그보다 넓으면 가운데에 두고, 좁으면 줄인다.
          <div className="op-browser__stage" style={{ aspectRatio: `${shownFrame.width} / ${shownFrame.height}`, width: `${shownFrame.width}px`, maxWidth: "100%" }}>
            <img
              ref={imageRef}
              className="op-browser__frame"
              src={`data:${shownFrame.mime};base64,${shownFrame.data}`}
              alt={activeTab?.title ? `${activeTab.title} — ${t("terminal.browser.pageFrame")}` : t("terminal.browser.pageFrame")}
              draggable={false}
              onContextMenu={(event) => event.preventDefault()}
              onLoad={() => redraw()}
            />
            <canvas ref={sketchRef} className={`op-browser__sketch${tool === "comment" ? " is-comment" : ""}`} aria-label={t("terminal.browser.annotate")} onPointerDown={sketchDown} onPointerMove={sketchMove} onPointerUp={sketchUp} onPointerCancel={sketchUp} onPointerLeave={() => { if (!drawing.current && !draftPin) setHover(null); }} />
            {hoverBox ? <div className="op-browser__highlight" style={hoverBox} aria-hidden="true" /> : null}
            {hoverBox && hoverInfo ? (
              <div className="op-browser__hovercard" style={{ left: Math.max(4, hoverBox.left), ...(hoverBox.top > 92 ? { bottom: `calc(100% - ${hoverBox.top - 6}px)` } : { top: hoverBox.top + hoverBox.height + 6 }) }} aria-hidden="true">
                <span className="op-browser__hovercard-name">{hoverInfo.tag}{hoverInfo.id ? `#${hoverInfo.id}` : hoverInfo.classes[0] ? `.${hoverInfo.classes[0]}` : ""}</span><span className="op-browser__hovercard-value">{hoverInfo.box.width}×{hoverInfo.box.height}</span>
                {hoverInfo.component ? <><span className="op-browser__hovercard-key">{t("terminal.browser.hover.component")}</span><span className="op-browser__hovercard-value">{hoverInfo.component}</span></> : null}
                <span className="op-browser__hovercard-key">{t("terminal.browser.hover.color")}</span><span className="op-browser__hovercard-value"><span className="op-browser__hovercard-swatch" style={{ background: hoverInfo.styles.color }} />{hexColor(hoverInfo.styles.color)}</span>
                <span className="op-browser__hovercard-key">{t("terminal.browser.hover.font")}</span><span className="op-browser__hovercard-value">{hoverInfo.styles["font-size"]} {(hoverInfo.styles["font-family"] ?? "").split(",")[0]?.replace(/["']/g, "")}</span>
              </div>
            ) : null}
            {marks.map((mark, index) => mark.kind === "pin" ? (
              <span key={index} className="op-browser__pinwrap" style={stagePoint(mark.pin)}>
                <button type="button" className="op-browser__pin" aria-label={t("terminal.browser.removePin", { n: String(index + 1) })} onClick={() => setMarks((prev) => prev.filter((_, i) => i !== index))}>{index + 1}</button>
                <span className="op-browser__pin-label" role="tooltip">{mark.pin.text}</span>
              </span>
            ) : null)}
            {draftPin ? (
              <>
                <span className="op-browser__pin is-anchor" style={stagePoint(draftPin)} aria-hidden="true">{marks.length + 1}</span>
                <div className="op-browser__comment" style={commentStyle(draftPin)} role="dialog" aria-label={t("terminal.browser.tool.comment")}>
                  <input
                    className="op-browser__comment-input"
                    autoFocus
                    value={draftText}
                    placeholder={t("terminal.browser.commentPlaceholder")}
                    aria-label={t("terminal.browser.commentPlaceholder")}
                    onChange={(event) => setDraftText(event.target.value)}
                    onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === "Enter") { event.preventDefault(); confirmPin(); } else if (event.key === "Escape") { event.preventDefault(); cancelPin(); } }}
                  />
                  <button type="button" className="op-browser__comment-ok" aria-label={t("terminal.browser.commentAdd")} title={t("terminal.browser.commentAdd")} disabled={!draftText.trim()} onClick={confirmPin}>✓</button>
                </div>
              </>
            ) : null}
            <div className="op-browser__sketchbar" role="toolbar" aria-label={t("terminal.browser.annotate")}>
              {(["comment", "pen", "arrow", "rect"] as const).map((entry) => (
                <button key={entry} type="button" className="op-browser__icon op-browser__tool" aria-pressed={tool === entry} aria-label={t(`terminal.browser.tool.${entry}`)} title={t(`terminal.browser.tool.${entry}`)} onClick={() => { setTool(entry); cancelPin(); }}>{entry === "comment" ? <CommentGlyph /> : entry === "pen" ? "✎" : entry === "arrow" ? "➚" : "▭"}</button>
              ))}
              <span className="op-browser__divider" />
              {(["red", "blue", "green", "black"] as const).map((entry) => (
                <button key={entry} ref={(node) => { swatchRefs.current[entry] = node; }} type="button" className={`op-browser__swatch op-browser__swatch--${entry}`} aria-pressed={colorKey === entry} aria-label={t(`terminal.browser.color.${entry}`)} title={t(`terminal.browser.color.${entry}`)} onClick={() => setColorKey(entry)} />
              ))}
              <span className="op-browser__divider" />
              <button type="button" className="op-browser__icon" aria-label={t("terminal.browser.undo")} title={t("terminal.browser.undo")} disabled={marks.length === 0} onClick={() => setMarks((prev) => prev.slice(0, -1))}>↶</button>
              <button type="button" className="op-browser__button" disabled={marks.length === 0} onClick={() => setMarks([])}>{t("terminal.browser.clear")}</button>
              <span className="op-browser__divider" />
              <button type="button" className="op-browser__button op-browser__button--primary" disabled={marks.length === 0 || busy} onClick={() => void attachMarks()}>{t("terminal.browser.attachMarks", { count: String(marks.length) })}</button>
              <button type="button" className="op-browser__icon" aria-label={t("terminal.browser.close")} title={t("terminal.browser.close")} onClick={() => setMode("none")}>×</button>
            </div>
          </div>
        ) : activeTab ? (
          // 네이티브 뷰가 이 자리 위에 그려진다 — 여기에는 아무것도 두지 않는다(가려질 때 배경만 보인다).
          <div className="op-browser__native" ref={nativeRef} aria-hidden="true" />
        ) : (
          <div className="op-browser__empty">
            <span className="op-browser__empty-glyph" aria-hidden="true"><CaptionBrowserUseGlyph /></span>
            <p className="op-browser__empty-title">{closedDoor ? closedDoor.title : state?.engine === "failed" ? t("terminal.browser.engineFailed") : connection === "connecting" ? t("terminal.browser.connecting") : t("terminal.browser.emptyTitle")}</p>
            {closedDoor?.body ? <p className="op-browser__empty-body">{closedDoor.body}</p> : null}
            {!closedDoor && state?.engine !== "failed" ? <p className="op-browser__empty-body">{t("terminal.browser.emptyBody")}</p> : null}
            {!closedDoor && state?.engine === "failed" && state.engineError ? <p className="op-browser__empty-body">{state.engineError}</p> : null}
          </div>
        )}
      </div>
    </div>
  );
}
