import { MenuCheckGlyph } from "@fleet-console/ui/react";
import { NATIVE_VIEW_COVER_ATTRIBUTE, nativeViewCovered, observeNativeViewCover } from "@fleet-console/ui/native-view";
import * as React from "react";
import { createPortal } from "react-dom";
import type { ObjectiveRenderContext } from "../../execution/shared/client-contract.js";
import { FLEET_LINK_NATIVE } from "@fleet-console/link/core";
import { CaptionBrowserUseGlyph } from "../../workspace/client/components/caption-actions.js";

import { getT } from "./i18n.js";
import { suggestionSkipReason } from "../shared/suggestions.js";
import { commodoreAvatarKey, objectiveRecordAvatarKey } from "../../workspace/shared/avatars.js";
import { useAvatarToneOf } from "../../workspace/client/avatar-accent.js";
import { BROWSER_GLOBAL_ID, commodoreOfSpace, HUMAN_SPACE_ID, spaceKindOf, type BrowserSpaceKind, type BrowserSpaceState } from "../shared/spaces.js";
import { saveSuggestionSettings, useSuggestionSettings } from "./suggestion-settings.js";
import { ChromeImportDialog, chromeImportUnavailable, EphemeralGlyph, GlobeGlyph, ImportGlyph, loadChromeImportSources, ProfileGlyph, type ChromeImportSources } from "./chrome-import.js";
import type { BrowserCaptionTab } from "./browser-panel-store.js";
import { BROWSER_RAIL_COLLAPSED_PX, BROWSER_RAIL_EXPANDED_PX, dropBrowserOpenRequest, getNativeViewResize, BrowserNavHostContext, BrowserNavTailContext, setBrowserRailPinned, useBrowserRailPinned, publishBrowserCaptionOverlay, publishBrowserEngine, publishBrowserPanel, subscribeNativeViewResize, takeBrowserOpenRequest, useBrowserCaptionOverlay, useBrowserOpenRequest, useBrowserPanel } from "./browser-panel-store.js";
import { insideNativeFloat, nativeFloatAvailable, NATIVE_FLOAT_ATTRIBUTE, NATIVE_FLOAT_MOTION_ATTRIBUTE, NATIVE_FLOAT_TARGET_ATTRIBUTE, retainNativeFloat } from "./native-float.js";
import { BrowserSurfaceContent, useBrowserDocument, useBrowserWindow, type BrowserSurfaceState } from "./browser-window.js";
import "./browser-panel.css";

export interface BrowserClientServices {
  readonly isDesktopShell: () => boolean;
  readonly desktopShellCapabilities: () => readonly string[];
  readonly themePolarity: (theme: ObjectiveRenderContext["theme"]) => "light" | "dark";
  readonly pushComposerInbox: (objectiveId: string, entry: { readonly files: readonly File[] }) => void;
  readonly subscribeConsoleChannel: (channel: string, listener: (payload: unknown) => void) => () => void;
}
interface BrowserProps { readonly context: ObjectiveRenderContext; readonly services: BrowserClientServices }

/**
 * Objective Browser companion — Console 서버가 소유한 탭을 창을 든 Fleet Desktop 이 이 패널 자리에 실제 브라우저 뷰로
 * 그린다. 사람은 그 뷰를 직접 보고 만진다. 에이전트가 조작 중이면 배지 채널로 테두리를 칠하고 「중단」을 둔다.
 *
 * 이 패널은 픽셀을 받지 않는다. 자기 자리를 서버에 알리고(셸이 그 자리에 뷰를 놓는다), 가려지는 부분이 있으면 그만큼
 * 잘라 알린다 — 네이티브 뷰는 언제나 페이지 위에 그려지므로, 위에 떠야 하는 것(확장 표면·대화상자)은 뷰를 물러서게 해야
 * 보인다. 브라우저 탭·모바일로 연 Console 에는 뷰가 없으므로 문이 닫혀 있다.
 *
 * 주석 도구 하나가 요소 댓글·펜·화살표·사각형을 품는다. 주석 모드에 들어가면 한 장을 찍어 그 위에 그리고 그동안 뷰는 감춘다.
 * 첨부는 스크린샷 한 장이고 붙여넣기로 간다: 채팅 Objective 이면 그 컴포저에 붙여넣은 것처럼 칩을 세우고, 터미널
 * Objective 이면 서버가 CLI 가 도는 기계의 클립보드에 올린 뒤 Ctrl+V 를 눌러 준다. 보내는 것은 언제나 사람이다.
 *
 * 세션은 둘 중 하나다: 닫히면 사라지는 **임시 세션**(기본)이거나, 이 기계에 남아 모든 Objective 이 함께 쓰는
 * **내 프로필**이거나. 캡션의 표식이 지금 어느 쪽인지 말하고 거기서 바꾼다. 로그인 상태는 창을 든 기계의
 * Google Chrome 프로필에서 쿠키로 가져올 수 있다 — Desktop 셸이 읽어 지금 쓰는 세션에만 넣는다.
 */

interface TabState { readonly id: string; readonly spaceId: string; readonly url: string; readonly title: string; readonly favicon: string | null; readonly loading: boolean; readonly canGoBack: boolean; readonly canGoForward: boolean }
interface Viewport { readonly width: number; readonly height: number; readonly scale: number; readonly preset: "responsive" | "mobile" | "tablet"; readonly setBy: "user" | "agent" | null; readonly colorScheme: "light" | "dark" | null }
type UnavailableReason = "desktop_required" | "shared";
interface BrowserState {
  /** Console 전역 브라우저의 id(`BROWSER_GLOBAL_ID`) — 스트림 프레임의 `objectiveId` 도 같은 값이다. */
  readonly browserId: string;
  readonly surface?: BrowserSurfaceState | null;
  readonly spaces: readonly BrowserSpaceState[];
  /** 표시 탭이 속한 스페이스. 탭이 없으면 null. */
  readonly displayedSpaceId: string | null;
  /** 이 대화의 스페이스 — `GET …/state` 응답에만 실린다. 스트림 프레임에는 없다. */
  readonly homeSpaceId?: string;
  /** 사람 화면에 표시된 탭. */
  readonly tabs: readonly TabState[]; readonly activeTabId: string | null; readonly viewport: Viewport; readonly driving: boolean;
  readonly consoleErrors: number; readonly engine: "idle" | "starting" | "ready" | "failed"; readonly engineError: string | null;
  readonly available: boolean; readonly reason: UnavailableReason | null;
  /** 이 Objective 이 쓰는 영속 프로필. `null` 이면 임시 세션이다. */
  readonly profile: string | null;
  /** 새 Objective 의 브라우저가 시작하는 세션 — Console 전체의 설정. */
  readonly defaultProfile: string | null;
}
interface Frame { readonly tabId: string; readonly data: string; readonly mime: "image/jpeg" | "image/png"; readonly width: number; readonly height: number }
interface ElementInfo { readonly ref?: string; readonly selector: string; readonly tag: string; readonly id: string | null; readonly classes: readonly string[]; readonly text: string; readonly role: string | null; readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }; readonly component: string | null; readonly source: string | null; readonly styles: Record<string, string> }

type Connection = "connecting" | "open" | "closed" | "disabled";
type Mode = "none" | "annotate";
type AnnotateTool = "comment" | "pen" | "arrow" | "rect";
type Stroke = { tool: "pen"; color: string; points: { x: number; y: number }[] } | { tool: "arrow" | "rect"; color: string; a: { x: number; y: number }; b: { x: number; y: number } };
interface Pin { readonly x: number; readonly y: number; readonly text: string; readonly element: ElementInfo | null }
/** 주석 하나 — 요소에 단 댓글(번호 핀)이거나 손으로 그린 표시. 순서가 곧 번호다. */
type Mark = { readonly kind: "stroke"; readonly stroke: Stroke } | { readonly kind: "pin"; readonly pin: Pin };

/** Objective 스트림에 실려 오는 브라우저 상태 프레임 (호스트의 같은 이름). */
const BROWSER_STATE_EVENT = "browser:state";
/**
 * 영속 프로필의 id. 지금은 하나뿐이라 화면에서는 「내 프로필」한 낱말로 읽힌다 — 이름을 붙인 여러 프로필은
 * 이 id 자리에 다른 값이 오는 것으로 자란다. 서버의 같은 이름과 짝이다(클라이언트는 셸 계약을 import 하지 않는다).
 */
const BROWSER_PROFILE = "default";

/** 브라우저 자리로 펼쳐지는 패널 메뉴·주소 제안 — 뷰 뒤로 가려지지 않게 가림 표면으로 알린다(`native-view`). */
const COVERS_NATIVE_VIEW = { [NATIVE_VIEW_COVER_ATTRIBUTE]: "" } as const;

const base = (objectiveId: string) => `/api/v1/browser/objectives/${encodeURIComponent(objectiveId)}`;

async function post(objectiveId: string, action: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base(objectiveId)}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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

/**
 * 이 패널은 자기 스트림을 열지 않는다. 브라우저 상태는 이미 열려 있는 Objective 스트림의 `browser:state` 로 오고,
 * 여기서는 붙는 순간의 출발점만 한 번 읽는다.
 *
 * 스트림을 하나 더 여는 일이 공짜가 아니기 때문이다 — 브라우저는 origin 하나에 연결을 여섯 개까지만 열고, 그 예산이
 * 다 차면 이 화면에서 나가는 모든 요청이 조용히 큐에 갇힌다(눌러도 아무 일이 없고, 스트림 하나가 닫혀야 그제야 밀린
 * 요청이 나간다). 원격 콘솔에서는 창을 든 셸의 배관도 같은 예산을 쓰므로 그 여섯이 훨씬 빨리 찬다.
 */
function useBrowserStream(scopeId: string, enabled: boolean, subscribeConsoleChannel: BrowserClientServices["subscribeConsoleChannel"]) {
  const [state, setState] = React.useState<BrowserState | null>(null);
  const [homeSpaceId, setHomeSpaceId] = React.useState<string | null>(null);
  const [connection, setConnection] = React.useState<Connection>(enabled ? "connecting" : "disabled");
  React.useEffect(() => {
    if (!enabled) { setConnection("disabled"); setState(null); setHomeSpaceId(null); return; }
    let disposed = false;
    // 출발점을 읽는 동안 도착한 프레임 — 브라우저는 Console 에 하나이므로 모든 프레임이 내 것이다. 응답보다 새것이면 그것을 쓴다.
    let early: BrowserState | null = null;
    let started = false;
    setConnection("connecting");
    const receive = (payload: unknown) => {
      const next = payload as BrowserState | null;
      if (disposed || !next || next.browserId !== BROWSER_GLOBAL_ID) return;
      if (!started) { early = next; return; }
      setState(next);
      setConnection("open");
    };
    const unsubscribe = subscribeConsoleChannel(BROWSER_STATE_EVENT, receive);
    // 상태는 호출 문맥(scope)의 라우트로 읽는다 — 스트림 프레임에는 없는 이 문맥의 HOME 스페이스를 함께 받는다. 상태 자체는 어느 scope 든 같다.
    void fetch(`${base(scopeId)}/state`)
      .then(async (response) => {
        if (!response.ok) { if (!disposed) setConnection("closed"); return; }
        const body = await response.json() as BrowserState;
        if (disposed || typeof body.browserId !== "string") return;
        started = true;
        setHomeSpaceId(body.homeSpaceId ?? null);
        // 바뀌지 않은 사실은 다시 오지 않으므로, 먼저 도착한 프레임이 있으면 낡은 응답이 그것을 되돌리지 않게 한다.
        const newer = early;
        early = null;
        setState(newer ?? body);
        setConnection("open");
      })
      .catch(() => { if (!disposed) setConnection("closed"); });
    return () => { disposed = true; unsubscribe(); };
  }, [scopeId, enabled, subscribeConsoleChannel]);
  return { state, connection, homeSpaceId };
}

/** 네이티브 뷰 자리를 다시 재는 간격 — 패널 드래그·리사이즈는 이벤트로도 오지만 캔버스 이동·덮개의 등장은 오지 않는다. */
const NATIVE_PLACE_POLL_MS = 200;
/** 칸의 자리가 움직이는 동안(무엇이 움직였든) 매 프레임 다시 알리고, 이만큼 멈춰 있으면 움직임이 끝난 것으로 본다. */
const NATIVE_PLACE_SETTLE_MS = 160;
/** 칸 끌기 예고 동안 미리 찍는 정지 화면 — 이 간격으로 새로 찍고, 이보다 오래된 장은 끌기에 쓰지 않는다. */
const RESIZE_FRAME_REFRESH_MS = 1000;
const RESIZE_FRAME_MAX_AGE_MS = 1500;
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
function visibleRect(host: HTMLElement, rect: DOMRect, geometryOnly = false): Rect | null {
  const document = host.ownerDocument;
  if (geometryOnly) {
    // 유효한 분리 문서가 OS 가림으로 hidden이어도 Console이 정한 콘텐츠 영역은 유지한다.
    // 숨은 문서의 hit-test 결과 대신 host·문서 viewport 교집합만 쓴다. 모달/resize는 호출자가 이미 막는다.
    const hostRect = host.getBoundingClientRect();
    const width = document.documentElement.clientWidth || document.defaultView?.innerWidth || 0;
    const height = document.documentElement.clientHeight || document.defaultView?.innerHeight || 0;
    const x = Math.max(0, rect.left, hostRect.left), y = Math.max(0, rect.top, hostRect.top);
    const right = Math.min(width, rect.right, hostRect.right), bottom = Math.min(height, rect.bottom, hostRect.bottom);
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
  }
  const inside = (x: number, y: number): boolean => {
    let hit = document.elementFromPoint(x, y);
    // 투명한 클릭 캐처만 건너뛴다. 그 자식인 메뉴 카드는 여전히 네이티브 뷰를 가린다.
    // 자식 창에 떠 있는 메뉴는 뷰 위에 따로 그려지므로 덮개가 아니다 — 그 아래를 본다.
    if (hit?.hasAttribute("data-native-browser-transparent") || insideNativeFloat(hit)) {
      hit = document.elementsFromPoint(x, y).find((element) => !element.hasAttribute("data-native-browser-transparent") && !insideNativeFloat(element)) ?? null;
    }
    return hit !== null && host.contains(hit);
  };
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
/** 「새 Objective의 기본으로」 — 행 끝에 올렸을 때만 서는 핀. */
const PinGlyph = () => glyph('<path d="M6.2 2.5h3.6l-.5 3.3 2 2v1.1H4.7V7.8l2-2z"/><path d="M8 8.9v4.5"/>');
const EraseGlyph = () => glyph('<path d="M2.6 4.4h10.8"/><path d="M6.4 4.4V2.9h3.2v1.5"/><path d="M4 4.4l.6 8a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8"/>');

/** 탭 아이콘 — 파비콘은 서버 프록시로 받고, 없거나 깨지면 지구본. */
function TabIcon({ tab }: { readonly tab: { readonly id: string; readonly favicon: string | null; readonly loading: boolean } }) {
  const [broken, setBroken] = React.useState<string | null>(null);
  if (tab.favicon && broken !== tab.favicon) return <img className="op-browser__tab-icon" src={`${base(BROWSER_GLOBAL_ID)}/favicon?tabId=${encodeURIComponent(tab.id)}&v=${encodeURIComponent(tab.favicon)}`} alt="" draggable={false} onError={() => setBroken(tab.favicon)} />;
  return <span className="op-browser__tab-icon is-fallback" aria-hidden="true"><GlobeGlyph /></span>;
}

interface AddressSuggestion { readonly value: string; readonly title: string; readonly historyId?: string }
function SuggestionIcon({ suggestion }: { readonly suggestion: AddressSuggestion }) {
  const [broken, setBroken] = React.useState(false);
  if (!suggestion.historyId) return <span className="op-browser__tab-icon is-fallback" aria-hidden="true">{glyph('<circle cx="6.5" cy="6.5" r="4.5"/><path d="m10 10 4 4"/>')}</span>;
  if (!broken) return <img className="op-browser__tab-icon" src={`${base(BROWSER_GLOBAL_ID)}/favicon?historyId=${suggestion.historyId}`} alt="" draggable={false} onError={() => setBroken(true)} />;
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
function unavailableText(t: ReturnType<typeof getT>, reason: UnavailableReason | null, desktop: boolean): { title: string; body: string | null } {
  if (!desktop) return { title: t("terminal.browser.desktopOnly"), body: t("terminal.browser.desktopOnlyBody") };
  if (reason === "shared") return { title: t("terminal.browser.shared"), body: t("terminal.browser.sharedBody") };
  return { title: t("terminal.browser.desktopMissing"), body: null };
}

/**
 * 스페이스 색 — 그 스페이스의 아바타 정체성 톤이다(사령관 스페이스는 사령관 아바타, Objective 스페이스는 그 Objective 의 아바타).
 * 아바타를 모르는 스페이스(세션·사람)는 CSS 의 무채 잉크가 남는다. 톤 규칙은 대화 강조색과 같은 `avatarToneOf` 하나다.
 */
function spaceAvatarKey(space: { readonly id: string; readonly kind: BrowserSpaceKind }): string | null {
  if (space.kind === "objective") return objectiveRecordAvatarKey(space.id);
  const commodoreId = space.kind === "commodore" ? commodoreOfSpace(space.id) : null;
  return commodoreId === null ? null : commodoreAvatarKey(commodoreId);
}

function AgentGlyph() {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" focusable="false">
      <path d="M6 1.2 7.2 4.8 10.8 6 7.2 7.2 6 10.8 4.8 7.2 1.2 6 4.8 4.8Z" fill="currentColor" />
    </svg>
  );
}
function BackGlyph() {
  return glyph('<path d="M6.5 3.5 2.5 7l4 3.5"/><path d="M2.5 7h7a3 3 0 0 1 3 3v1.5"/>');
}

interface SpaceGroup { readonly space: BrowserSpaceState; readonly tabs: readonly BrowserCaptionTab[]; readonly open: boolean }

export interface SessionBrowserTarget { readonly pluginId: string; readonly scopeId: string }

export interface SessionBrowserResolution {
  /** 브라우저는 하나이므로 시작한 세션이면 늘 전역 id 다. 아직 시작하지 않은 세션은 null 이다. */
  readonly ownerId: string | null;
  /** 이 세션의 HOME 스페이스 — 전역 state 의 HOME(사람)이 아니라 이 값이 이 대화의 그룹이다. */
  readonly homeSpaceId: string | null;
}

/** Console 실행 중에는 같은 scope가 같은 세션 스페이스를 가리킨다. 아직 시작하지 않은 세션은 둘 다 null이다. */
export async function resolveSessionBrowserTarget(target: SessionBrowserTarget): Promise<SessionBrowserResolution> {
  const query = new URLSearchParams({ pluginId: target.pluginId, scopeId: target.scopeId });
  const response = await fetch(`/api/v1/browser/sessions/resolve?${query}`);
  if (!response.ok) throw new Error("browser_target_unavailable");
  const result = await response.json() as { ownerId: string | null; homeSpaceId?: string | null };
  return { ownerId: result.ownerId, homeSpaceId: result.homeSpaceId ?? null };
}

export interface SessionBrowserPanelProps {
  readonly ownerId: string;
  readonly language: ObjectiveRenderContext["language"];
  readonly theme: ObjectiveRenderContext["theme"];
  readonly bodyLive?: boolean;
  readonly services: Pick<BrowserClientServices, "isDesktopShell" | "desktopShellCapabilities" | "themePolarity" | "subscribeConsoleChannel">;
  readonly onAttach?: (files: readonly File[]) => void;
  readonly terminalPaste?: boolean;
  /** 이 패널의 HOME 스페이스를 호출 문맥이 이미 알면 준다(세션: resolver 의 값). 없으면 서버가 이 scope 로 답한 값을 쓴다. */
  readonly homeSpaceId?: string | null;
  /** 터미널 붙여넣기가 향하는 Objective — 분리 창은 지금 보는 문맥의 것을 준다. 없으면 이 패널의 scope. */
  readonly pasteTargetId?: string;
  /** 분리 창 안에 그려지는 패널 — Console 전역 호스트가 하나만 세운다. */
  readonly host?: boolean;
}

/** 주소창이 줄어드는 하한 — 이보다 좁아지면 접히는 단추(캡처·주석·세션·뷰포트)가 「⋯」로 모인다. */
const NAV_URL_MIN_PX = 120;
/** 줄의 아이콘 단추 폭(CSS `.op-browser__nav.is-top` 의 30px 과 같다) — 새로고침 단추를 못 잴 때의 값. */
const NAV_ICON_PX = 30;

/**
 * 좁은 맨 위 줄에서 접힌 주소줄 도구 — 「⋯」 하나가 캡처·주석·세션·뷰포트를 가로 한 줄의 팝오버로 모은다. 안의 단추는 펼쳤을 때와 같은 것이라
 * 각자의 메뉴(세션·뷰포트)도 그대로 열린다. 바깥을 누르거나 Esc 로 닫는다. 팝오버는 본문 위로 내려오므로 네이티브 뷰 가림 표면으로 알린다.
 */
function NavFoldMenu({ objectiveId, label, children }: { readonly objectiveId: string; readonly label: string; readonly children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    publishBrowserCaptionOverlay(objectiveId, "fold", open);
    return () => publishBrowserCaptionOverlay(objectiveId, "fold", false);
  }, [objectiveId, open]);
  React.useEffect(() => {
    if (!open) return;
    // 분리 창에서는 이 줄이 다른 문서에 서므로 그 문서의 입력을 듣는다.
    const doc = rootRef.current?.ownerDocument ?? document;
    const onPointer = (event: PointerEvent) => { if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    doc.addEventListener("pointerdown", onPointer, true);
    doc.addEventListener("keydown", onKey);
    return () => { doc.removeEventListener("pointerdown", onPointer, true); doc.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className="op-browser__fold" ref={rootRef}>
      <button type="button" className="op-browser__icon" aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen((current) => !current)}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><circle cx="3.5" cy="8" r="1.2" fill="currentColor" /><circle cx="8" cy="8" r="1.2" fill="currentColor" /><circle cx="12.5" cy="8" r="1.2" fill="currentColor" /></svg>
      </button>
      {open ? <div className="op-browser__menu op-browser__menu--row" role="menu" aria-label={label} {...COVERS_NATIVE_VIEW}>{children}</div> : null}
    </div>
  );
}

/**
 * 세션·뷰포트 도구 — 이름은 CSS 말풍선(data-tip)이 아니라 네이티브 title 이 말한다. data-tip 말풍선은 단추 아래 DOM 에 그려지는데, 맨 위 줄의 단추 아래는
 * 네이티브 뷰 자리라 뷰 뒤로 가려져 윗변 한 줄만 「빈 상자」로 남는다(닫힌 메뉴의 잔상으로 보였다).
 * 주소줄 끝에 선다(주석 버튼 옆). 탭 줄의 폭은 탭들의 것이다. 상태와 손잡이는 본문이 올린 스냅샷에서 읽는다.
 * 메뉴는 본문 영역까지 내려오므로 열려 있는 동안 네이티브 뷰가 물러서도록 알린다.
 */
function BrowserTools({ objectiveId, language }: { readonly objectiveId: string; readonly language: SessionBrowserPanelProps["language"] }) {
  const t = getT(language ?? "en");
  const panel = useBrowserPanel(objectiveId);
  const importUnavailable = chromeImportUnavailable();
  const [viewportMenu, setViewportMenu] = React.useState(false);
  const [profileMenu, setProfileMenu] = React.useState(false);
  React.useEffect(() => {
    publishBrowserCaptionOverlay(objectiveId, "tools", viewportMenu || profileMenu);
    return () => publishBrowserCaptionOverlay(objectiveId, "tools", false);
  }, [objectiveId, viewportMenu, profileMenu]);
  // 메뉴는 바깥을 누르거나 Esc 로 닫는다 — 바깥 누름은 셸이 float 표면 밖(브라우저 쪽)을 누른 것도 같은 길(문서 pointerdown)로 알린다.
  const profileRef = React.useRef<HTMLDivElement | null>(null);
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!viewportMenu && !profileMenu) return;
    const doc = (profileRef.current ?? viewportRef.current)?.ownerDocument ?? document;
    const onPointer = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target !== null && profileRef.current?.contains(target)) return;
      if (target !== null && viewportRef.current?.contains(target)) return;
      setProfileMenu(false);
      setViewportMenu(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { setProfileMenu(false); setViewportMenu(false); } };
    doc.addEventListener("pointerdown", onPointer, true);
    doc.addEventListener("keydown", onKey);
    return () => { doc.removeEventListener("pointerdown", onPointer, true); doc.removeEventListener("keydown", onKey); };
  }, [viewportMenu, profileMenu]);
  const ready = panel !== null && panel.available && !panel.busy;
  const persistent = (panel?.profile ?? null) !== null;
  const defaultProfile = panel?.defaultProfile ?? null;
  const viewport = panel?.viewport ?? null;
  const viewportTip = viewport ? `${viewport.width}×${viewport.height} · ${t(`terminal.browser.preset.${viewport.preset}`)}${viewport.setBy === "agent" ? ` · ${t("terminal.browser.setByAgent")}` : ""}` : t("terminal.browser.viewport");
  const presetGlyph = (preset: "responsive" | "mobile" | "tablet") => preset === "mobile" ? <PhoneGlyph /> : preset === "tablet" ? <TabletGlyph /> : <MonitorGlyph />;
  return (
    <>
      {/* 세션 표식 — 글리프 하나가 지금 어떤 세션인지 말한다. 가져오기도 이 메뉴에 산다: 쿠키가 들어가는 곳이
          바로 이 세션이므로, 캡션에 버튼을 하나 더 두는 것보다 세션을 다루는 자리에 함께 있는 편이 옳다. */}
      <div className="op-browser__profile" ref={profileRef}>
        <button
          type="button"
          className={`op-browser__icon op-browser__pchip${persistent ? " is-persistent" : ""}`}
          aria-haspopup="menu"
          aria-expanded={profileMenu}
          aria-label={t(persistent ? "terminal.browser.profile.persistent" : "terminal.browser.profile.ephemeral")}
          title={profileMenu ? undefined : t(persistent ? "terminal.browser.profile.persistentTip" : "terminal.browser.profile.ephemeralTip")}
          disabled={!ready}
          onClick={() => setProfileMenu((open) => !open)}
        >
          {persistent ? <ProfileGlyph /> : <EphemeralGlyph />}
        </button>
        {profileMenu ? (
          <div className="op-browser__menu" role="menu" {...COVERS_NATIVE_VIEW}>
            {/* 세션 행은 button 이 아니다 — 행 끝의 핀이 자기 버튼을 가져야 하고, button 안의 button 은 HTML 이 허용하지 않는다.
                기본인 행은 끝에 「기본」 한 낱말을 늘 보이고, 다른 행은 올렸을 때만 핀을 내민다. 핀은 기본만 옮기고
                이 Objective 의 세션은 건드리지 않는다 — 그래서 메뉴도 닫지 않는다. 표식이 옮겨 가는 것이 곧 답이다. */}
            {([null, BROWSER_PROFILE] as const).map((value) => (
              <div
                key={value ?? "ephemeral"}
                role="menuitemradio"
                tabIndex={0}
                aria-checked={(panel?.profile ?? null) === value}
                className="op-browser__menu-item"
                onClick={() => { setProfileMenu(false); panel?.actions.chooseProfile(value); }}
                onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setProfileMenu(false); panel?.actions.chooseProfile(value); } }}
              >
                <span className="op-browser__menu-glyph" aria-hidden="true">{value ? <ProfileGlyph /> : <EphemeralGlyph />}</span>
                <span className="op-browser__menu-body">
                  <strong>{t(value ? "terminal.browser.profile.persistent" : "terminal.browser.profile.ephemeral")}</strong>
                  <span className="op-browser__help">{t(value ? "terminal.browser.profile.persistentHelp" : "terminal.browser.profile.ephemeralHelp")}</span>
                </span>
                <span className="op-browser__menu-tail">
                  {defaultProfile === value
                    ? <span className="op-browser__menu-default">{t("terminal.browser.profile.default")}</span>
                    : (
                      <button
                        type="button"
                        className="op-browser__menu-pin"
                        aria-label={t("terminal.browser.profile.makeDefault")}
                        data-tip={t("terminal.browser.profile.makeDefault")}
                        onClick={(event) => { event.stopPropagation(); panel?.actions.setDefaultProfile(value); }}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        <PinGlyph />
                      </button>
                    )}
                </span>
              </div>
            ))}
            <div className="op-browser__menu-sep" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="op-browser__menu-item"
              disabled={importUnavailable}
              title={importUnavailable ? t("terminal.browser.import.windowsPending") : undefined}
              onClick={() => { setProfileMenu(false); panel?.actions.openImport(); }}
            >
              <span className="op-browser__menu-glyph" aria-hidden="true"><ImportGlyph /></span>
              <span className="op-browser__menu-body"><strong>{t("terminal.browser.import.title")}</strong></span>
            </button>
            <button type="button" role="menuitem" className="op-browser__menu-item" onClick={() => { setProfileMenu(false); panel?.actions.openClearProfile(); }}>
              <span className="op-browser__menu-glyph" aria-hidden="true"><EraseGlyph /></span>
              <span className="op-browser__menu-body">
                <strong>{t("terminal.browser.profile.clearItem")}</strong>
                <span className="op-browser__help">{t("terminal.browser.profile.clearScope")}</span>
              </span>
            </button>
          </div>
        ) : null}
      </div>
      <div className="op-browser__viewport-menu" ref={viewportRef}>
        <button type="button" className={`op-browser__icon op-browser__tool${viewport && viewport.preset !== "responsive" ? " is-set" : ""}`} aria-haspopup="menu" aria-expanded={viewportMenu} aria-label={viewportTip} title={viewportMenu ? undefined : viewportTip} disabled={!panel || !panel.available} onClick={() => setViewportMenu((open) => !open)}>
          {presetGlyph(viewport?.preset ?? "responsive")}
        </button>
        {viewportMenu ? (
          <div className="op-browser__menu op-browser__menu--row" role="menu" {...COVERS_NATIVE_VIEW}>
            {(["responsive", "mobile", "tablet"] as const).map((preset) => (
              <button key={preset} type="button" role="menuitemradio" aria-checked={viewport?.preset === preset} className="op-browser__icon op-browser__tool" aria-pressed={viewport?.preset === preset} aria-label={t(`terminal.browser.preset.${preset}`)} data-tip={t(`terminal.browser.preset.${preset}`)} onClick={() => { setViewportMenu(false); panel?.actions.setViewport(preset); }}>{presetGlyph(preset)}</button>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}

/** 호버가 레일을 떠난 뒤 접기까지의 유예 — 레일에서 뷰 위로 겹친 펼침 쪽(자식 창)으로 넘어가는 순간의 빈틈과 가장자리 스침을 흡수한다. */
const RAIL_LEAVE_MS = 160;
/** 펼침·접힘 전환 길이 — `browser-panel.css` 의 `op-browser-rail-reveal` 과 같아야 한다. */
const RAIL_MOTION_MS = 180;
/** 펼침 표지(`is-opening`)를 붙들어 두는 시간 — 자식 창이 늦게 떠도 전환이 한 번은 재생되도록 전환 길이보다 길게 둔다. */
const RAIL_OPENING_HOLD_MS = 420;

type RailPhase = "closed" | "opening" | "open" | "closing";

/** 화면 좌표(DIP)의 점이 요소 안에 있는가. 알 수 없는 좌표(0,0 이나 비유한 값)는 안에 있다고 보지 않는다. */
function screenPointInside(element: HTMLElement | null, screenX: number, screenY: number): boolean {
  if (element === null || !Number.isFinite(screenX) || !Number.isFinite(screenY) || (screenX === 0 && screenY === 0)) return false;
  const rect = element.getBoundingClientRect();
  // 분리 창에서는 레일이 그 창의 문서에 서므로 좌표도 그 창의 것으로 잰다.
  const window = element.ownerDocument.defaultView;
  if (window === null) return false;
  const zoom = window.innerWidth > 0 && window.outerWidth > 0 ? window.outerWidth / window.innerWidth : 1;
  const originX = window.screenX;
  const originY = window.screenY + Math.max(0, window.outerHeight - window.innerHeight * zoom);
  // 가장자리에서 한 칸 안쪽까지만 안으로 센다 — 천천히 레일 밖으로 나가는 진짜 이탈의 첫 위치(가장자리 바로 바깥·위)는 안이 아니다.
  const inset = 1;
  return screenX >= originX + rect.left * zoom + inset && screenX <= originX + rect.right * zoom - inset
    && screenY >= originY + rect.top * zoom + inset && screenY <= originY + rect.bottom * zoom - inset;
}

/**
 * 세로 탭 레일 — Chrome 「세로로 탭 표시」 모양의 브라우저 탭 줄. 기본은 아이콘 한 열로 접혀 있고(`BROWSER_RAIL_COLLAPSED_PX`),
 * 마우스를 올리거나 키보드 초점이 들어오면 탭 제목·닫기까지 펼쳐지며(`BROWSER_RAIL_EXPANDED_PX`), 벗어나면 접힌다. 고정하면 펼친 채로 남는다.
 *
 * 자리(`.op-browser-rail-slot`)는 접힘 폭(고정이면 펼침 폭)으로만 레이아웃을 차지한다 — 호버 펼침은 그 자리 위에 겹쳐 그려지므로
 * 본문 폭이 호버마다 바뀌지 않는다. 겹친 펼침은 네이티브 뷰를 덮으므로 가림 표면(`COVERS_NATIVE_VIEW`)으로 알린다: 셸이 자식 창을 지원하면
 * 뷰는 라이브로 남고 펼침이 그 위 창에 그려지며, 아니면 뷰가 정지 화면 뒤로 물러선다. 본문이 올린 스냅샷을 읽는다.
 */
function BrowserTabRail({ objectiveId, language }: { readonly objectiveId: string; readonly language: SessionBrowserPanelProps["language"] }) {
  const t = getT(language ?? "en");
  const panel = useBrowserPanel(objectiveId);
  const pinned = useBrowserRailPinned();
  const [hovered, setHovered] = React.useState(false);
  const [keyboardFocus, setKeyboardFocus] = React.useState(false);
  const leaveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // 사람이 펼친 스페이스들. 이 대화의 스페이스(home)와 지금 화면에 띄운 스페이스는 따로 꼽지 않아도 펼쳐진다.
  const [openSpaces, setOpenSpaces] = React.useState<readonly string[]>([]);

  const railRef = React.useRef<HTMLDivElement | null>(null);
  const open = pinned || hovered || keyboardFocus;
  // 펼침·접힘은 클래스(`is-opening`/`is-closing`)가 CSS 전환을 일으킨다. 접히는 동안에도 폭은 펼친 채로 남아 가림 표면의 자리가
  // 흔들리지 않고, 끝난 뒤에 한 번에 접힌다 — 자식 창은 자리가 바뀌는 순간마다 다시 그려지므로 폭을 움직이지 않고 잘라 보이게만 한다.
  const [phase, setPhase] = React.useState<RailPhase>(open ? "open" : "closed");
  React.useLayoutEffect(() => {
    if (open) {
      setPhase((current) => pinned || current === "open" ? "open" : "opening");
      if (pinned) return undefined;
      const timer = setTimeout(() => setPhase("open"), RAIL_OPENING_HOLD_MS);
      return () => clearTimeout(timer);
    }
    setPhase((current) => current === "closed" ? "closed" : "closing");
    const timer = setTimeout(() => setPhase("closed"), RAIL_MOTION_MS);
    return () => clearTimeout(timer);
  }, [open, pinned]);
  const expanded = open || phase === "closing";
  React.useEffect(() => () => { if (leaveTimer.current !== null) clearTimeout(leaveTimer.current); }, []);
  // 자식 창이 포인터를 넘겨받으면 Console 창은 실제 leave 를 받는다 — 그 leave 는 닫으라는 뜻이 아니다. 자식 창에서 실제로 벗어난 것은
  // 자식 창이 전하는 합성 leave 나, Console 쪽에서 레일 밖으로 움직이는 진짜 포인터가 알린다(여기서 닫는다).
  React.useEffect(() => {
    if (!hovered) return undefined;
    const onMove = (event: PointerEvent) => {
      if (!event.isTrusted || event.pointerType === "touch") return;
      if (event.target instanceof Node && railRef.current?.contains(event.target)) return;
      if (leaveTimer.current !== null) clearTimeout(leaveTimer.current);
      leaveTimer.current = setTimeout(() => { leaveTimer.current = null; setHovered(false); }, RAIL_LEAVE_MS);
    };
    const doc = railRef.current?.ownerDocument ?? document;
    doc.addEventListener("pointermove", onMove, true);
    return () => doc.removeEventListener("pointermove", onMove, true);
  }, [hovered]);

  const home = panel?.homeSpaceId ?? null;
  const displayed = panel?.displayedSpaceId ?? null;
  // 이름을 가진 것은 그룹뿐이다 — 사람 스페이스(`human`)는 그룹이 아니라 이름이 없다.
  const toneOf = useAvatarToneOf();
  const spaceColor = (space: BrowserSpaceState): React.CSSProperties | undefined => {
    const key = spaceAvatarKey(space);
    return key === null ? undefined : ({ "--browser-space-c": `var(--id-${toneOf(key)})` } as React.CSSProperties);
  };
  // 에이전트가 쓰는 중인 스페이스는 칩 툴팁(접근성 설명)으로 말한다 — 별도 점 표식은 없다. 탭 단위는 ✦, 브라우저 전체는 레일의 사용 중 표시가 맡는다.
  const drivingTip = (space: BrowserSpaceState) => space.driving ? ` · ${t("terminal.browser.space.driving")}` : "";
  // 브라우저는 모든 사령관이 함께 쓰므로 스페이스 이름이 곧 구별이다. 호스트가 Objective 제목과 사령관 이름을 라벨로 싣고,
  // 세션·사람 스페이스(또는 이름을 모르는 것)는 기본 낱말을 쓴다.
  const spaceName = (space: BrowserSpaceState) => ((space.kind === "objective" || space.kind === "commodore") && space.label) || t(`terminal.browser.space.${space.kind as Exclude<BrowserSpaceKind, "human">}`);
  // 사람이 직접 연 탭은 그룹 없이 따로 그린다. 그룹은 탭이 있는 스페이스만이다 — 프레임이 싣지 않은 스페이스(탭만 아는 것)는 여기서 채운다.
  const humanTabs = (panel?.tabs ?? []).filter((tab) => tab.spaceId === HUMAN_SPACE_ID);
  const groups: readonly SpaceGroup[] = (() => {
    const tabs = (panel?.tabs ?? []).filter((tab) => tab.spaceId !== HUMAN_SPACE_ID);
    const byId = new Map<string, BrowserSpaceState>();
    for (const space of panel?.spaces ?? []) if (space.id !== HUMAN_SPACE_ID) byId.set(space.id, space);
    const blank = (id: string): BrowserSpaceState => ({ id, kind: spaceKindOf(id), label: "", driving: false, agentTabIds: [], lastShownTabId: null });
    for (const tab of tabs) if (!byId.has(tab.spaceId)) byId.set(tab.spaceId, blank(tab.spaceId));
    const ordered = [...byId.values()].sort((a, b) => Number(b.id === home) - Number(a.id === home));
    return ordered
      // 다른 스페이스를 보는 동안 home 은 칩으로 접는다 — 보는 스페이스의 탭이 먼저 읽히게. home 칩을 누르면 돌아온다.
      .map((space) => ({ space, tabs: tabs.filter((tab) => tab.spaceId === space.id), open: space.id === displayed || openSpaces.includes(space.id) || (space.id === home && (displayed === null || displayed === home)) }))
      .filter((group) => group.tabs.length > 0 || group.space.driving);
  })();
  // 이 대화의 그룹이 있을 때만 「내 스페이스」가 있다 — 없으면 돌아갈 곳은 사람 탭이다.
  const homeGroup = home !== null && groups.some((group) => group.space.id === home);
  const away = homeGroup && displayed !== null && displayed !== home;

  /** 스페이스를 펼치고 화면에 띄운다. 이미 보이는 스페이스를 접으면 내 스페이스로 돌아간다. */
  const pickSpace = (space: BrowserSpaceState, isOpen: boolean) => {
    if (space.id === home) {
      setOpenSpaces([]);
      if (displayed !== null && displayed !== home) panel?.actions.selectSpace(space.id);
      return;
    }
    if (isOpen) {
      setOpenSpaces((current) => current.filter((id) => id !== space.id));
      if (displayed === space.id) panel?.actions.selectSpace(homeGroup && home !== null ? home : HUMAN_SPACE_ID);
      return;
    }
    setOpenSpaces((current) => current.includes(space.id) ? current : [...current, space.id]);
    panel?.actions.selectSpace(space.id);
  };
  const driving = panel?.driving === true;
  const ready = panel !== null && panel.available && !panel.busy;

  const onPointerEnter = (event: React.PointerEvent) => {
    if (event.pointerType === "touch") return;
    if (leaveTimer.current !== null) { clearTimeout(leaveTimer.current); leaveTimer.current = null; }
    setHovered(true);
  };
  const onPointerLeave = (event: React.PointerEvent) => {
    if (event.pointerType === "touch") return;
    // 레일이 자식 창에 떠 있는 동안 Console 창이 받는 진짜 leave 는 자식 창이 포인터를 넘겨받았다는 뜻일 뿐이다. 이걸 닫음으로 읽으면
    // 접힌 레일 위에서 가만히 있는 포인터가 접힘→펼침→접힘을 되풀이한다(깜빡임).
    if (event.nativeEvent.isTrusted && railRef.current?.hasAttribute(NATIVE_FLOAT_ATTRIBUTE)) return;
    // 자식 창은 뜨고 자리를 옮기는 동안 포인터가 가만히 있어도 들어옴→나감을 잠깐 알린다. 나감이 알린 포인터 위치가 아직 레일 안이면 진짜 이탈이 아니다.
    if (!event.nativeEvent.isTrusted && screenPointInside(railRef.current, event.nativeEvent.screenX, event.nativeEvent.screenY)) return;
    if (leaveTimer.current !== null) clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => { leaveTimer.current = null; setHovered(false); }, RAIL_LEAVE_MS);
  };
  // 키보드로 들어온 초점만 펼친다 — 탭을 눌러 생긴 초점(포인터)이 포인터를 뗀 뒤에도 펼침을 붙들지 않게.
  const onFocus = (event: React.FocusEvent) => { if (event.target.matches(":focus-visible")) setKeyboardFocus(true); };
  const onBlur = (event: React.FocusEvent) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setKeyboardFocus(false); };

  const renderTab = (tab: BrowserCaptionTab, agentTab: boolean) => {
    const active = tab.id === panel?.activeTabId;
    const title = tab.title || hostOf(tab.url) || t("terminal.browser.newTab");
    const select = () => { if (!active) panel?.actions.selectTab(tab.id); };
    return (
      <div
        key={tab.id}
        role="tab"
        tabIndex={0}
        aria-selected={active}
        aria-label={title}
        className={`op-browser__tab${active ? " is-active" : ""}`}
        onMouseDown={(event) => { if (event.button === 1) { event.preventDefault(); panel?.actions.closeTab(tab.id); } }}
        onClick={select}
        onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); select(); } }}
        title={agentTab ? `${title} — ${tab.url} · ${t("terminal.browser.space.agentTab")}` : `${title} — ${tab.url}`}
      >
        <TabIcon tab={tab} />
        <span className="op-browser__tab-title">{title}</span>
        {agentTab ? <span className="op-browser__tab-agent" role="img" aria-label={t("terminal.browser.space.agentTab")}><AgentGlyph /></span> : null}
        <button type="button" className="op-browser__tab-close" aria-label={t("terminal.browser.closeTab")} onClick={(event) => { event.stopPropagation(); panel?.actions.closeTab(tab.id); }}>×</button>
      </div>
    );
  };
  const pinLabel = t(pinned ? "terminal.browser.rail.unpin" : "terminal.browser.rail.pin");
  const widths = { "--op-rail-collapsed": `${BROWSER_RAIL_COLLAPSED_PX}px`, "--op-rail-expanded": `${BROWSER_RAIL_EXPANDED_PX}px` } as React.CSSProperties;
  return (
    <div className={`op-browser-rail-slot${pinned ? " is-pinned" : ""}`} style={widths}>
      <div
        ref={railRef}
        className={`op-browser-rail${expanded ? " is-open" : ""}${pinned ? " is-pinned" : ""}${driving ? " is-driving" : ""}${!pinned && phase === "opening" ? " is-opening" : ""}${!pinned && phase === "closing" ? " is-closing" : ""}`}
        {...(driving ? { role: "status", "aria-label": t("terminal.browser.driving") } : { role: "group", "aria-label": t("terminal.browser.tabs") })}
        // 전환은 자식 창에서도 재생된다 — 표지가 있는 표면만 자식 창의 애니메이션 차단에서 빠진다.
        {...{ [NATIVE_FLOAT_MOTION_ATTRIBUTE]: "" }}
        // 고정하지 않은 펼침은 본문 위에 겹쳐 그려진다 — 네이티브 뷰가 가리지 않게 가림 표면으로 알린다. 접히는 전환 동안에도 유지한다.
        {...(expanded && !pinned ? COVERS_NATIVE_VIEW : {})}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        <button type="button" className={`op-browser-rail__row op-browser-rail__pin${pinned ? " is-set" : ""}`} aria-pressed={pinned} aria-label={pinLabel} title={pinLabel} onClick={() => setBrowserRailPinned(!pinned)}>
          <span className="op-browser-rail__glyph" aria-hidden="true"><PinGlyph /></span>
          <span className="op-browser-rail__label">{pinLabel}</span>
        </button>
        <div className="op-browser-rail__divider" role="separator" />
        <div className="op-browser-rail__scroll">
          {humanTabs.length > 0 ? <div className="op-browser__space-tabs op-browser__human-tabs" role="tablist" aria-label={t("terminal.browser.tabs")}>{humanTabs.map((tab) => renderTab(tab, false))}</div> : null}
          {groups.map((group) => {
            const { space } = group;
            const name = spaceName(space);
            const isHome = space.id === home;
            const count = String(group.tabs.length);
            const chipTip = `${t(isHome ? "terminal.browser.space.chipHome" : "terminal.browser.space.chip", { name, count })}${drivingTip(space)}`;
            return (
              <div key={space.id} className={`op-browser__space-group${group.open ? " is-open" : ""}`} style={spaceColor(space)} data-space-kind={space.kind}>
                <button
                  type="button"
                  className={`op-browser__space${group.open ? " is-open" : ""}${isHome ? " is-home" : ""}`}
                  aria-expanded={group.open}
                  aria-label={chipTip}
                  title={chipTip}
                  disabled={!panel?.available}
                  onClick={() => pickSpace(space, group.open)}
                >
                  <span className="op-browser__space-initial" aria-hidden="true">{Array.from(name)[0] ?? ""}</span>
                  <span className="op-browser__space-name">{name}</span>
                  {!group.open ? <span className="op-browser__space-count">{count}</span> : null}
                </button>
                {group.open && group.tabs.length > 0 ? (
                  <div className="op-browser__space-tabs" role="tablist" aria-label={`${name} — ${t("terminal.browser.tabs")}`}>
                    {group.tabs.map((tab) => renderTab(tab, space.agentTabIds.includes(tab.id)))}
                  </div>
                ) : null}
              </div>
            );
          })}
          {away && home !== null ? (
            <button type="button" className="op-browser-rail__row op-browser__space-home" aria-label={t("terminal.browser.space.backHome")} title={t("terminal.browser.space.backHomeTip")} onClick={() => panel?.actions.selectSpace(home)}>
              <span className="op-browser-rail__glyph" aria-hidden="true"><BackGlyph /></span>
              <span className="op-browser-rail__label">{t("terminal.browser.space.backHome")}</span>
            </button>
          ) : null}
          <button type="button" className="op-browser-rail__row op-browser-rail__new" aria-label={t("terminal.browser.newTab")} title={t("terminal.browser.newTab")} disabled={!ready} onClick={() => panel?.actions.createTab()}>
            <span className="op-browser-rail__glyph" aria-hidden="true">+</span>
            <span className="op-browser-rail__label">{t("terminal.browser.newTab")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export function BrowserPanel({ context, services }: BrowserProps) {
  const chatMode = context.objectiveRecord.chatMode === true;
  return <SessionBrowserPanel ownerId={context.objectiveId} language={context.language} theme={context.theme} bodyLive={context.bodyLive} services={services}
    terminalPaste={!chatMode} onAttach={chatMode ? (files) => services.pushComposerInbox(context.objectiveId, { files }) : undefined} />;
}

export interface BrowserWindowPanelProps extends Pick<SessionBrowserPanelProps, "language" | "theme" | "services" | "onAttach" | "terminalPaste" | "pasteTargetId"> {}

/**
 * 분리 창 안의 패널 — Console 전역 호스트가 하나만 세운다. 어느 사령관·Objective 를 보고 있든, 대화 칸이 열려 있든 닫혀 있든 상관없이
 * 창이 있는 동안 서 있어서 창이 화면 이동에 풀리지 않는다. 문맥(HOME)이 없으니 어느 대화의 그룹도 앞세우지 않는다.
 */
export function BrowserWindowPanel({ language, theme, services, onAttach, terminalPaste, pasteTargetId }: BrowserWindowPanelProps) {
  const surface = useBrowserDocument();
  if (surface === null) return null;
  return <SessionBrowserPanel key={surface.id} host ownerId={BROWSER_GLOBAL_ID} homeSpaceId={null} language={language} theme={theme} services={services}
    {...(onAttach ? { onAttach } : {})} {...(terminalPaste !== undefined ? { terminalPaste } : {})} {...(pasteTargetId ? { pasteTargetId } : {})} />;
}

/**
 * 주소창에 적던 글 — 패널이 바뀌어도(분리·되돌리기·다른 대화로 이동) 쓰던 글이 사라지지 않게, 적는 패널이 여기 남기고
 * 다음에 화면을 잡는 패널이 이어받는다. 브라우저가 하나이므로 주소창도 하나다. 보내거나 Esc 로 거두면 비운다.
 */
let sharedDraft: string | null = null;

/** 분리 창의 패널이 스냅샷·가림 신호에 쓰는 키 — 어느 문맥의 패널(scope)과도 겹치지 않는다. */
const WINDOW_PANEL_KEY = "window";

export function SessionBrowserPanel({ ownerId: scopeId, language, theme, bodyLive, services, onAttach, terminalPaste = false, homeSpaceId: homeOverride, pasteTargetId, host = false }: SessionBrowserPanelProps) {
  const { isDesktopShell, themePolarity } = services;
  // 이 패널의 스냅샷·가림 신호 키 — 분리 창의 패널은 문맥을 따라가지 않고 하나뿐이다.
  const objectiveId = host ? WINDOW_PANEL_KEY : scopeId;
  const t = getT(language ?? "en");
  // 브라우저 탭·모바일에는 뷰를 그릴 셸이 없다 — 서버에 묻지 않고 닫힌 문만 보인다.
  const desktop = isDesktopShell();
  const { state, connection, homeSpaceId: streamHome } = useBrowserStream(scopeId, desktop, services.subscribeConsoleChannel);
  const homeSpaceId = homeOverride !== undefined ? homeOverride : streamHome;
  const available = desktop && state?.available === true;
  const detached = useBrowserWindow(state?.surface ?? null, state !== null, available, services.desktopShellCapabilities);
  // 분리 창이 있으면 화면과 입력은 그 창의 것이다 — 이 문맥에 붙은 패널은 되돌리기만 보이고, 창 안의 패널(host) 하나만 그린다.
  const surfaceOpen = useBrowserDocument() !== null;
  const inactive = detached.blocked || (surfaceOpen && !host) || (host && !surfaceOpen);
  const documentFor = host ? detached.surface?.document ?? document : document;
  const placementIdentity = React.useRef({ surface: detached.surface?.id ?? null, clientId: detached.clientId });
  placementIdentity.current = { surface: detached.surface?.id ?? null, clientId: detached.clientId };
  const [urlDraft, setUrlDraft] = React.useState("");
  const [editingUrl, setEditingUrl] = React.useState(false);
  const urlDirty = React.useRef(false);
  const keepDraft = React.useRef(false);
  React.useEffect(() => {
    if (inactive || sharedDraft === null) return;
    setUrlDraft(sharedDraft); setEditingUrl(true); urlDirty.current = true; keepDraft.current = true; sharedDraft = null;
  }, [inactive]);
  // 포커스만으로 현재 URL 을 외부에 보내지 않는다. 사람이 고친 입력만 제안에 쓴다.
  const [suggestQuery, setSuggestQuery] = React.useState<string | null>(null);
  const [searchSuggestions, setSuggestions] = React.useState<readonly string[]>([]);
  const [historySuggestions, setHistorySuggestions] = React.useState<readonly AddressSuggestion[]>([]);
  const suggestions: readonly AddressSuggestion[] = [...historySuggestions, ...searchSuggestions.map((value) => ({ value, title: value }))];
  const [selectedSuggestion, setSelectedSuggestion] = React.useState(-1);
  const [composingUrl, setComposingUrl] = React.useState(false);
  const composingUrlRef = React.useRef(false);
  const suggestionRequest = React.useRef<AbortController | null>(null);
  const suggestionSettings = useSuggestionSettings();
  const suggestionsEnabled = suggestionSettings.settings?.enabled === true && !suggestionSettings.saving;
  const suggestionsId = React.useId();
  const suggestionsOpen = available && editingUrl && !composingUrl && suggestions.length > 0;
  const suggestionPromptOpen = available && editingUrl && !composingUrl && !suggestionsOpen && suggestionSettings.settings?.enabled === false && !suggestionSettings.settings.prompted;
  const addressOverlayOpen = suggestionsOpen || suggestionPromptOpen;
  const dismissSuggestions = () => { suggestionRequest.current?.abort(); setSuggestQuery(null); setSuggestions([]); setHistorySuggestions([]); setSelectedSuggestion(-1); };
  React.useEffect(() => {
    const query = suggestQuery?.trim() ?? "";
    setSuggestions([]);
    setHistorySuggestions([]);
    setSelectedSuggestion(-1);
    if (!available || !editingUrl || composingUrl || !query || query.length > 2048) return;
    const controller = new AbortController();
    suggestionRequest.current = controller;
    const timer = setTimeout(() => {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]);
      void fetch(`${base(BROWSER_GLOBAL_ID)}/history`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }), signal,
      }).then(async (response) => {
        if (!response.ok) return;
        const data = await response.json() as { history?: { id: string; url: string; title: string }[] };
        if (!signal.aborted && Array.isArray(data.history)) {
          setHistorySuggestions(data.history.filter((item) => typeof item.id === "string" && /^[a-f0-9]{64}$/u.test(item.id) && typeof item.url === "string" && /^https?:\/\//u.test(item.url) && typeof item.title === "string").slice(0, 5).map((item) => ({ value: item.url, title: item.title || item.url, historyId: item.id })));
          setSelectedSuggestion(-1);
        }
      }).catch(() => undefined);
      if (!suggestionsEnabled || suggestionSkipReason(query)) return;
      void fetch("/api/v1/browser/suggest", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }),
        signal,
      }).then(async (response) => {
        if (!response.ok) return;
        const data = await response.json() as { suggestions?: unknown };
        if (!signal.aborted && Array.isArray(data?.suggestions)) {
          setSuggestions([...new Set(data.suggestions.filter((item): item is string => typeof item === "string" && item.trim().length > 0 && item.length <= 256))].slice(0, 5));
        }
      }).catch(() => undefined);
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [available, suggestionsEnabled, editingUrl, composingUrl, suggestQuery, objectiveId, state?.profile]);
  const [busy, setBusy] = React.useState(false);
  const captionOverlay = useBrowserCaptionOverlay(objectiveId);
  const [notice, setNotice] = React.useState<string | null>(null);
  /** 정보 안내 한 줄. 동사가 붙을 수 있다 — 세션을 바꾼 직후 「새 Objective도 이렇게 열기」처럼, 그 순간에만 뜻이 있는 손잡이. */
  const [info, setInfoState] = React.useState<{ readonly text: string; readonly action?: { readonly label: string; readonly run: () => void } } | null>(null);
  const setInfo = React.useCallback((next: string | { readonly text: string; readonly action?: { readonly label: string; readonly run: () => void } } | null) => { setInfoState(typeof next === "string" ? { text: next } : next); }, []);
  const [mode, setMode] = React.useState<Mode>("none");
  const [profileSwitch, setProfileSwitch] = React.useState<string | null | undefined>(undefined);
  const [clearingProfile, setClearingProfile] = React.useState(false);
  const [profileBusy, setProfileBusy] = React.useState(false);
  const [importSources, setImportSources] = React.useState<ChromeImportSources | null>(null);
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
    void fetch(`${base(BROWSER_GLOBAL_ID)}/screenshot`).then(async (response) => {
      if (!response.ok || disposed) return;
      const shot = await response.json() as { data: string; mimeType: "image/png" | "image/jpeg"; width: number; height: number };
      if (!disposed) setStillFrame({ tabId: activeTab.id, data: shot.data, mime: shot.mimeType, width: shot.width, height: shot.height });
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [mode, activeTab?.id, objectiveId]);
  const shownFrame = stillFrame && activeTab && stillFrame.tabId === activeTab.id ? stillFrame : null;
  React.useEffect(() => { if (mode === "annotate" && !activeTab) setMode("none"); }, [mode, activeTab]);

  // 메뉴·팝업·대화상자로 뷰가 가려질 때(parking) 보여 줄 마지막 웹 화면 스냅샷.
  // 주석 모드의 stillFrame 과 분리해 입력·검사 이벤트 오염을 막는다.
  const [backdropFrame, setBackdropFrame] = React.useState<Frame | null>(null);
  const backdropFrameRef = React.useRef<Frame | null>(null);
  backdropFrameRef.current = backdropFrame;
  const shownBackdrop = backdropFrame && activeTab && backdropFrame.tabId === activeTab.id ? backdropFrame : null;

  const pendingParkBoundsRef = React.useRef<Record<string, unknown> | null>(null);
  const wantsHideRef = React.useRef(false);
  const activeTabRef = React.useRef(activeTab);
  activeTabRef.current = activeTab;

  React.useEffect(() => {
    setBackdropFrame(null);
    backdropFrameRef.current = null;
    pendingParkBoundsRef.current = null;
  }, [activeTab?.id, activeTab?.url, mode]);

  const placeRef = React.useRef<string>("");

  // backdropFrame 이 커밋되어 DOM 에 그려진 뒤, 브라우저가 화면을 합성/페인트한 다음 네이티브 뷰를 주차(hide)한다.
  React.useEffect(() => {
    if (!backdropFrame) return;
    const frameId = requestAnimationFrame(() => {
      if (wantsHideRef.current && pendingParkBoundsRef.current) {
        const body = { ...pendingParkBoundsRef.current, surface: detached.surface?.id ?? null, clientId: detached.clientId };
        const key = JSON.stringify(body);
        if (placeRef.current !== key) {
          placeRef.current = key;
          void post(BROWSER_GLOBAL_ID, "place", body).catch(() => undefined);
        }
      }
    });
    return () => cancelAnimationFrame(frameId);
  }, [backdropFrame, objectiveId, detached.surface, detached.clientId]);

  // ---- 네이티브 뷰의 자리 ----
  // 셸은 렌더러와 말을 섞지 않는다. 이 패널이 자기 자리(가려지지 않은 부분)를 서버에 알리고, 셸은 서버의 스냅샷을 보고
  // 뷰를 놓는다. 가려질 때(주석·모달·접힘·다른 화면)는 감춘다 — 네이티브 뷰는 언제나 페이지 위에 그려지기 때문이다.
  React.useEffect(() => {
    if (!available || inactive) return;
    const document = documentFor;
    const window = document.defaultView ?? globalThis.window;
    const element = nativeRef.current;
    const host = viewportRef.current;
    if (!element || !host) return;
    // 복귀 DOM 측정이 서버의 lease 해제보다 먼저 닿았더라도, 해제 프레임 뒤에는 새 좌표를 다시 발행한다.
    placeRef.current = "";

    let disposed = false;
    let captureTask: { id: number; controller: AbortController; timeout: ReturnType<typeof setTimeout> } | null = null;
    let captureTaskId = 0;
    let captureFailed = false;
    let restoreTimer: ReturnType<typeof setTimeout> | null = null;
    let heldParkBounds: Record<string, unknown> | null = null;
    // 칸 끌기 예고(손잡이 가리킴·포커스) 동안 보이는 뷰를 미리 찍어 둔 장 — 끌기가 시작되면 캡처를 기다리지 않고 이 장으로 물러난다.
    let resizeFrame: { readonly frame: Frame; readonly url: string; readonly at: number } | null = null;
    let resizePrefetch: AbortController | null = null;
    let resizeRefresh: ReturnType<typeof setInterval> | null = null;
    let resizeMine = false;

    const abortActiveCapture = () => {
      if (!captureTask) return;
      clearTimeout(captureTask.timeout);
      captureTask.controller.abort();
      captureTask = null;
    };

    const post_ = (placement: Record<string, unknown>) => {
      const body = { ...placement, surface: detached.surface?.id ?? null, clientId: detached.clientId };
      const key = JSON.stringify(body);
      if (placeRef.current === key) return;
      placeRef.current = key;
      void post(BROWSER_GLOBAL_ID, "place", body).catch(() => undefined);
    };

    const captureBackdrop = (tabId: string, url: string, parkBounds: Record<string, unknown>) => {
      abortActiveCapture();
      const currentTaskId = ++captureTaskId;
      const controller = new AbortController();

      // 전체 캡처 예산(fetch + JSON 파싱 + img.decode): 800ms
      // 타임아웃 발생 시 즉시 abort 하고 안전한 주차 폴백을 수행한다.
      const timeout = setTimeout(() => {
        if (disposed || captureTask?.id !== currentTaskId) return;
        captureTask = null;
        captureFailed = true;
        controller.abort();
        if (wantsHideRef.current) post_(parkBounds);
      }, 800);

      captureTask = { id: currentTaskId, controller, timeout };

      void (async () => {
        try {
          const response = await fetch(`${base(BROWSER_GLOBAL_ID)}/screenshot`, { signal: controller.signal });
          if (!response.ok) throw new Error("capture_failed");
          const shot = await response.json() as { data: string; mimeType: "image/png" | "image/jpeg"; width: number; height: number };

          // URL / Tab provenance guard:
          if (disposed || controller.signal.aborted || captureTask?.id !== currentTaskId || activeTabRef.current?.id !== tabId || activeTabRef.current?.url !== url) {
            return;
          }

          const img = new Image();
          img.src = `data:${shot.mimeType};base64,${shot.data}`;
          // decode 실패 시 throw 되어 catch 의 안전한 주차 폴백으로 이동
          await img.decode();

          if (disposed || controller.signal.aborted || captureTask?.id !== currentTaskId || activeTabRef.current?.id !== tabId || activeTabRef.current?.url !== url) {
            return;
          }
          if (!wantsHideRef.current) return;

          const frame: Frame = { tabId, data: shot.data, mime: shot.mimeType, width: shot.width, height: shot.height };
          backdropFrameRef.current = frame;
          pendingParkBoundsRef.current = parkBounds;
          setBackdropFrame(frame);
        } catch {
          if (disposed || captureTask?.id !== currentTaskId) return;
          captureFailed = true;
          if (wantsHideRef.current) post_(parkBounds);
        } finally {
          if (captureTask?.id === currentTaskId) {
            clearTimeout(captureTask.timeout);
            captureTask = null;
          }
        }
      })();
    };

    const prefetchResizeFrame = () => {
      const tab = activeTabRef.current;
      // 보이는 뷰만 찍는다 — 이미 물러나 있으면 이 장은 필요 없다.
      if (disposed || resizePrefetch !== null || tab === null || wantsHideRef.current) return;
      const controller = new AbortController();
      resizePrefetch = controller;
      const timeout = setTimeout(() => controller.abort(), 800);
      const { id: tabId, url } = tab;
      void (async () => {
        try {
          const response = await fetch(`${base(BROWSER_GLOBAL_ID)}/screenshot`, { signal: controller.signal });
          if (!response.ok) return;
          const shot = await response.json() as { data: string; mimeType: "image/png" | "image/jpeg"; width: number; height: number };
          const img = new Image();
          img.src = `data:${shot.mimeType};base64,${shot.data}`;
          await img.decode();
          if (disposed || controller.signal.aborted || activeTabRef.current?.id !== tabId || activeTabRef.current?.url !== url) return;
          resizeFrame = { frame: { tabId, data: shot.data, mime: shot.mimeType, width: shot.width, height: shot.height }, url, at: Date.now() };
        } catch {
          // 미리 찍지 못하면 끌기는 기존 경로(누른 뒤 캡처)로 물러난다.
        } finally {
          clearTimeout(timeout);
          if (resizePrefetch === controller) resizePrefetch = null;
          // 찍는 사이 끌기가 시작됐으면 이제 그 장으로 물러난다.
          if (!disposed && wantsHideRef.current) measure();
        }
      })();
    };

    const onResizeIntent = () => {
      const intent = getNativeViewResize();
      const mine = intent !== null && intent.container.contains(element);
      if (resizeRefresh !== null) { clearInterval(resizeRefresh); resizeRefresh = null; }
      if (mine && !intent.held) {
        prefetchResizeFrame();
        resizeRefresh = setInterval(prefetchResizeFrame, RESIZE_FRAME_REFRESH_MS);
      }
      // 누르는 그 순간(칸의 data-resizing 이 칠해지기 전) 곧바로 다시 재어 물러나고, 놓으면 그 자리에서 다시 놓는다.
      const relevant = mine || resizeMine;
      resizeMine = mine;
      if (relevant) measure();
    };

    const measure = () => {
      const rect = element.getBoundingClientRect();
      // 이 패널을 실은 칸의 폭을 사람이 끄는 동안(조상의 data-resizing)도 가려진 것과 같다 — 뷰를 정지 화면 뒤로 물려
      // 끄는 포인터를 뷰가 가져가지 않게 하고, 놓은 뒤 정착한 자리에 한 번 다시 놓는다.
      const intent = getNativeViewResize();
      const held = (intent !== null && intent.held && intent.container.contains(element)) || element.closest('[data-resizing="true"]') !== null;
      // 셸이 메뉴를 자식 창에 띄울 수 있으면 비모달 가림 표면(패널 메뉴·주소 제안·승인 팝오버 등)은 뷰 위에 따로 그려진다 —
      // 그때는 모달 대화상자만 뷰를 물린다. 옛 셸에서는 지금처럼 가림 표면이 있으면 물러선다.
      const floats = nativeFloatAvailable();
      const covered = (floats ? document.querySelector('[aria-modal="true"]') !== null : nativeViewCovered(document) || captionOverlay || addressOverlayOpen) || held;
      // 분리 표면의 OS 최소화/숨김은 Desktop의 surface guard가 소유한다. Chromium 문서 hidden은
      // 가림/Space에서도 남을 수 있으므로 유효한 열린 lease의 geometry를 중복으로 없애지 않는다.
      const detachedLive = detached.surface !== null && state?.surface?.id === detached.surface.id
        && state.surface.clientId === detached.clientId && state.surface.status === "opened";
      const live = activeTab !== null && mode === "none" && (detachedLive || document.visibilityState === "visible")
        && (detachedLive || bodyLive !== false) && rect.width >= 1 && rect.height >= 1;
      const shown = live && !covered;
      const visible = shown ? visibleRect(host, rect, detachedLive && document.visibilityState !== "visible") : null;

      if (visible) {
        wantsHideRef.current = false;
        heldParkBounds = null;
        captureFailed = false;
        pendingParkBoundsRef.current = null;
        abortActiveCapture();

        // 실제 backdrop 이 표시 중일 때만 150ms 복원 전환 버퍼를 둔다 (해제 시점 분리).
        if (backdropFrameRef.current !== null && !restoreTimer) {
          restoreTimer = setTimeout(() => {
            restoreTimer = null;
            backdropFrameRef.current = null;
            setBackdropFrame(null);
          }, 150);
        }

        post_({ x: Math.round(visible.x), y: Math.round(visible.y), width: Math.round(visible.width), height: Math.round(visible.height), visible: true });
        return;
      }

      if (restoreTimer) {
        clearTimeout(restoreTimer);
        restoreTimer = null;
      }

      // 끄는 동안 물러난 뷰는 처음 물러난 자리에 그대로 둔다 — 매 프레임 바뀌는 폭을 서버·셸로 보내 숨은 페이지를 거듭 리사이즈하지 않게.
      if (!held) heldParkBounds = null;
      const parkBounds = (held ? heldParkBounds : null)
        ?? { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height), visible: false };
      if (held) heldParkBounds = parkBounds;

      if (!live || !activeTab) {
        wantsHideRef.current = false;
        abortActiveCapture();
        if (backdropFrameRef.current !== null) {
          backdropFrameRef.current = null;
          setBackdropFrame(null);
        }
        post_(parkBounds);
        return;
      }

      wantsHideRef.current = true;
      pendingParkBoundsRef.current = parkBounds;

      // 1. 이미 현재 탭의 스냅샷이 준비되어 있으면 주차 유지
      if (backdropFrameRef.current && backdropFrameRef.current.tabId === activeTab.id) {
        post_(parkBounds);
        return;
      }

      // 1'. 칸 끌기 — 예고 동안 미리 찍어 둔 장이 있으면 캡처를 기다리지 않고 그 장을 깔고 물러난다(깔린 뒤 한 프레임에 주차).
      //     미리 찍는 중이면 그 장을 기다린다 — 처음부터 찍는 것보다 짧다.
      if (held) {
        if (resizeFrame !== null && resizeFrame.frame.tabId === activeTab.id && resizeFrame.url === activeTab.url && Date.now() - resizeFrame.at <= RESIZE_FRAME_MAX_AGE_MS) {
          abortActiveCapture();
          backdropFrameRef.current = resizeFrame.frame;
          setBackdropFrame(resizeFrame.frame);
          return;
        }
        if (resizePrefetch !== null) return;
      }

      // 2. 캡처/디코드가 실패했던 세션이면 재시도하지 않고 안전하게 주차 폴백
      if (captureFailed) {
        post_(parkBounds);
        return;
      }

      // 3. 이미 캡처가 진행 중이면 완료를 기다린다 (hide 지연 유지)
      if (captureTask !== null) {
        return;
      }

      // 4. 스냅샷 캡처 및 디코드 완료 전까지 네이티브 뷰를 숨기지 않고 캡처 시작
      captureBackdrop(activeTab.id, activeTab.url, parkBounds);
    };

    measure();
    const unsubscribeResizeIntent = subscribeNativeViewResize(onResizeIntent);
    onResizeIntent();
    // 칸의 자리가 바뀌는 길은 하나다 — 어떤 레이아웃(좌·우 사이드바, 채팅창/브라우저 경계, 창 크기)이 움직였든 칸의 자리(x·y·폭·높이)가 달라지면
    // 같은 길로 다시 알린다. 칸 자신의 크기는 그대로인 채 자리만 옮겨 가는 변화는 칸을 보는 것만으로는 알 수 없어, 조상들의 크기 변화로 알아채고
    // 움직임이 이어지는 동안은 매 프레임 자리를 확인한다(폴링만으로는 한참 늦는다).
    let rectKey = "";
    let motionFrame = 0;
    let motionStillSince = 0;
    const readRectKey = () => {
      const rect = element.getBoundingClientRect();
      return `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`;
    };
    const watchMotion = () => {
      motionFrame = 0;
      if (disposed) return;
      const key = readRectKey();
      const now = performance.now();
      if (key !== rectKey) {
        rectKey = key;
        motionStillSince = now;
        measure();
      }
      if (now - motionStillSince < NATIVE_PLACE_SETTLE_MS) motionFrame = window.requestAnimationFrame(watchMotion);
    };
    const noteMotion = () => {
      if (disposed) return;
      motionStillSince = performance.now();
      if (motionFrame === 0) motionFrame = window.requestAnimationFrame(watchMotion);
    };
    rectKey = readRectKey();
    const observer = new ResizeObserver(() => { measure(); noteMotion(); });
    observer.observe(element);
    for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) observer.observe(ancestor);
    window.addEventListener("resize", noteMotion);
    window.addEventListener("resize", measure);
    document.addEventListener("visibilitychange", measure);
    const timer = setInterval(() => { measure(); if (readRectKey() !== rectKey) noteMotion(); }, NATIVE_PLACE_POLL_MS);
    // 가림 표면(모달·승인 팝오버처럼 `data-covers-native-view` 를 단 것)이 붙고 떨어지는 순간 곧바로 재는다 — 폴링을 기다리면 그동안 가려진다.
    const unobserveCover = observeNativeViewCover(measure, document);

    return () => {
      disposed = true;
      abortActiveCapture();
      unsubscribeResizeIntent();
      resizePrefetch?.abort();
      if (resizeRefresh !== null) clearInterval(resizeRefresh);
      if (restoreTimer) {
        clearTimeout(restoreTimer);
        restoreTimer = null;
      }
      observer.disconnect();
      if (motionFrame !== 0) window.cancelAnimationFrame(motionFrame);
      window.removeEventListener("resize", noteMotion);
      window.removeEventListener("resize", measure);
      document.removeEventListener("visibilitychange", measure);
      clearInterval(timer);
      unobserveCover();
    };
  // 가져오기 대화상자는 aria-modal 이라 뷰가 물러선다 — 열고 닫는 순간 바로 다시 재도록 의존성에 둔다.
  // 캡션의 메뉴는 모달이 아니므로 스스로 알려 온다(`captionOverlay`); 200ms 폴링을 기다리면 그동안 가려진다.
  // 주소 제안도 같은 가림 경로에 합친다. 캡션의 단일 발행 상태를 덮어쓰지 않는다.
  }, [available, objectiveId, activeTab?.id, activeTab?.url, mode, bodyLive, importSources !== null, profileSwitch !== undefined, clearingProfile, captionOverlay, addressOverlayOpen, documentFor, detached.surface, inactive, detached.clientId, state?.surface?.id, state?.surface?.clientId, state?.surface?.status]);
  // 셸이 표면을 자식 창에 띄울 수 있으면, 이 자리를 덮는 비모달 표면은 뷰를 물리지 않고 그 창에 그려진다.
  // 자리 재기와 따로 붙든다 — 재기 효과는 가림 신호마다 다시 걸리고, 그때마다 자식 창을 내렸다 올리면 깜빡인다.
  React.useEffect(() => inactive ? undefined : retainNativeFloat(documentFor), [documentFor, inactive]);
  // 패널이 사라지면 뷰도 감춘다 — 자리를 알린 사람이 없는 뷰는 남지 않는다.
  React.useEffect(() => () => {
    if (placeRef.current) {
      placeRef.current = "";
      void post(BROWSER_GLOBAL_ID, "place", { visible: false, ...placementIdentity.current }).catch(() => undefined);
    }
  }, [objectiveId]);

  React.useEffect(() => { if (keepDraft.current) { keepDraft.current = false; return; } urlDirty.current = false; }, [activeTab?.id, activeTab?.url]);
  React.useEffect(() => { if (!editingUrl && !urlDirty.current) setUrlDraft(activeTab?.url === "about:blank" ? "" : activeTab?.url ?? ""); }, [activeTab?.url, editingUrl]);
  // 손잡이가 붙은 안내는 읽고 누를 시간을 더 준다.
  React.useEffect(() => { if (!info) return; const timer = setTimeout(() => setInfo(null), info.action ? 8000 : 4000); return () => clearTimeout(timer); }, [info, setInfo]);

  // 페이지의 prefers-color-scheme 은 Console 테마 극성을 따른다 — 뷰가 OS 설정을 그대로 쓰면 라이트 테마에서도
  // 사이트가 어둡게 뜬다. 에이전트가 resize_window 로 따로 정한 값은 테마가 바뀔 때까지 존중한다.
  const polarity = themePolarity(theme);
  const schemeSetBy = state?.viewport.setBy ?? null;
  const schemeNow = state?.viewport.colorScheme ?? null;
  React.useEffect(() => {
    if (!available) return;
    if (schemeNow === polarity) return;
    if (schemeNow !== null && schemeSetBy === "agent") return;
    void post(BROWSER_GLOBAL_ID, "viewport", { colorScheme: polarity });
  }, [objectiveId, polarity, available, schemeNow, schemeSetBy]);

  const fail = async (response: Response) => {
    let message = t("terminal.browser.requestFailed");
    try {
      const body = await response.json() as { error?: string; message?: string; reason?: UnavailableReason | null };
      if (body.error === "browser_unavailable") message = unavailableText(t, body.reason ?? null, services.isDesktopShell()).title;
      else if (body.message) message = body.message;
      else if (body.error) message = body.error;
    } catch { /* 본문 없음 */ }
    setNotice(message);
  };
  const run = async <T,>(action: string, body: Record<string, unknown>): Promise<T | null> => {
    setBusy(true);
    setNotice(null);
    try { const response = await post(BROWSER_GLOBAL_ID, action, body); if (!response.ok) { await fail(response); return null; } return await response.json() as T; }
    catch { setNotice(t("terminal.browser.requestFailed")); return null; }
    finally { setBusy(false); }
  };

  const submitUrl = (target = urlDraft) => {
    urlDirty.current = false;
    sharedDraft = null;
    const value = target.trim();
    dismissSuggestions();
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
    const response = await post(BROWSER_GLOBAL_ID, "inspect", { x, y, tabId: activeTab?.id ?? null }).catch(() => null);
    if (!response || !response.ok) return null;
    const body = await response.json() as { element: ElementInfo | null };
    return body.element;
  };

  // ---- 첨부 → 이 세션의 입력창 ----
  /**
   * 스크린샷을 이 Objective 의 입력에 붙여넣는다. 채팅 Objective 이면 그 컴포저에 붙여넣은 것처럼 칩을 세우고, 터미널
   * Objective 이면 서버가 CLI 가 도는 기계의 클립보드에 이미지를 올린 뒤 Ctrl+V 를 눌러 준다 — 렌더러의 클립보드는
   * 창을 든 기계의 것이라 원격 콘솔이면 엉뚱하고, 같은 기계여도 키보다 늦게 실려 CLI 가 빈 클립보드를 읽었다. 보내지는 않는다.
   */
  const deliver = async (kind: "annotation" | "screenshot", blob: Blob): Promise<boolean> => {
    setBusy(true); setNotice(null);
    try {
      if (onAttach) {
        onAttach([new File([blob], `browser-${kind}-${Date.now()}.png`, { type: "image/png" })]);
        setInfo(t("terminal.browser.deliveredChat"));
        return true;
      }
      if (!terminalPaste) return false;
      const response = await post(pasteTargetId ?? scopeId, "paste", { data: await base64Of(blob) });
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
    const canvas = documentFor.createElement("canvas");
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d"); if (!ctx) return null;
    ctx.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight);
    draw?.(ctx, image.naturalWidth / shownFrame.width, image.naturalWidth);
    const dataUrl = canvas.toDataURL("image/png").split(",")[1] ?? "";
    return new Blob([Uint8Array.from(atob(dataUrl), (char) => char.charCodeAt(0))], { type: "image/png" });
  };
  const attachScreenshot = () => {
    // 뷰에는 이미지가 없다 — 서버가 한 장을 찍어 준다(CSS px 크기의 PNG).
    void fetch(`${base(BROWSER_GLOBAL_ID)}/screenshot`).then(async (response) => {
      if (!response.ok) { setNotice(t("terminal.browser.requestFailed")); return; }
      const shot = await response.json() as { data: string };
      const bytes = Uint8Array.from(atob(shot.data), (char) => char.charCodeAt(0));
      await deliver("screenshot", new Blob([bytes], { type: "image/png" }));
    }).catch(() => setNotice(t("terminal.browser.requestFailed")));
  };
  /** 주석·첨부는 보이는 화면이 있어야 한다 — 탭이 열려 있으면 그 자리에서 한 장을 찍을 수 있다. */
  const captureReady = activeTab !== null && (onAttach !== undefined || terminalPaste);

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
  /** 원 스냅샷 좌표를 비율로 놓아, 문서 전환·본문 크기 변경에도 같은 지점을 가리킨다. */
  const stagePoint = (p: { x: number; y: number }) => ({ left: `${shownFrame ? p.x / shownFrame.width * 100 : 0}%`, top: `${shownFrame ? p.y / shownFrame.height * 100 : 0}%` });
  // 말풍선은 핀 아래에 선다 — 좁은 패널에서 오른쪽으로 밀리면 핀을 덮기 때문이다.
  const commentStyle = (p: { x: number; y: number }) => { const at = stagePoint(p); return { left: `clamp(8px, calc(${at.left} - 14px), max(8px, calc(100% - 328px)))`, top: `calc(${at.top} + 18px)` }; };

  const setViewport = (preset: Viewport["preset"]) => { void run("viewport", { preset }); };
  // ---- Chrome 에서 가져오기 — 창을 든 기계의 Chrome 프로필을 셸이 세고, 고른 프로필의 쿠키를 이 Objective 의 세션에 넣는다 ----
  const openImport = async () => {
    if (chromeImportUnavailable()) return;
    const loaded = await loadChromeImportSources(t);
    if ("error" in loaded) { setNotice(loaded.error); return; }
    setImportSources(loaded.sources);
  };
  const runImport = async (profileId: string) => {
    const result = await run<{ cookies: number; history: number; cookiesFailed: boolean; historyFailed: boolean }>("import", { profileId });
    if (!result) return false;
    setImportSources(null);
    setInfo(t(result.cookiesFailed ? "terminal.browser.import.historyOnly" : result.historyFailed ? "terminal.browser.import.cookiesOnly" : "terminal.browser.import.done", { count: String(result.cookies), history: String(result.history) }));
    return true;
  };
  // ---- 세션 고르기 — 임시(null)이거나 내 프로필이거나. 세션은 살아 있는 뷰에 바꿔 끼울 수 없어 탭을 닫고 다시 연다 ----
  const applyProfile = async (next: string | null) => {
    setProfileBusy(true);
    try {
      const ok = await run<BrowserState>("profile", { profile: next });
      // 세션을 바꾼 그 순간이 기본값이 필요하다고 느끼는 순간이다 — 기본이 이미 같으면 붙이지 않는다.
      if (ok) setInfo({ text: next ? t("terminal.browser.profile.switchedPersistent") : t("terminal.browser.profile.switchedEphemeral"), ...(ok.defaultProfile !== next ? { action: { label: t("terminal.browser.profile.alsoDefault"), run: () => { void setDefaultProfile(next); } } } : {}) });
    } finally { setProfileBusy(false); setProfileSwitch(undefined); }
  };
  /** 새 Objective 의 기본 세션. Console 전체의 값이라 Objective 경로가 아니다; 답은 모든 패널의 스트림으로 온다. */
  const setDefaultProfile = async (next: string | null) => {
    setNotice(null);
    try {
      const response = await fetch("/api/v1/browser/default-profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile: next }) });
      if (!response.ok) { await fail(response); return; }
      setInfo(next ? t("terminal.browser.profile.defaultPersistent") : t("terminal.browser.profile.defaultEphemeral"));
    } catch { setNotice(t("terminal.browser.requestFailed")); }
  };
  const chooseProfile = (next: string | null) => {
    if ((state?.profile ?? null) === next) return;
    // 탭이 열려 있으면 먼저 확인을 받는다 — 전환은 그 탭들을 닫는 일이다.
    if ((state?.tabs.length ?? 0) > 0) { setProfileSwitch(next); return; }
    void applyProfile(next);
  };
  const runClearProfile = async () => {
    setProfileBusy(true);
    try {
      const ok = await run<{ cleared: string }>("clear-profile", { profile: BROWSER_PROFILE });
      if (ok) setInfo(t("terminal.browser.profile.cleared"));
    } finally { setProfileBusy(false); setClearingProfile(false); }
  };
  const toggleMode = (next: Mode) => setMode((current) => current === next ? "none" : next);

  // 캡션(탭 스트립)이 읽는 스냅샷 — 상태와 손잡이를 함께 올린다. 언마운트하면 거둔다.
  React.useEffect(() => {
    if (inactive) return;
    publishBrowserPanel(objectiveId, {
      tabs: available ? state?.tabs ?? [] : [], activeTabId: available ? state?.activeTabId ?? null : null, driving: state?.driving === true,
      spaces: available ? state?.spaces ?? [] : [], homeSpaceId, displayedSpaceId: available ? state?.displayedSpaceId ?? null : null,
      viewport: state ? { width: state.viewport.width, height: state.viewport.height, preset: state.viewport.preset, setBy: state.viewport.setBy } : null,
      busy,
      available,
      profile: available ? state?.profile ?? null : null,
      defaultProfile: state?.defaultProfile ?? null,
      actions: {
        selectTab: (tabId) => { void run("tabs", { action: "select", tabId }); },
        closeTab: (tabId) => { void run("tabs", { action: "close", tabId }); },
        // 사람이 연 탭은 어느 그룹에도 속하지 않는다 — 서버가 사람 스페이스에 연다.
        createTab: () => { void run("tabs", { action: "create" }); setEditingUrl(true); },
        selectSpace: (spaceId) => { void run("space", { spaceId }); },
        openImport: () => { void openImport(); },
        setViewport,
        chooseProfile,
        setDefaultProfile: (profile) => { void setDefaultProfile(profile); },
        openClearProfile: () => setClearingProfile(true),
      },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 손잡이는 매 렌더 새로 만들어도 같은 뜻이다; 상태·busy 가 바뀔 때만 올린다.
  }, [objectiveId, state, busy, available, homeSpaceId, inactive]);
  React.useEffect(() => () => publishBrowserPanel(objectiveId, null), [objectiveId]);
  // 대화를 열면 그 대화의 그룹을 띄운다 — 다른 대화에서 보던 스페이스가 화면에 남아 있어도 이 대화의 탭으로 돌아온다.
  // 이 대화의 그룹은 탭이 있거나 에이전트가 쓰는 중일 때만 있다: 없으면 건드리지 않는다(빈 그룹을 만들어 띄우지 않는다).
  // 열 때 한 번뿐이다: 그 뒤 사람이 다른 스페이스를 고르면 그대로 둔다.
  const homedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    // 분리 창은 문맥을 따라가지 않는다 — 어느 대화를 보든 창이 보던 스페이스에 그대로 머문다.
    if (!available || !state || homeSpaceId === null || inactive || host) return;
    const key = `${objectiveId}|${homeSpaceId}`;
    if (homedRef.current === key) return;
    homedRef.current = key;
    if (state.displayedSpaceId !== homeSpaceId && state.spaces.some((space) => space.id === homeSpaceId)) void run("space", { spaceId: homeSpaceId });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run 은 매 렌더 새로 만들어도 같은 뜻이다.
  }, [available, state, homeSpaceId, objectiveId, inactive, host]);

  // CLI·채팅에서 고른 주소. 문을 누른 순간 이 패널이 마운트되므로 요청이 먼저 놓여 있고, 엔진이 아직
  // 뜨는 중이면 열 수 있게 될 때까지 기다린다. 링크는 새 탭에서 열고, 빈 탭만 그 자리에서 쓴다 —
  // 사람이 보던 페이지를 링크 하나가 밀어내지 않게.
  const openRequest = useBrowserOpenRequest();
  React.useEffect(() => {
    if (!openRequest || !available || inactive) return;
    takeBrowserOpenRequest(openRequest.serial);
    // 링크는 사람 탭으로 간다 — 사람이 보는 탭이 에이전트 그룹의 빈 탭이면 그 탭을 쓰지 않고 새 탭을 연다.
    const intoActiveTab = activeTab === null || (activeTab.url === "about:blank" && activeTab.spaceId === HUMAN_SPACE_ID);
    void run(intoActiveTab ? "navigate" : "tabs", intoActiveTab ? { url: openRequest.url } : { action: "create", url: openRequest.url });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 탭 상태는 요청이 도착한 그 순간의 것으로 읽는다; 탭이 바뀔 때마다 다시 열지 않는다.
  }, [openRequest?.serial, available, inactive]);
  // 패널을 닫으면 아직 못 연 요청도 함께 거둔다 — 다음에 여는 브라우저가 옛 링크로 열리지 않게.
  React.useEffect(() => inactive ? undefined : () => dropBrowserOpenRequest(), [inactive]);

  const highlightBox = (element: ElementInfo | null) => {
    const factor = layoutScale();
    if (!element || !factor) return null;
    return { left: element.box.x / factor.x, top: element.box.y / factor.y, width: element.box.width / factor.x, height: element.box.height / factor.y };
  };
  const hoverInfo = draftPin?.element ?? hover;
  const hoverBox = highlightBox(hoverInfo);
  const navTail = React.useContext(BrowserNavTailContext);
  // 작업대가 주소줄 줄을 맨 위 줄에 세우라고 하면(`navHost` 가 요소이거나 null) 칸 안에는 그리지 않는다. 맨 위 줄의 영역 폭은 칸 폭이 아니므로
  // 좁아지면 캡처·주석·세션·뷰포트가 「⋯」 하나로 모인다(`navFolded`) — 줄의 실제 폭을 재어 정한다.
  const navHost = React.useContext(BrowserNavHostContext);
  // 분리 창에서는 주소줄 줄이 그 창의 맨 위 줄(caption)에 선다 — 맨 위 줄에 선 것과 같은 모양이다.
  const navTop = navHost !== undefined || host;
  const navRef = React.useRef<HTMLDivElement | null>(null);
  const [navFolded, setNavFolded] = React.useState(false);
  const hasCapture = activeTab !== null && activeTab.url !== "about:blank";
  React.useLayoutEffect(() => {
    const nav = navRef.current;
    if (!navTop || nav === null) { setNavFolded(false); return; }
    const measure = () => {
      const style = getComputedStyle(nav);
      const avail = nav.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0);
      if (avail <= 0) return;
      const gap = Number.parseFloat(style.columnGap) || 0;
      const kids = Array.from(nav.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
      // 접히지 않는 줄의 폭 — 주소창은 최소 폭(NAV_URL_MIN_PX)으로 센다.
      let used = gap * Math.max(0, kids.length - 1);
      let foldWidth = 0;
      for (const kid of kids) {
        const width = kid.classList.contains("op-browser__url") ? NAV_URL_MIN_PX : kid.getBoundingClientRect().width;
        used += width;
        if (kid.classList.contains("op-browser__fold")) foldWidth = width;
      }
      // 접혀 있으면 펼쳤을 때의 폭을 센다(「⋯」 하나가 단추 n 개로 바뀐다) — 접힘 여부가 판정을 흔들지 않는다.
      const unit = kids.find((kid) => kid.classList.contains("op-browser__reload"))?.getBoundingClientRect().width ?? NAV_ICON_PX;
      const count = 3 + (hasCapture ? 1 : 0);
      const need = navFolded ? used - foldWidth + count * unit + (count - 1) * gap : used;
      const next = need > avail + 0.5;
      setNavFolded((current) => current === next ? current : next);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(nav);
    return () => observer?.disconnect();
  }, [navTop, navHost, navFolded, hasCapture, navTail !== null]);
  const closedDoor = !available ? unavailableText(t, state?.reason ?? null, services.isDesktopShell()) : null;

  const navBar = (
    <div ref={navRef} className={`op-browser__nav${navTop ? " is-top" : ""}`}>
      <button type="button" className="op-browser__icon" aria-label={t("terminal.browser.back")} disabled={!activeTab?.canGoBack || busy} onClick={() => void run("navigate", { url: "back" })}>←</button>
      <button type="button" className="op-browser__icon" aria-label={t("terminal.browser.forward")} disabled={!activeTab?.canGoForward || busy} onClick={() => void run("navigate", { url: "forward" })}>→</button>
      <button type="button" className={`op-browser__icon op-browser__reload${activeTab?.loading ? " is-loading" : ""}`} aria-label={t("terminal.browser.reload")} disabled={!activeTab || busy} onClick={() => void run("navigate", { url: "reload" })}><ReloadGlyph /></button>
      <form className={`op-browser__url${!editingUrl && urlDraft ? " is-display" : ""}`}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) { setEditingUrl(false); dismissSuggestions(); } }}
        onSubmit={(event) => { event.preventDefault(); if (!composingUrlRef.current) submitUrl(); }}>
        {!editingUrl && urlDraft ? <span className="op-browser__url-display" aria-hidden="true"><UrlParts url={urlDraft} /></span> : null}
        <input
          id={`op-browser-url-${objectiveId}`}
          className="op-browser__url-input"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={t("terminal.browser.urlPlaceholder")}
          aria-label={t("terminal.browser.pageUrl")}
          value={urlDraft}
          disabled={!available}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={suggestionsOpen}
          aria-controls={suggestionsOpen ? suggestionsId : undefined}
          aria-activedescendant={suggestionsOpen && selectedSuggestion >= 0 ? `${suggestionsId}-${selectedSuggestion}` : undefined}
          onFocus={(event) => { setEditingUrl(true); event.currentTarget.select(); }}
          aria-describedby={suggestionPromptOpen ? `${suggestionsId}-disclosure` : undefined}
          onChange={(event) => {
            suggestionRequest.current?.abort();
            setEditingUrl(true);
            urlDirty.current = true;
            sharedDraft = event.target.value;
            setUrlDraft(event.target.value);
            setSuggestions([]);
            setHistorySuggestions([]);
            setSelectedSuggestion(-1);
            setSuggestQuery(event.target.value);
          }}
          onCompositionStart={() => { composingUrlRef.current = true; setComposingUrl(true); dismissSuggestions(); }}
          onCompositionEnd={(event) => { composingUrlRef.current = false; setComposingUrl(false); setUrlDraft(event.currentTarget.value); setSuggestQuery(event.currentTarget.value); }}
          onKeyDown={(event) => {
            if (composingUrlRef.current || event.nativeEvent.isComposing || event.keyCode === 229) {
              if (event.key === "Enter") event.preventDefault();
              return;
            }
            if (event.key === "Escape") {
              urlDirty.current = false;
              sharedDraft = null;
              event.preventDefault(); dismissSuggestions(); setEditingUrl(false); event.currentTarget.blur();
            } else if (suggestionsOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              setSelectedSuggestion((index) => event.key === "ArrowDown"
                ? (index + 1) % suggestions.length
                : (index <= 0 ? suggestions.length : index) - 1);
            } else if (event.key === "Enter" && suggestionsOpen && selectedSuggestion >= 0) {
              event.preventDefault(); submitUrl(suggestions[selectedSuggestion]?.value);
            }
          }}
        />
        {suggestionPromptOpen ? (
          <div className="op-browser__suggestions op-browser__suggestion-prompt" {...COVERS_NATIVE_VIEW}>
            <span id={`${suggestionsId}-disclosure`}>{t("terminal.browser.suggestions.disclosure")}</span>
            <div className="op-browser__suggestion-actions">
              <button type="button" className="op-browser__suggestion" disabled={suggestionSettings.saving} onMouseDown={(event) => event.preventDefault()} onClick={(event) => { event.currentTarget.form?.querySelector("input")?.focus(); void saveSuggestionSettings(true); }}>{t("terminal.browser.suggestions.enable")}</button>
              <button type="button" className="op-browser__suggestion" disabled={suggestionSettings.saving} onMouseDown={(event) => event.preventDefault()} onClick={(event) => { event.currentTarget.form?.querySelector("input")?.focus(); void saveSuggestionSettings(false); }}>{t("terminal.browser.suggestions.dismiss")}</button>
            </div>
            {suggestionSettings.failed ? <span role="alert">{t("terminal.browser.suggestions.settingsFailed")}</span> : null}
          </div>
        ) : null}
        {suggestionsOpen ? (
          <div id={suggestionsId} className="op-browser__suggestions" role="listbox" {...COVERS_NATIVE_VIEW} aria-label={t("terminal.browser.suggestions.title")}>
            {suggestions.map((suggestion, index) => (
              <button
                key={`${suggestion.historyId ?? "search"}:${suggestion.value}`}
                id={`${suggestionsId}-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={selectedSuggestion === index}
                className="op-browser__suggestion op-browser__suggestion-result"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => { if (!composingUrlRef.current) submitUrl(suggestion.value); }}
              ><SuggestionIcon suggestion={suggestion} /><span className="op-browser__suggestion-label">{suggestion.title}{suggestion.historyId ? <small>{suggestion.value}</small> : null}</span></button>
            ))}
          </div>
        ) : null}
        {activeTab && activeTab.url !== "about:blank" ? <a className="op-browser__url-external" href={activeTab.url} target="_blank" rel="noreferrer noopener" data-fleet-link={FLEET_LINK_NATIVE} aria-label={t("terminal.browser.openExternal")} title={t("terminal.browser.openExternal")}><ExternalGlyph /></a> : null}
      </form>
      {navFolded ? (
        <NavFoldMenu objectiveId={objectiveId} label={t("terminal.browser.moreTools")}>
          {activeTab && activeTab.url !== "about:blank" ? <button type="button" className="op-browser__icon" aria-label={t("terminal.browser.attachScreenshot")} title={t("terminal.browser.attachScreenshot")} disabled={busy || !captureReady} onClick={attachScreenshot}><CameraGlyph /></button> : null}
          <button type="button" className="op-browser__icon op-browser__tool" aria-pressed={mode === "annotate"} aria-label={mode === "annotate" ? t("terminal.browser.exitAnnotate") : t("terminal.browser.annotate")} title={mode === "annotate" ? t("terminal.browser.exitAnnotate") : t("terminal.browser.annotate")} disabled={!captureReady} onClick={() => toggleMode("annotate")}><CommentGlyph /></button>
          <BrowserTools objectiveId={objectiveId} language={language} />
        </NavFoldMenu>
      ) : (
        <>
          {activeTab && activeTab.url !== "about:blank" ? <button type="button" className="op-browser__icon" aria-label={t("terminal.browser.attachScreenshot")} title={t("terminal.browser.attachScreenshot")} disabled={busy || !captureReady} onClick={attachScreenshot}><CameraGlyph /></button> : null}
          <button type="button" className="op-browser__icon op-browser__tool" aria-pressed={mode === "annotate"} aria-label={mode === "annotate" ? t("terminal.browser.exitAnnotate") : t("terminal.browser.annotate")} title={mode === "annotate" ? t("terminal.browser.exitAnnotate") : t("terminal.browser.annotate")} disabled={!captureReady} onClick={() => toggleMode("annotate")}><CommentGlyph /></button>
          <BrowserTools objectiveId={objectiveId} language={language} />
        </>
      )}
      {detached.available && !host ? <button type="button" className={`op-browser__icon${detached.failed ? " op-browser__detach-failed" : ""}`} disabled={detached.disabled} onMouseDown={(event) => event.preventDefault()} onClick={detached.toggle} aria-label={t("terminal.browser.detach")} title={t(detached.failed ? "terminal.browser.detachFailed" : "terminal.browser.detach")}>↗</button> : null}
      {!host ? navTail : null}
    </div>
  );

  // 다른 화면이 분리 창을 쥐고 있으면 그 사실만, 이 Console 이 분리했으면 되돌리기만 보인다 — 화면과 입력은 창 안의 패널 하나가 가진다.
  if (detached.blocked) return <div className="op-browser__detached">{t("terminal.browser.detached")}</div>;
  if (surfaceOpen && !host) return <div className="op-browser__detached"><button type="button" className="op-browser__button" onClick={detached.toggle}>{t("terminal.browser.reattach")}</button></div>;
  const content = (
    <div className={`op-browser${state?.driving ? " is-driving" : ""}`}>
      {host
        ? <BrowserSurfaceContent role="caption">{navBar}</BrowserSurfaceContent>
        : navTop ? (navHost === null || navHost === undefined ? null : createPortal(navBar, navHost)) : navBar}
      <div className="op-browser__body">
        {available ? <BrowserTabRail objectiveId={objectiveId} language={language} /> : null}
        <div className={`op-browser__viewport is-${state?.viewport.preset ?? "responsive"}${mode === "annotate" ? " is-annotating" : ""}`} ref={viewportRef}>
          {notice ? <div className="op-browser__toast is-error" role="alert">{notice}</div> : info ? (
            <div className={`op-browser__toast${info.action ? " has-action" : ""}`} role="status">
              {info.text}
              {info.action ? <button type="button" className="op-browser__toast-action" onClick={() => { const action = info.action; if (!action) return; setInfo(null); action.run(); }}>{info.action.label}</button> : null}
            </div>
          ) : null}
          {importSources ? <ChromeImportDialog t={t} sources={importSources} persistent={Boolean(state?.profile)} onClose={() => setImportSources(null)} onImport={runImport} /> : null}
          {/* 세션 전환 — 전환은 열린 탭을 닫는 일이므로 무엇이 사라지는지 먼저 말한다. */}
          {profileSwitch !== undefined ? (
            <div className="op-browser__scrim" onClick={() => { if (!profileBusy) setProfileSwitch(undefined); }}>
              <div className="op-browser__dialog" role="dialog" aria-modal="true" aria-label={t(profileSwitch ? "terminal.browser.profile.switchToProfile" : "terminal.browser.profile.switchToEphemeral")} onClick={(event) => event.stopPropagation()}>
                <div className="op-browser__dialog-head">
                  <div>
                    <h3>{t(profileSwitch ? "terminal.browser.profile.switchToProfile" : "terminal.browser.profile.switchToEphemeral")}</h3>
                    <p>{t("terminal.browser.profile.switchBody", { count: String(state?.tabs.length ?? 0) })}</p>
                  </div>
                </div>
                <div className="op-browser__dialog-item">
                  <span className="op-browser__dialog-glyph" aria-hidden="true">{profileSwitch ? <ProfileGlyph /> : <EphemeralGlyph />}</span>
                  <span>
                    <strong>{t(profileSwitch ? "terminal.browser.profile.persistent" : "terminal.browser.profile.ephemeral")}</strong>
                    <span className="op-browser__help">{t(profileSwitch ? "terminal.browser.profile.persistentHelp" : "terminal.browser.profile.ephemeralHelp")}</span>
                  </span>
                </div>
                <div className="op-browser__dialog-actions">
                  <button type="button" className="op-browser__button" disabled={profileBusy} onClick={() => setProfileSwitch(undefined)}>{t("terminal.browser.import.cancel")}</button>
                  <button type="button" className="op-browser__button op-browser__button--primary" disabled={profileBusy} onClick={() => void applyProfile(profileSwitch)}>{t("terminal.browser.profile.switchRun")}</button>
                </div>
              </div>
            </div>
          ) : null}
          {/* 비우기 — 이 기계의 프로필 전체를 지운다. 되돌릴 수 없으므로 범위를 먼저 말한다. */}
          {clearingProfile ? (
            <div className="op-browser__scrim" onClick={() => { if (!profileBusy) setClearingProfile(false); }}>
              <div className="op-browser__dialog" role="dialog" aria-modal="true" aria-label={t("terminal.browser.profile.clearTitle")} onClick={(event) => event.stopPropagation()}>
                <div className="op-browser__dialog-head">
                  <div><h3>{t("terminal.browser.profile.clearTitle")}</h3><p>{t("terminal.browser.profile.clearBody")}</p></div>
                </div>
                <div className="op-browser__dialog-item">
                  <span className="op-browser__dialog-glyph" aria-hidden="true"><ProfileGlyph /></span>
                  <span><strong>{t("terminal.browser.profile.persistent")}</strong><span className="op-browser__help">{t("terminal.browser.profile.clearScope")}</span></span>
                </div>
                <div className="op-browser__dialog-actions">
                  <button type="button" className="op-browser__button" disabled={profileBusy} onClick={() => setClearingProfile(false)}>{t("terminal.browser.import.cancel")}</button>
                  <button type="button" className="op-browser__button op-browser__button--danger" disabled={profileBusy} onClick={() => void runClearProfile()}>{t("terminal.browser.profile.clearRun")}</button>
                </div>
              </div>
            </div>
          ) : null}
          {mode === "annotate" && shownFrame ? (
            // 이전 문서에서 찍은 장도 현재 본문 너비·높이 안에 같은 비율로 맞춘다.
            <>
            <div className="op-browser__stage" style={{ aspectRatio: `${shownFrame.width} / ${shownFrame.height}`, width: `min(${shownFrame.width}px, calc(100cqh * ${shownFrame.width} / ${shownFrame.height}))`, maxWidth: "100%" }}>
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
                    <button type="button" className="op-browser__comment-ok" aria-label={t("terminal.browser.commentAdd")} title={t("terminal.browser.commentAdd")} disabled={!draftText.trim()} onClick={confirmPin}><MenuCheckGlyph /></button>
                  </div>
                </>
              ) : null}
            </div>
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
            </>
          ) : activeTab ? (
            // 네이티브 뷰가 이 자리 위에 그려진다 — 주차(parking) 중에는 마지막 화면(still-frame)을 배경으로 둔다.
            <div className="op-browser__native" ref={nativeRef} aria-hidden="true" {...{ [NATIVE_FLOAT_TARGET_ATTRIBUTE]: BROWSER_GLOBAL_ID }}>
              {shownBackdrop ? (
                <img
                  className="op-browser__backdrop"
                  src={`data:${shownBackdrop.mime};base64,${shownBackdrop.data}`}
                  alt=""
                  draggable={false}
                />
              ) : null}
            </div>
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
    </div>
  );
  return host ? <BrowserSurfaceContent role="body">{content}</BrowserSurfaceContent> : content;
}
