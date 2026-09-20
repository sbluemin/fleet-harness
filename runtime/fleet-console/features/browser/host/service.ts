import crypto from "node:crypto";
import { capturePixels } from "./capture-geometry.js";
import type { BrowserTarget, BrowserElementState } from "./semantic.js";
import { CdpError, type CdpClient, type CdpEvent } from "./cdp.js";
import { modifierBits, parseKeyChord, type Modifiers } from "./keys.js";
import type { DesktopEngine } from "./desktop-engine.js";
import { DESKTOP_BROWSER_CHROME_PROFILES, DESKTOP_BROWSER_CLEAR_PROFILE, DESKTOP_BROWSER_DEFAULT_PROFILE, DESKTOP_BROWSER_IMPORT_COOKIES, type DesktopBrowserBounds } from "@fleet-console/protocol/desktop";

/**
 * Operation Browser — Operation마다 격리된 브라우저 컨텍스트(쿠키·스토리지 파티션)와 탭을 소유하는
 * Console 서비스. 사람(패널)과 에이전트(MCP)가 같은 탭을 본다.
 *
 * 정책 세 줄:
 * - 브라우저는 Fleet Desktop 앱의 기능이다. 탭은 창을 든 Desktop 안의 실제 Chromium 뷰로 그려지며, Console 은
 *   Chrome 을 찾거나 띄우지 않는다. 브라우저 탭·모바일로 연 Console 에서는 열리지 않는다.
 * - Desktop 이 아닌 클라이언트(브라우저 탭·모바일)가 이 Console 에 붙어 있는 동안은 멈춘다 — 붙는 순간 열린 탭을
 *   모두 닫는다. 그 화면에는 뷰가 없으므로 에이전트가 무엇을 하는지 사람이 볼 수 없기 때문이다.
 * - 뷰를 그리는 창은 제어를 쥔 쪽이다. 원격 Desktop 이 제어를 쥐면 그 창이, 아니면 이 기계의 창이 그린다.
 *   사람은 어디든 갈 수 있고 에이전트도 http(s) 어디든 간다.
 */

export const BROWSER_DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
const MAX_TABS = 8;
const IDLE_SHUTDOWN_MS = 5 * 60_000;
const CONSOLE_RING = 500;
const NETWORK_RING = 400;
const BODY_LIMIT = 64 * 1024;
const TEXT_LIMIT = 200_000;

/** 브라우저를 쓸 수 없는 까닭. 도구·패널·글리프가 같은 낱말로 안내한다. */
export type BrowserUnavailableReason = "desktop_required" | "shared";
export interface BrowserAvailability {
  readonly available: boolean;
  readonly reason: BrowserUnavailableReason | null;
  /** 뷰를 그릴 셸 — `"local"` 은 이 기계의 창, 그 밖은 원격 세션의 공개 이름. 붙어 있지 않아도 정책상의 답이다. */
  readonly host: string | null;
}

export type ViewportPreset = "responsive" | "mobile" | "tablet";
export interface BrowserViewport { readonly width: number; readonly height: number; /** 뷰가 놓인 화면의 배율 — 스크린샷 픽셀을 CSS px 로 되돌릴 때 쓴다. */ readonly scale: number; readonly preset: ViewportPreset; readonly setBy: "user" | "agent" | null; readonly colorScheme: "light" | "dark" | null }
export interface BrowserTabState { readonly id: string; readonly url: string; readonly title: string; readonly favicon: string | null; readonly loading: boolean; readonly canGoBack: boolean; readonly canGoForward: boolean }
export interface BrowserOperationState {
  readonly operationId: string;
  /** 이 Operation 이 쓰는 영속 프로필. `null` 이면 임시 세션이다 — 닫히면 로그인이 사라진다. */
  readonly profile: string | null;
  readonly tabs: readonly BrowserTabState[];
  readonly activeTabId: string | null;
  readonly viewport: BrowserViewport;
  readonly driving: boolean;
  readonly consoleErrors: number;
  readonly engine: "idle" | "starting" | "ready" | "failed";
  readonly engineError: string | null;
  /** 지금 브라우저를 열 수 있는가. 아니면 `reason` 이 왜인지 말한다 — 패널은 그 문장을 보이고 탭은 이미 닫혀 있다. */
  readonly available: boolean;
  readonly reason: BrowserUnavailableReason | null;
}
/**
 * 상태를 듣는 쪽. 구독은 Operation 마다가 아니라 서비스 하나에 걸린다 — 화면으로 나가는 길이 이미 열려 있는 Operation
 * 스트림 하나이기 때문이다. 브라우저 상태만을 위해 화면이 스트림을 하나 더 열면 그 연결이 origin 당 여섯 개뿐인
 * 예산을 먹고, 다 차는 순간 그 화면에서 나가는 모든 요청이 큐에 갇힌다.
 */
export type BrowserStateListener = (state: BrowserOperationState) => void;

export interface ConsoleEntry { readonly at: number; readonly level: string; readonly text: string; readonly url?: string; readonly line?: number }
export interface NetworkEntry { requestId: string; loaderId: string; at: number; method: string; url: string; type: string; status: number | null; mimeType: string | null; size: number; failed: string | null; finished: boolean }

export interface ChromeImportSources { readonly available: boolean; readonly reason: "chrome_required" | "no_profiles" | null; readonly profiles: readonly { readonly id: string; readonly name: string; readonly account: string | null }[] }

/** Chrome 에서 가져오기가 실패한 까닭별 안내 문장. 여기 없는 까닭은 "사본을 열지 못했다"로 묶인다. */
const CHROME_IMPORT_FAILURES: Record<string, string> = {
  chrome_required: "Importing needs Google Chrome installed on the computer that shows this browser.",
  chrome_profile_not_found: "That Chrome profile no longer exists.",
  chrome_cookies_missing: "That Chrome profile has no cookie database.",
  chrome_cookies_locked: "Google Chrome is holding its cookie database open. Quit Chrome on that computer, then import again.",
  chrome_import_invalid: "The Desktop shell rejected the import request.",
};

export class BrowserPolicyError extends Error {
  constructor(readonly code: string, message: string, readonly detail: Record<string, unknown> = {}) { super(message); this.name = "BrowserPolicyError"; }
}

interface Tab {
  readonly id: string;
  readonly targetId: string;
  sessionId: string;
  url: string;
  title: string;
  /** 페이지가 선언한 아이콘 URL. 클라이언트는 서버 프록시로 받는다(CSP img-src 가 self 뿐이라). */
  favicon: string | null;
  /** 메인 프레임 id — 로딩 표시는 이 프레임만 따른다(광고·위젯 iframe 이 끝없이 돌아도 새로고침 글리프가 돌지 않게). */
  frameId: string | null;
  loading: boolean;
  history: { index: number; length: number; leadingBlank: boolean };
  console: ConsoleEntry[];
  consoleErrors: number;
  network: Map<string, NetworkEntry>;
  refs: Map<string, number>;
}

interface OperationBrowser {
  readonly operationId: string;
  contextId: string;
  /** 사람이 고른 세션의 정체. 기본은 임시(`null`) — 에이전트가 모는 브라우저라 로그인이 기본으로 남으면 안 된다. */
  profile: string | null;
  tabs: Map<string, Tab>;
  activeTabId: string | null;
  viewport: BrowserViewport;
  /**
   * 셸이 놓은 네이티브 뷰의 실제 CSS px. 에뮬레이션(프리셋·임의 크기)과 분리한다 — 반응형으로 돌아올 때
   * 직전 모바일/태블릿 숫자를 붙잡지 않도록 항상 갱신한다.
   */
  pane: { width: number; height: number; scale: number } | null;
  /** true 이면 논리 뷰포트가 네이티브 pane 을 따른다(에뮬레이션 없음). */
  viewportFollowsPane: boolean;
  /** 에이전트 사용 세션 — 첫 도구 호출에 열리고 턴 종료·중단·회수·유휴로 닫힌다. 호출 사이에도 유지된다. */
  agentSession: { since: number; lastCallAt: number; idle: ReturnType<typeof setTimeout> | null } | null;
  /** 「중단」이 눌린 횟수 — 배치처럼 여러 호출로 이어지는 실행이 중단을 건너뛰지 못하게 세대를 비교한다. */
  interruptSerial: number;
  /** 에이전트가 누르고 있는 포인터 버튼 — 드래그 동안 mouseMoved 가 버튼을 실어야 한다. */
  pointer: { button: "left" | "right" | "middle"; buttons: number } | null;
  /**
   * 아직 `tabs` 에 들어가지 못한, 만드는 중인 탭의 수. 뷰가 붙기를 기다리는 동안 이 Operation 의 마지막 탭이
   * 닫히면 「탭이 없다」로 읽혀 컨텍스트가 거둬지고, 붙는 중이던 뷰가 그 자리에서 죽는다. 사람과 에이전트가
   * 같은 탭을 함께 쓰므로 이 겹침은 실제로 일어난다.
   */
  pendingTabs: number;
  agentCalls: Set<AbortController>;
}

/** 클릭이 CDP 로 나갔다는 사실과 그 좌표의 히트 진단. 성공(페이지가 반응했는지)을 추정하지 않는다. */
export interface BrowserClickDispatch {
  readonly dispatched: true;
  readonly x: number;
  readonly y: number;
  readonly button: "left" | "right" | "middle";
  readonly clickCount: number;
  readonly ref: string | null;
  readonly hit: { readonly tag: string; readonly id: string | null; readonly text: string; readonly disabled: boolean; readonly selector: string } | null;
  readonly note: string | null;
}

/**
 * resize_window / 패널 프리셋이 논리 뷰포트 크기를 어떻게 정할지. pane(실측)과 에뮬레이션을 섞지 않는다.
 * - mobile/tablet → 고정 프리셋, 에뮬레이션
 * - responsive + width/height → 요청 크기 에뮬레이션(실측 pane 과 무관)
 * - responsive 단독 → 네이티브 pane(없으면 현재 값 유지), 에뮬레이션 해제
 */
export function resolveBrowserViewportSize(input: {
  readonly preset: ViewportPreset;
  readonly width?: number;
  readonly height?: number;
  readonly current: { readonly width: number; readonly height: number };
  readonly pane: { readonly width: number; readonly height: number } | null;
}): { readonly width: number; readonly height: number; readonly followsPane: boolean } {
  if (input.preset === "mobile" || input.preset === "tablet") {
    const preset = PRESETS[input.preset];
    return { width: preset.width, height: preset.height, followsPane: false };
  }
  if (input.width !== undefined || input.height !== undefined) {
    return {
      width: clamp(input.width ?? input.current.width, 320, 3840),
      height: clamp(input.height ?? input.current.height, 240, 2400),
      followsPane: false,
    };
  }
  const pane = input.pane;
  if (pane) return { width: Math.max(1, Math.round(pane.width)), height: Math.max(1, Math.round(pane.height)), followsPane: true };
  return { width: input.current.width, height: input.current.height, followsPane: true };
}

/** 브라우저를 쓸 수 없을 때 도구·API 가 돌려주는 문장 — 까닭별로 사람이 무엇을 해야 하는지 말한다. */
export function unavailableMessage(reason: BrowserUnavailableReason | null): string {
  switch (reason) {
    case "shared": return "The Operation Browser is paused because this Console is also open in a regular browser or on a phone. It resumes once only Fleet Desktop windows remain.";
    default: return "The Operation Browser runs only inside the Fleet Desktop app, and no Desktop window is showing this Console.";
  }
}

export interface BrowserServiceDeps {
  readonly enabled: () => boolean;
  /** 지금 브라우저를 열 수 있는지와 뷰를 그릴 셸. 서버가 붙은 클라이언트들과 제어 보유자로 답한다. */
  readonly availability: () => BrowserAvailability;
  readonly log: (message: string) => void;
  /** 창을 든 Desktop 이 제공하는 네이티브 뷰 엔진 — 유일한 엔진이다. */
  readonly desktop: DesktopEngine;
}

export interface BrowserServiceStatus {
  readonly enabled: boolean;
  readonly available: boolean;
  readonly reason: BrowserUnavailableReason | null;
  readonly engine: "idle" | "starting" | "ready" | "failed";
  readonly engineError: string | null;
  readonly operations: readonly string[];
}

/** 페이지가 선언한 아이콘, 없으면 /favicon.ico. 페이지 안에서 평가되므로 상대 경로가 그 문서 기준으로 풀린다. */
const FAVICON_EXPRESSION = `(() => { const links = Array.from(document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]')); const pick = links.find((l) => /icon/i.test(l.rel) && !/apple/i.test(l.rel)) || links[0]; try { return new URL(pick ? pick.getAttribute("href") : "/favicon.ico", document.baseURI).href; } catch { return null; } })()`;

/** macOS 편집 단축키 → Chromium 편집 명령. cmd 단독 조합만 해당한다. */
function editCommand(key: string, mods: Modifiers): string | undefined {
  if (!mods.meta || mods.ctrl || mods.alt) return undefined;
  return { a: "selectAll", c: "copy", v: "paste", x: "cut", z: mods.shift ? "redo" : "undo" }[key.toLowerCase()];
}

/** 마지막 도구 호출 뒤 이만큼 조용하면 세션을 닫는다 — computer-use 와 같은 값. */
const AGENT_SESSION_IDLE_MS = 5 * 60_000;

const SEARCH_URL = "https://www.google.com/search?q=";
/** 스킴 없는 입력이 호스트처럼 보이는가 — 점이 있는 이름, localhost, IP, 포트. 아니면 검색어로 본다. */
const HOST_LIKE = /^(localhost|[a-z0-9-]+\.localhost|127(\.\d{1,3}){3}|\[::1\]|(\d{1,3}\.){3}\d{1,3}|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d{1,5})?([/?#].*)?$/i;

function parseUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // "localhost:4173" 은 URL 파서에게 localhost: 스킴이다 — 포트로 보이는 콜론은 스킴으로 치지 않는다.
  const hostPort = /^[a-z0-9.-]+:\d{1,5}(?:[/?#]|$)/i.test(trimmed);
  if (!hostPort) { try { const url = new URL(trimmed); if (["http:", "https:", "about:", "file:"].includes(url.protocol)) return url; } catch { /* 스킴 없음 */ } }
  if (!hostPort && /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  // 주소창은 브라우저처럼 동작한다 — 호스트가 아니면 기본 검색엔진(Google)으로 보낸다.
  if (!HOST_LIKE.test(trimmed)) { try { return new URL(`${SEARCH_URL}${encodeURIComponent(trimmed)}`); } catch { return null; } }
  try { return new URL(`${/^(localhost|127\.|\[::1\]|[a-z0-9.-]+\.localhost|(\d{1,3}\.){3}\d{1,3})/i.test(trimmed) ? "http" : "https"}://${trimmed}`); } catch { return null; }
}

const PRESETS: Record<Exclude<ViewportPreset, "responsive">, { width: number; height: number; mobile: boolean }> = {
  mobile: { width: 375, height: 812, mobile: true },
  tablet: { width: 768, height: 1024, mobile: true },
};

export class BrowserService {
  private client: CdpClient | null = null;
  private disposed = false;
  private engine: BrowserServiceStatus["engine"] = "idle";
  private engineError: string | null = null;
  private readonly operations = new Map<string, OperationBrowser>();
  private readonly stateListeners = new Set<BrowserStateListener>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** 셸의 Chromium 이 보고한 일반 Chrome UA 와 브랜드 메타데이터 — 엔진을 집을 때 만든다. */
  private identity: { userAgent: string; metadata: Record<string, unknown> } | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  /** 마지막으로 본 가용성 — 열림에서 닫힘으로 넘어가는 순간에만 탭을 접는다. */
  private lastAvailable: boolean | null = null;

  constructor(private readonly deps: BrowserServiceDeps) {}

  status(): BrowserServiceStatus {
    const { available, reason } = this.availability();
    return { enabled: this.deps.enabled(), available, reason, engine: this.engine, engineError: this.engineError, operations: [...this.operations.keys()] };
  }

  /** 정책의 답에 엔진의 실제 연결을 겹친다 — 호스트가 정해졌어도 그 셸이 붙어 있지 않으면 Desktop 이 없는 것이다. */
  availability(): BrowserAvailability {
    if (!this.deps.enabled()) return { available: false, reason: "desktop_required", host: null };
    const policy = this.deps.availability();
    if (!policy.available) return policy;
    if (!this.deps.desktop.connected) return { available: false, reason: "desktop_required", host: policy.host };
    return policy;
  }

  available(): boolean { return this.availability().available; }

  /**
   * 붙은 클라이언트·제어 보유자가 바뀌었다. 뷰를 그릴 셸을 엔진에 알리고, 브라우저를 쓸 수 없게 되었으면 열린 탭을
   * 모두 닫는다 — 브라우저 탭이 이 Console 에 붙는 순간이 그 예다. 상태는 늘 다시 알린다(패널이 문장을 바꾼다).
   */
  reconcile(): void {
    if (this.disposed) return;
    const policy = this.deps.availability();
    this.deps.desktop.setHost(policy.host);
    const available = this.availability().available;
    const closing = this.lastAvailable === true && !available;
    this.lastAvailable = available;
    if (closing) {
      this.deps.log("browser paused: closing every tab");
      for (const op of this.operations.values()) { for (const call of op.agentCalls) call.abort(); op.agentCalls.clear(); this.endAgentSession(op.operationId, "revoke"); }
      void this.stopEngine();
      return;
    }
    for (const op of this.operations.values()) this.emitState(op);
  }

  // ---------- 엔진 ----------

  private async engineClient(): Promise<CdpClient> {
    if (this.disposed) throw new BrowserPolicyError("browser_engine_busy", "Browser engine is busy.");
    if (this.client) return this.client;
    const { available, reason } = this.availability();
    if (!available) throw new BrowserPolicyError("browser_unavailable", unavailableMessage(reason), { reason });
    const desktop = this.deps.desktop;
    this.client = desktop;
    this.engine = "ready";
    this.engineError = null;
    this.identity = await browserIdentity(desktop).catch(() => null);
    this.unsubscribeEvents = desktop.on((event) => this.onEvent(event));
    void desktop.closed.then(() => { if (this.client === desktop) this.onEngineClosed(); });
    this.deps.log(`browser engine ready (desktop native view, host ${desktop.currentHost ?? "none"})`);
    return desktop;
  }

  private onEngineClosed(): void {
    this.client = null;
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    this.identity = null;
    if (this.engine !== "failed") this.engine = "idle";
    for (const op of this.operations.values()) {
      op.tabs.clear();
      op.activeTabId = null;
      op.contextId = "";
      this.emitState(op);
    }
  }

  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      const busy = [...this.operations.values()].some((op) => op.tabs.size > 0 || op.agentCalls.size > 0);
      if (!busy) void this.stopEngine();
    }, IDLE_SHUTDOWN_MS);
  }

  async stopEngine(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const client = this.client;
    this.client = null;
    if (client) await client.close();
    this.onEngineClosed();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const op of this.operations.values()) for (const call of op.agentCalls) call.abort();
    this.stateListeners.clear();
    await this.stopEngine();
    this.operations.clear();
  }

  // ---------- Operation 컨텍스트 ----------

  private observationSerial = 0;

  private operation(operationId: string): OperationBrowser {
    let op = this.operations.get(operationId);
    if (!op) {
      op = { operationId, contextId: "", profile: null, tabs: new Map(), activeTabId: null, viewport: { ...BROWSER_DEFAULT_VIEWPORT, scale: 1, preset: "responsive", setBy: null, colorScheme: null }, pane: null, viewportFollowsPane: true, agentCalls: new Set(), agentSession: null, interruptSerial: 0, pointer: null, pendingTabs: 0 };
      this.operations.set(operationId, op);
    }
    return op;
  }

  private async context(op: OperationBrowser): Promise<{ client: CdpClient; contextId: string }> {
    const client = await this.engineClient();
    if (!op.contextId) {
      const created = await client.send<{ browserContextId: string }>("Target.createBrowserContext", { disposeOnDetach: false, fleetProfile: op.profile });
      op.contextId = created.browserContextId;
    }
    return { client, contextId: op.contextId };
  }

  /** 패널이 알려 준 자기 자리 — 네이티브 뷰가 놓일 창 좌표. null 이면 감춘다. */
  place(operationId: string, placement: { bounds: DesktopBrowserBounds; visible: boolean } | null): void {
    this.operation(operationId);
    this.deps.desktop.place(operationId, placement);
  }

  state(operationId: string): BrowserOperationState {
    const op = this.operation(operationId);
    const { available, reason } = this.availability();
    return {
      operationId,
      profile: op.profile,
      available,
      reason,
      tabs: [...op.tabs.values()].map((tab) => ({ id: tab.id, url: tab.url, title: tab.title, favicon: tab.favicon, loading: tab.loading, canGoBack: tab.history.index > (tab.history.leadingBlank ? 1 : 0), canGoForward: tab.history.index < tab.history.length - 1 })),
      activeTabId: op.activeTabId,
      viewport: op.viewport,
      driving: op.agentSession !== null,
      consoleErrors: [...op.tabs.values()].reduce((sum, tab) => sum + tab.consoleErrors, 0),
      engine: this.engine,
      engineError: this.engineError,
    };
  }

  /** 어느 Operation 의 것이든 상태가 바뀌면 듣는다 — 프레임은 자기 `operationId` 를 싣고 간다. */
  onState(listener: BrowserStateListener): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  private emitState(op: OperationBrowser): void {
    const state = this.state(op.operationId);
    for (const listener of this.stateListeners) { try { listener(state); } catch { /* 구독자 오류는 서비스에 번지지 않는다 */ } }
  }

  /** 허용 회수·Operation 종료 — 진행 중 에이전트 호출을 끊고 탭과 컨텍스트를 닫는다. */
  async closeOperation(operationId: string): Promise<void> {
    const op = this.operations.get(operationId);
    if (!op) return;
    await this.resetContext(op);
    this.endAgentSession(operationId, "revoke");
    this.emitState(op);
    this.operations.delete(operationId);
    this.scheduleIdle();
  }

  /**
   * 이 Operation 의 탭과 브라우저 컨텍스트를 거둔다. 영속 프로필의 **디스크 저장소는 건드리지 않는다** —
   * 컨텍스트는 이 Operation 의 것이지만 프로필은 모두의 것이다.
   */
  private async resetContext(op: OperationBrowser): Promise<void> {
    for (const call of op.agentCalls) call.abort();
    op.agentCalls.clear();
    await this.disposeContext(op);
    op.tabs.clear();
    op.pendingTabs = 0;
    op.activeTabId = null;
  }

  /** 이 Operation 의 브라우저 컨텍스트를 엔진에서 거둔다. 그 파티션의 뷰가 함께 닫힌다. */
  private async disposeContext(op: OperationBrowser): Promise<void> {
    const client = this.client;
    if (client && op.contextId) { try { await client.send("Target.disposeBrowserContext", { browserContextId: op.contextId }); } catch { /* 이미 사라졌다 */ } }
    op.contextId = "";
  }

  /** 지금까지 「중단」이 눌린 횟수 — 여러 호출로 이어지는 실행(배치)이 시작 시점과 비교해 멈춘다. */
  interruptSerial(operationId: string): number { return this.operations.get(operationId)?.interruptSerial ?? 0; }

  /** 사용자의 「중단」 — 허용은 남기고 지금 도는 에이전트 호출만 끊는다. */
  interrupt(operationId: string): number {
    const op = this.operations.get(operationId);
    if (!op) return 0;
    const count = op.agentCalls.size;
    op.interruptSerial += 1;
    for (const call of op.agentCalls) call.abort();
    op.agentCalls.clear();
    this.endAgentSession(operationId, "interrupt");
    this.emitState(op);
    return count;
  }

  /** 에이전트 도구 호출 하나를 감싼다 — 조작 중 표시와 중단이 이 경계에서 결정된다. */
  async agentCall<T>(operationId: string, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const { available, reason } = this.availability();
    if (!available) throw new BrowserPolicyError("browser_unavailable", unavailableMessage(reason), { reason });
    const op = this.operation(operationId);
    const call = new AbortController();
    const onAbort = () => call.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    op.agentCalls.add(call);
    this.touchAgentSession(op);
    try {
      const result = await run(call.signal);
      // 도중에 「중단」이 눌렸으면 끝난 결과도 내보내지 않는다 — 중단의 뜻이 호출 하나 안에서 새면 안 된다.
      if (call.signal.aborted) throw new Error("browser_call_interrupted");
      return result;
    }
    finally {
      signal?.removeEventListener("abort", onAbort);
      op.agentCalls.delete(call);
      // 중단으로 끝난 호출은 세션을 다시 열지 않는다 — 「중단」이 지운 세션이 호출의 뒷정리로 되살아나면 안 된다.
      if (!call.signal.aborted) this.touchAgentSession(op);
      else this.emitState(op);
      this.scheduleIdle();
    }
  }

  /** 세션을 열거나 마지막 호출 시각을 갱신한다. 턴 종료 훅이 오지 않는 CLI 를 위해 유휴 안전망을 함께 건다. */
  private touchAgentSession(op: OperationBrowser): void {
    const now = Date.now();
    if (!op.agentSession) { op.agentSession = { since: now, lastCallAt: now, idle: null }; this.deps.log(`agent session started for ${op.operationId}`); }
    op.agentSession.lastCallAt = now;
    if (op.agentSession.idle) clearTimeout(op.agentSession.idle);
    op.agentSession.idle = setTimeout(() => { if (op.agentSession && op.agentCalls.size === 0) this.endAgentSession(op.operationId, "idle"); }, AGENT_SESSION_IDLE_MS);
    this.emitState(op);
  }

  /** 턴이 끝났거나 사람이 멈췄다 — 사용 중 표시를 내린다. 진행 중 호출은 interrupt 가 따로 끊는다. */
  endAgentSession(operationId: string, reason: "turn" | "interrupt" | "revoke" | "idle" = "turn"): boolean {
    const op = this.operations.get(operationId);
    if (!op?.agentSession) return false;
    if (op.agentSession.idle) clearTimeout(op.agentSession.idle);
    op.agentSession = null;
    this.deps.log(`agent session ended for ${operationId} (${reason})`);
    this.emitState(op);
    return true;
  }

  // ---------- 탭 ----------

  private tab(op: OperationBrowser, tabId?: string | null): Tab {
    const id = tabId ?? op.activeTabId;
    const tab = id ? op.tabs.get(id) : undefined;
    if (!tab) throw new BrowserPolicyError("browser_tab_not_found", id ? `Tab ${id} is not open in this Operation.` : "No tab is open. Create one with tabs_create or navigate.", { tabId: id ?? null });
    return tab;
  }

  async createTab(operationId: string, url: string | null, actor: "user" | "agent"): Promise<BrowserTabState> {
    const op = this.operation(operationId);
    if (op.tabs.size >= MAX_TABS) throw new BrowserPolicyError("browser_tab_limit", `Tab cap reached (${MAX_TABS}). Close a tab before opening another.`);
    const target = url ? this.admit(op, url, actor) : null;
    // 뷰가 붙는 동안은 탭이 아직 `tabs` 에 없다 — 그 사이 마지막 탭이 닫혀도 컨텍스트가 거둬지지 않게 세어 둔다.
    op.pendingTabs += 1;
    let client: CdpClient;
    let tab: Tab;
    try {
      const context = await this.context(op);
      client = context.client;
      const created = await client.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", browserContextId: context.contextId });
      const attached = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId: created.targetId, flatten: true });
      tab = { id: crypto.randomUUID().slice(0, 8), targetId: created.targetId, sessionId: attached.sessionId, url: "about:blank", title: "", favicon: null, frameId: null, loading: false, history: { index: 0, length: 1, leadingBlank: true }, console: [], consoleErrors: 0, network: new Map(), refs: new Map() };
      op.tabs.set(tab.id, tab);
    } finally {
      op.pendingTabs -= 1;
    }
    await Promise.all([
      client.send("Page.enable", {}, tab.sessionId),
      client.send("Runtime.enable", {}, tab.sessionId),
      client.send("Network.enable", { maxResourceBufferSize: 5_000_000, maxTotalBufferSize: 20_000_000 }, tab.sessionId),
      client.send("Log.enable", {}, tab.sessionId),
      client.send("DOM.enable", {}, tab.sessionId),
      client.send("Emulation.setFocusEmulationEnabled", { enabled: true }, tab.sessionId),
      ...(this.identity ? [client.send("Emulation.setUserAgentOverride", { userAgent: this.identity.userAgent, platform: process.platform === "darwin" ? "MacIntel" : process.platform === "win32" ? "Win32" : "Linux x86_64", userAgentMetadata: this.identity.metadata }, tab.sessionId)] : []),
    ]);
    this.deps.desktop.bindView(tab.targetId, op.operationId);
    await this.applyViewport(client, tab, op);
    await this.selectTab(operationId, tab.id);
    if (target) await this.navigateTab(op, tab, target.href);
    return this.state(operationId).tabs.find((entry) => entry.id === tab.id)!;
  }

  async closeTab(operationId: string, tabId: string): Promise<void> {
    const op = this.operation(operationId);
    const tab = this.tab(op, tabId);
    op.tabs.delete(tab.id);
    if (this.client) { try { await this.client.send("Target.closeTarget", { targetId: tab.targetId }); } catch { /* 이미 닫혔다 */ } }
    // 활성 탭을 닫았으면 남은 탭을 앞으로 세운다 — 엔진에도 알려야 그 뷰가 보인다(뷰는 활성인 것 하나만 그려진다).
    if (op.activeTabId === tab.id) {
      const next = [...op.tabs.keys()].pop() ?? null;
      op.activeTabId = null;
      if (next) { await this.selectTab(operationId, next); this.scheduleIdle(); return; }
    }
    // 마지막 탭이 닫히면 브라우저 컨텍스트도 거둔다. 임시 세션의 약속이 이것이다 — 「탭을 닫으면 로그인이
    // 사라집니다」. 컨텍스트를 그대로 두면 유휴 종료까지의 5분 안에 새 탭을 여는 사람이 같은 파티션과 그
    // 쿠키를 되받는다. 영속 프로필도 같이 거두지만 잃는 것은 없다 — 그 쿠키는 디스크의 프로필에 산다.
    if (op.tabs.size === 0 && op.pendingTabs === 0) await this.disposeContext(op);
    this.emitState(op);
    this.scheduleIdle();
  }

  async selectTab(operationId: string, tabId: string): Promise<void> {
    const op = this.operation(operationId);
    const tab = this.tab(op, tabId);
    op.activeTabId = tab.id;
    if (this.client) { try { await this.client.send("Target.activateTarget", { targetId: tab.targetId }); } catch { /* 뷰가 사라지는 중 */ } }
    this.emitState(op);
  }

  // ---------- 항해·정책 ----------

  /** 열 수 있는 주소인지. 사람과 에이전트 모두 http(s) 어디든 간다 — 호스트 제한은 두지 않는다. */
  private admit(_op: OperationBrowser, input: string, _actor: "user" | "agent"): URL {
    const url = parseUrl(input);
    if (!url || !["http:", "https:", "about:", "file:"].includes(url.protocol)) throw new BrowserPolicyError("browser_url_invalid", "That address couldn't be opened here.", { url: input });
    if (url.protocol === "file:") throw new BrowserPolicyError("browser_url_invalid", "file: URLs are not served by the Operation Browser. Serve the folder over HTTP instead.", { url: input });
    return url;
  }

  private async navigateTab(op: OperationBrowser, tab: Tab, href: string): Promise<{ ok: boolean; error: string | null }> {
    const client = await this.engineClient();
    tab.loading = true;
    this.emitState(op);
    const loaded = new Promise<void>((resolve) => {
      const off = client.on((event) => { if (event.sessionId === tab.sessionId && (event.method === "Page.loadEventFired" || event.method === "Page.frameStoppedLoading")) { off(); resolve(); } });
      setTimeout(() => { off(); resolve(); }, 12_000);
    });
    const result = await client.send<{ errorText?: string }>("Page.navigate", { url: href }, tab.sessionId);
    if (result.errorText) { tab.loading = false; this.emitState(op); return { ok: false, error: result.errorText }; }
    await loaded;
    await this.refreshTab(client, tab);
    tab.loading = false;
    this.emitState(op);
    return { ok: true, error: null };
  }

  async navigate(operationId: string, target: string, actor: "user" | "agent", tabId?: string | null): Promise<{ tab: BrowserTabState; ok: boolean; error: string | null }> {
    const op = this.operation(operationId);
    if (op.tabs.size === 0 && (target === "back" || target === "forward" || target === "reload")) throw new BrowserPolicyError("browser_tab_not_found", "No tab is open.");
    const tab = op.tabs.size === 0 ? null : this.tab(op, tabId);
    if (!tab) { const created = await this.createTab(operationId, target, actor); return { tab: created, ok: true, error: null }; }
    const client = await this.engineClient();
    let outcome: { ok: boolean; error: string | null } = { ok: true, error: null };
    if (target === "back" || target === "forward") {
      const history = await client.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory", {}, tab.sessionId);
      const index = history.currentIndex + (target === "back" ? -1 : 1);
      const entry = history.entries[index];
      if (!entry) return { tab: this.state(operationId).tabs.find((t) => t.id === tab.id)!, ok: false, error: `cannot go ${target}` };
      await client.send("Page.navigateToHistoryEntry", { entryId: entry.id }, tab.sessionId);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await this.refreshTab(client, tab);
      this.emitState(op);
    } else if (target === "reload") {
      await client.send("Page.reload", {}, tab.sessionId);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await this.refreshTab(client, tab);
      this.emitState(op);
    } else {
      const url = this.admit(op, target, actor);
      outcome = await this.navigateTab(op, tab, url.href);
    }
    return { tab: this.state(operationId).tabs.find((t) => t.id === tab.id)!, ...outcome };
  }

  private async refreshTab(client: CdpClient, tab: Tab): Promise<void> {
    try {
      const history = await client.send<{ currentIndex: number; entries: { url: string; title: string }[] }>("Page.getNavigationHistory", {}, tab.sessionId);
      const entry = history.entries[history.currentIndex];
      if (entry) { tab.url = entry.url; tab.title = entry.title; }
      tab.history = { index: history.currentIndex, length: history.entries.length, leadingBlank: history.entries[0]?.url === "about:blank" };
      if (/^https?:/.test(tab.url)) {
        const icon = await client.send<{ result: { value?: unknown } }>("Runtime.evaluate", { expression: FAVICON_EXPRESSION, returnByValue: true }, tab.sessionId);
        tab.favicon = typeof icon.result.value === "string" && /^https?:/.test(icon.result.value) ? icon.result.value : null;
      }
    } catch { /* 탭이 닫히는 중 */ }
    tab.refs.clear();
  }

  // ---------- Chrome 에서 가져오기 ----------

  /**
   * 가져올 수 있는 원본 — 창을 든 Desktop 기계의 Google Chrome 프로필들. 콘솔이 아니라 셸에 묻는다: 뷰가 그 기계에
   * 살고, 사람이 늘 쓰는 Chrome 도 그 기계에 있다(원격 콘솔이어도 마찬가지).
   */
  async importSources(): Promise<ChromeImportSources> {
    const client = await this.engineClient();
    return client.send<ChromeImportSources>(DESKTOP_BROWSER_CHROME_PROFILES, {});
  }

  /**
   * Chrome 프로필의 쿠키를 이 Operation 이 지금 쓰는 세션에 넣는다. 셸이 읽고 셸이 넣는다 — 쿠키가 콘솔을 거치지 않는다.
   * 영속 프로필을 쓰고 있으면 그 프로필로 들어가 다음에 열 때도 남고, 임시 세션이면 그 세션과 함께 사라진다.
   */
  async importFromChrome(operationId: string, profileId: string): Promise<{ cookies: number }> {
    if (!/^[A-Za-z0-9 ._-]+$/.test(profileId)) throw new BrowserPolicyError("chrome_profile_not_found", CHROME_IMPORT_FAILURES.chrome_profile_not_found!);
    const op = this.operation(operationId);
    const { client, contextId } = await this.context(op);
    try {
      const result = await client.send<{ cookies: number }>(DESKTOP_BROWSER_IMPORT_COOKIES, { partition: contextId, profileId, browserProfile: op.profile });
      this.deps.log(`imported ${result.cookies} cookies from Chrome profile ${profileId} into ${op.profile ? `browser profile ${op.profile}` : operationId}`);
      return result;
    } catch (error) {
      // 셸의 까닭은 CdpError 메시지(`Fleet.importChromeCookies: chrome_…`)에 실려 온다.
      const raw = error instanceof CdpError ? error.message.slice(error.method.length + 2) : "";
      const code = /^(chrome_[a-z_]+)/.exec(raw)?.[1] ?? "chrome_import_failed";
      throw new BrowserPolicyError(code, CHROME_IMPORT_FAILURES[code] ?? "Chrome could not open the copied profile.");
    }
  }

  // ---------- 프로필 ----------

  /**
   * 이 Operation 이 쓸 세션을 고른다 — 임시(`null`)이거나 영속 프로필이거나.
   *
   * 세션은 살아 있는 뷰에 바꿔 끼울 수 없으므로 열린 탭을 닫고 컨텍스트를 새로 만든다. 사람에게는 화면이
   * 비워지는 일이라 패널이 먼저 확인을 받는다. 프로필의 디스크 저장소는 그대로 남는다.
   */
  async setProfile(operationId: string, profile: string | null): Promise<BrowserOperationState> {
    if (profile !== null && profile !== DESKTOP_BROWSER_DEFAULT_PROFILE) throw new BrowserPolicyError("browser_profile_unknown", "That browser profile does not exist.");
    const op = this.operation(operationId);
    if (op.profile === profile) return this.state(operationId);
    await this.resetContext(op);
    op.profile = profile;
    this.deps.log(`${operationId} browser session is now ${profile ?? "ephemeral"}`);
    this.emitState(op);
    // 전환이 마지막 탭을 닫았을 수 있다 — 그 길은 closeTab 을 거치지 않으므로 유휴 종료를 여기서 건다.
    this.scheduleIdle();
    return this.state(operationId);
  }

  /**
   * 영속 프로필의 저장소를 비운다 — 모든 Operation 의 로그인이 함께 풀린다.
   *
   * 그 프로필을 쓰는 Operation 의 탭을 먼저 모두 닫는다: Windows 는 열려 있는 파일을 지우지 못하고,
   * 살아 있는 페이지가 방금 지운 쿠키를 다시 써 넣을 수도 있다.
   */
  async clearProfile(profile: string): Promise<void> {
    if (profile !== DESKTOP_BROWSER_DEFAULT_PROFILE) throw new BrowserPolicyError("browser_profile_unknown", "That browser profile does not exist.");
    for (const op of this.operations.values()) {
      if (op.profile !== profile) continue;
      await this.resetContext(op);
      this.emitState(op);
    }
    const client = await this.engineClient();
    await client.send(DESKTOP_BROWSER_CLEAR_PROFILE, { browserProfile: profile });
    this.deps.log(`cleared browser profile ${profile}`);
    this.scheduleIdle();
  }

  // ---------- 파비콘 프록시 ----------

  private readonly favicons = new Map<string, { at: number; body: Buffer; type: string }>();

  /** 탭의 파비콘 바이트. 페이지가 선언한 URL 을 서버가 받아 준다 — 클라이언트 CSP 가 외부 이미지를 막기 때문. */
  async favicon(operationId: string, tabId: string): Promise<{ body: Buffer; type: string } | null> {
    const op = this.operation(operationId);
    const tab = op.tabs.get(tabId);
    if (!tab?.favicon) return null;
    const cached = this.favicons.get(tab.favicon);
    if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached;
    try {
      const response = await fetch(tab.favicon, { signal: AbortSignal.timeout(5000), redirect: "follow" });
      const type = response.headers.get("content-type") ?? "";
      if (!response.ok || !/^image\//.test(type)) return null;
      const body = Buffer.from(await response.arrayBuffer());
      if (body.byteLength === 0 || body.byteLength > 256 * 1024) return null;
      const entry = { at: Date.now(), body, type };
      this.favicons.set(tab.favicon, entry);
      if (this.favicons.size > 200) { const oldest = [...this.favicons.entries()].sort((a, b) => a[1].at - b[1].at)[0]; if (oldest) this.favicons.delete(oldest[0]); }
      return entry;
    } catch { return null; }
  }


  // ---------- 이벤트 ----------

  private findTab(sessionId: string | undefined): { op: OperationBrowser; tab: Tab } | null {
    if (!sessionId) return null;
    for (const op of this.operations.values()) for (const tab of op.tabs.values()) if (tab.sessionId === sessionId) return { op, tab };
    return null;
  }

  private onEvent(event: CdpEvent): void {
    const found = this.findTab(event.sessionId);
    if (!found) return;
    const { op, tab } = found;
    const p = event.params as Record<string, any>;
    switch (event.method) {
      case "Fleet.viewResized": {
        // 셸이 놓은 네이티브 뷰 실측. 에뮬레이션 중에도 pane 은 갱신하고, 반응형일 때만 논리 뷰포트에 반영한다.
        const width = Math.max(1, Math.round(Number(p.width) || 0)), height = Math.max(1, Math.round(Number(p.height) || 0)), scale = Math.max(1, Number(p.scale) || 1);
        const paneSame = op.pane !== null && width === op.pane.width && height === op.pane.height && scale === op.pane.scale;
        op.pane = { width, height, scale };
        if (!op.viewportFollowsPane) {
          if (scale !== op.viewport.scale) { op.viewport = { ...op.viewport, scale }; this.emitState(op); }
          else if (!paneSame) this.emitState(op);
          return;
        }
        if (width === op.viewport.width && height === op.viewport.height && scale === op.viewport.scale) return;
        op.viewport = { ...op.viewport, width, height, scale };
        this.emitState(op);
        return;
      }
      case "Target.detachedFromTarget": {
        // 셸이 뷰를 잃었다(렌더러 사망·창 종료). 탭도 함께 접고, 활성이었으면 남은 탭을 앞으로 세운다.
        op.tabs.delete(tab.id);
        if (op.activeTabId === tab.id) {
          const next = [...op.tabs.keys()].pop() ?? null;
          op.activeTabId = null;
          if (next) { void this.selectTab(op.operationId, next).catch(() => undefined); return; }
        }
        this.emitState(op);
        return;
      }
      case "Page.frameNavigated": {
        if (p.frame?.parentId) return;
        tab.frameId = typeof p.frame?.id === "string" ? p.frame.id : tab.frameId;
        tab.url = p.frame?.url ?? tab.url;
        tab.title = "";
        // 파비콘은 새 문서의 것이 도착할 때까지 이전 것을 둔다 — 탭이 점으로 깜빡이지 않게.
        // 새 문서의 loader 가 아닌 요청은 이전 페이지의 것 — 문서 요청 자체는 남긴다.
        for (const [id, entry] of tab.network) if (entry.loaderId !== p.frame?.loaderId) tab.network.delete(id);
        tab.refs.clear();
        this.emitState(op);
        // 교차 출처 항해로 렌더러가 바뀌면 페이지의 innerWidth 는 그대로여도 컴포지터가 창 표면(1280×657)으로
        // 되돌아가 스크린캐스트 프레임이 창 크기로 온다. 에뮬레이션을 다시 걸어야 프레임이 뷰포트를 따른다.
        if (this.client) void this.applyViewport(this.client, tab, op).catch(() => undefined);
        return;
      }
      case "Page.frameStartedLoading": if (tab.frameId && p.frameId !== tab.frameId) return; tab.loading = true; this.emitState(op); return;
      case "Page.navigatedWithinDocument": if (tab.frameId && p.frameId !== tab.frameId) return; tab.loading = false; this.emitState(op); return;
      case "Page.loadEventFired": case "Page.frameStoppedLoading": {
        if (event.method === "Page.frameStoppedLoading" && tab.frameId && p.frameId !== tab.frameId) return;
        tab.loading = false;
        const client = this.client;
        if (client) void this.refreshTab(client, tab).then(() => this.emitState(op));
        if (client) void this.applyViewport(client, tab, op).catch(() => undefined);
        return;
      }
      case "Runtime.consoleAPICalled": {
        const text = (p.args as { value?: unknown; description?: string }[] | undefined)?.map((arg) => typeof arg.value === "string" ? arg.value : arg.value !== undefined ? JSON.stringify(arg.value) : arg.description ?? "").join(" ") ?? "";
        const level = String(p.type ?? "log");
        this.pushConsole(op, tab, { at: Date.now(), level, text, url: p.stackTrace?.callFrames?.[0]?.url, line: p.stackTrace?.callFrames?.[0]?.lineNumber });
        return;
      }
      case "Runtime.exceptionThrown": {
        const details = p.exceptionDetails ?? {};
        this.pushConsole(op, tab, { at: Date.now(), level: "error", text: details.exception?.description ?? details.text ?? "Uncaught exception", url: details.url, line: details.lineNumber });
        return;
      }
      case "Log.entryAdded": {
        const entry = p.entry ?? {};
        this.pushConsole(op, tab, { at: Date.now(), level: String(entry.level ?? "info"), text: `[${entry.source ?? "browser"}] ${entry.text ?? ""}`, url: entry.url, line: entry.lineNumber });
        return;
      }
      case "Network.requestWillBeSent": {
        if (tab.network.size >= NETWORK_RING) { const oldest = tab.network.keys().next().value; if (oldest) tab.network.delete(oldest); }
        tab.network.set(p.requestId, { requestId: p.requestId, loaderId: String(p.loaderId ?? ""), at: Date.now(), method: p.request?.method ?? "GET", url: p.request?.url ?? "", type: p.type ?? "Other", status: null, mimeType: null, size: 0, failed: null, finished: false });
        return;
      }
      case "Network.responseReceived": { const entry = tab.network.get(p.requestId); if (entry) { entry.status = p.response?.status ?? null; entry.mimeType = p.response?.mimeType ?? null; } return; }
      case "Network.loadingFinished": { const entry = tab.network.get(p.requestId); if (entry) { entry.finished = true; entry.size = p.encodedDataLength ?? 0; } return; }
      case "Network.loadingFailed": { const entry = tab.network.get(p.requestId); if (entry) { entry.finished = true; entry.failed = p.errorText ?? "failed"; } return; }
      default: return;
    }
  }

  private pushConsole(op: OperationBrowser, tab: Tab, entry: ConsoleEntry): void {
    tab.console.push(entry);
    if (tab.console.length > CONSOLE_RING) tab.console.splice(0, tab.console.length - CONSOLE_RING);
    if (entry.level === "error") { tab.consoleErrors += 1; this.emitState(op); }
  }

  // ---------- 뷰포트 ----------

  /** 네이티브 pane 실측 — 셸 이벤트 또는 활성 뷰에 이미 기록된 크기. */
  private paneOf(op: OperationBrowser): { width: number; height: number; scale: number } | null {
    if (op.pane) return op.pane;
    if (!op.activeTabId) return null;
    const tab = op.tabs.get(op.activeTabId);
    if (!tab) return null;
    const size = this.deps.desktop.viewSize(tab.targetId);
    if (!size) return null;
    op.pane = { width: size.width, height: size.height, scale: size.scale };
    return op.pane;
  }

  /** 뷰의 크기는 셸이 패널 자리에 맞춰 놓는다 — 반응형이면 에뮬레이션을 걷고, 프리셋·임의 크기만 뷰 안에서 흉내 낸다. */
  private async applyViewport(client: CdpClient, tab: Tab, op: OperationBrowser): Promise<void> {
    const viewport = op.viewport;
    if (op.viewportFollowsPane) {
      await client.send("Emulation.clearDeviceMetricsOverride", {}, tab.sessionId).catch(() => undefined);
    } else {
      const mobile = viewport.preset === "mobile" || viewport.preset === "tablet";
      await client.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 0, mobile, screenWidth: viewport.width, screenHeight: viewport.height }, tab.sessionId);
    }
    await client.send("Emulation.setEmulatedMedia", { features: viewport.colorScheme ? [{ name: "prefers-color-scheme", value: viewport.colorScheme }] : [] }, tab.sessionId);
  }

  async setViewport(operationId: string, request: { preset?: ViewportPreset; width?: number; height?: number; colorScheme?: "light" | "dark" | null }, actor: "user" | "agent"): Promise<BrowserViewport> {
    const op = this.operation(operationId);
    const preset = request.preset ?? (request.width || request.height ? "responsive" : op.viewport.preset);
    // 색 구성만 맞추는 요청(테마 따라가기)은 표시 동기화지 뷰포트 결정이 아니다 — 에이전트가 정한 프리셋의 소유권을 지우지 않는다.
    const displayOnly = request.preset === undefined && request.width === undefined && request.height === undefined;
    if (displayOnly) {
      op.viewport = { ...op.viewport, colorScheme: request.colorScheme === undefined ? op.viewport.colorScheme : request.colorScheme };
      if (this.client) for (const tab of op.tabs.values()) await this.applyViewport(this.client, tab, op).catch(() => undefined);
      this.emitState(op);
      return op.viewport;
    }
    const resolved = resolveBrowserViewportSize({
      preset,
      width: request.width,
      height: request.height,
      current: op.viewport,
      pane: this.paneOf(op),
    });
    const setBy = actor;
    const scale = op.pane?.scale ?? op.viewport.scale;
    op.viewportFollowsPane = resolved.followsPane;
    op.viewport = { width: resolved.width, height: resolved.height, scale, preset, setBy, colorScheme: request.colorScheme === undefined ? op.viewport.colorScheme : request.colorScheme };
    if (this.client) {
      for (const tab of op.tabs.values()) await this.applyViewport(this.client, tab, op).catch(() => undefined);
      // 반응형 복귀 직후 셸 size 이벤트가 다시 안 올 수 있다(pane 자리는 그대로). 레이아웃 실측으로 논리 크기를 맞춘다.
      if (op.viewportFollowsPane) {
        const active = op.activeTabId ? op.tabs.get(op.activeTabId) : null;
        if (active) {
          const layout = await this.layoutViewport(this.client, active);
          if (layout && (layout.width !== op.viewport.width || layout.height !== op.viewport.height)) {
            op.viewport = { ...op.viewport, width: layout.width, height: layout.height };
            if (!op.pane) op.pane = { width: layout.width, height: layout.height, scale: op.viewport.scale };
          }
        }
      }
    }
    this.emitState(op);
    return op.viewport;
  }

  // ---------- 입력 ----------

  async mouse(operationId: string, input: { type: "move" | "down" | "up" | "click" | "wheel"; x: number; y: number; button?: "left" | "right" | "middle"; clickCount?: number; deltaX?: number; deltaY?: number; modifiers?: Modifiers }, tabId?: string | null): Promise<void> {
    const op = this.operation(operationId);
    const tab = this.tab(op, tabId);
    const client = await this.engineClient();
    const button = input.button ?? "left";
    const modifiers = modifierBits(input.modifiers ?? { alt: false, ctrl: false, meta: false, shift: false });
    const base = { x: input.x, y: input.y, modifiers };
    if (input.type === "wheel") { await client.send("Input.dispatchMouseEvent", { ...base, type: "mouseWheel", deltaX: input.deltaX ?? 0, deltaY: input.deltaY ?? 0 }, tab.sessionId); return; }
    if (input.type === "move") {
      // 누른 채 움직이면 드래그다 — Chromium 은 mouseMoved 에 실린 button/buttons 로 드래그·선택을 이어간다.
      const held = op.pointer;
      await client.send("Input.dispatchMouseEvent", { ...base, type: "mouseMoved", button: held?.button ?? "none", ...(held ? { buttons: held.buttons } : {}) }, tab.sessionId);
      return;
    }
    const clickCount = input.clickCount ?? 1;
    const buttons = button === "left" ? 1 : button === "right" ? 2 : 4;
    if (input.type === "down" || input.type === "click") { op.pointer = { button, buttons }; await client.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed", button, buttons, clickCount }, tab.sessionId); }
    if (input.type === "up" || input.type === "click") { op.pointer = null; await client.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", button, clickCount }, tab.sessionId); }
  }

  async click(operationId: string, x: number, y: number, options: { button?: "left" | "right" | "middle"; clickCount?: number } = {}, tabId?: string | null): Promise<void> {
    await this.mouse(operationId, { type: "move", x, y }, tabId);
    for (let i = 1; i <= (options.clickCount ?? 1); i += 1) await this.mouse(operationId, { type: "click", x, y, button: options.button, clickCount: i }, tabId);
  }

  /** 좌표 클릭 — 기존 `click` 과 동일하게 CDP 포인터를 보내고, 맞은 요소 진단만 덧붙인다(성공 추정 없음). */
  async clickAt(operationId: string, x: number, y: number, options: { button?: "left" | "right" | "middle"; clickCount?: number; signal?: AbortSignal } = {}, tabId?: string | null): Promise<BrowserClickDispatch> {
    const button = options.button ?? "left";
    const clickCount = options.clickCount ?? 1;
    this.throwIfAborted(options.signal);
    // 진단 중 노드가 교체돼도 기존 저수준 좌표 입력을 막지 않는다. 중단은 아래에서 별도로 확인한다.
    const hit = await this.probePoint(operationId, x, y, tabId).catch(() => null);
    this.throwIfAborted(options.signal);
    await this.click(operationId, x, y, { button, clickCount }, tabId);
    const note = hit?.disabled ? "Hit target reports disabled=true; input was still dispatched." : null;
    return { dispatched: true, x, y, button, clickCount, ref: null, hit, note };
  }

  /**
   * ref 클릭 — scrollIntoView → 기하 안정화 → 히트 테스트 → 실제 CDP 포인터.
   * stale / disabled / occluded 는 명확히 거절하고, 보낸 뒤에는 성공을 추정하지 않는다.
   */
  async clickRef(operationId: string, ref: string, options: { button?: "left" | "right" | "middle"; clickCount?: number; signal?: AbortSignal } = {}, tabId?: string | null): Promise<BrowserClickDispatch> {
    const op = this.operation(operationId);
    const tab = this.tab(op, tabId);
    const client = await this.engineClient();
    const signal = options.signal;
    this.throwIfAborted(signal);
    const { objectId, backendNodeId } = await this.resolveRef(client, tab, ref);
    const button = options.button ?? "left";
    const clickCount = options.clickCount ?? 1;
    try {
      const connected = await client.send<{ result: { value?: boolean } }>("Runtime.callFunctionOn", { objectId, functionDeclaration: "function(){ return this.isConnected; }", returnByValue: true }, tab.sessionId);
      if (connected.result.value === false) throw new BrowserPolicyError("browser_ref_unknown", `${ref} no longer points at a live element. Call read_page or find again and use a fresh ref.`, { ref });
      await client.send("Runtime.callFunctionOn", { objectId, functionDeclaration: "function(){ this.scrollIntoView({block:'center', inline:'center'}); }" }, tab.sessionId);
      this.throwIfAborted(signal);
      const center = await this.stableBoxCenter(client, tab, backendNodeId, signal);
      this.throwIfAborted(signal);
      const probe = await client.send<{ result: { value?: { ok: boolean; reason?: string; x: number; y: number; disabled: boolean; hit: { tag: string; id: string | null; text: string; disabled: boolean; selector: string } | null } } }>("Runtime.callFunctionOn", {
        objectId,
        returnByValue: true,
        functionDeclaration: HIT_TEST_FUNCTION,
      }, tab.sessionId);
      const value = probe.result.value;
      if (!value) throw new BrowserPolicyError("browser_ref_unresolved", `${ref} could not be hit-tested. Call read_page again and use a fresh ref.`);
      if (value.reason === "not_visible") throw new BrowserPolicyError("browser_ref_not_visible", `${ref} has no visible box after scrolling into view.`, { ref });
      if (value.reason === "disabled" || value.disabled) throw new BrowserPolicyError("browser_ref_disabled", `${ref} is disabled.`, { ref, hit: value.hit });
      if (value.reason === "occluded" || value.reason === "no_hit") throw new BrowserPolicyError("browser_ref_occluded", `${ref} is not the topmost element at its center${value.hit ? ` (hit ${value.hit.selector || value.hit.tag})` : ""}.`, { ref, hit: value.hit, x: value.x, y: value.y });
      if (!value.ok) throw new BrowserPolicyError("browser_ref_unresolved", `${ref} could not be clicked (${value.reason ?? "unknown"}).`, { ref });
      const x = Number.isFinite(value.x) ? value.x : center.x;
      const y = Number.isFinite(value.y) ? value.y : center.y;
      this.throwIfAborted(signal);
      await this.click(operationId, x, y, { button, clickCount }, tabId);
      return { dispatched: true, x, y, button, clickCount, ref, hit: value.hit, note: null };
    } catch (error) {
      this.rethrowStaleRef(ref, error);
      throw error;
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error("browser_call_interrupted");
  }

  private rethrowStaleRef(ref: string, error: unknown): void {
    if (error instanceof BrowserPolicyError) return;
    const message = error instanceof Error ? error.message : String(error);
    if (/detached|could not find node|node with given id|backend node|no node|object.*not found|cannot find object/i.test(message)) {
      throw new BrowserPolicyError("browser_ref_unknown", `${ref} no longer points at a live element (detached or replaced). Call read_page or find again and use a fresh ref.`, { ref, cause: message });
    }
  }

  private async stableBoxCenter(client: CdpClient, tab: Tab, backendNodeId: number, signal?: AbortSignal): Promise<{ x: number; y: number }> {
    let previous: { x: number; y: number } | null = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      this.throwIfAborted(signal);
      const box = await client.send<{ model: { content: number[] } }>("DOM.getBoxModel", { backendNodeId }, tab.sessionId);
      const q = box.model.content;
      const next = { x: (q[0]! + q[2]! + q[4]! + q[6]!) / 4, y: (q[1]! + q[3]! + q[5]! + q[7]!) / 4 };
      if (previous && Math.abs(previous.x - next.x) < 0.5 && Math.abs(previous.y - next.y) < 0.5) return next;
      previous = next;
      this.throwIfAborted(signal);
      await client.send("Runtime.evaluate", { expression: "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))", awaitPromise: true }, tab.sessionId).catch(() => undefined);
    }
    if (!previous) throw new BrowserPolicyError("browser_ref_not_visible", "Element box model was empty after scrolling into view.");
    return previous;
  }

  private async probePoint(operationId: string, x: number, y: number, tabId?: string | null): Promise<BrowserClickDispatch["hit"]> {
    const info = await this.inspectAt(operationId, x, y, tabId);
    if (!info) return null;
    const disabled = await this.evaluate<boolean>(operationId, `(() => { const el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)}); if (!el) return false; const node = el; return !!(node.disabled || node.getAttribute?.('aria-disabled') === 'true' || node.closest?.('[disabled], [aria-disabled="true"]')); })()`, tabId);
    return { tag: info.tag, id: info.id, text: info.text.slice(0, 120), disabled: disabled.value === true, selector: info.selector };
  }

  async drag(operationId: string, from: { x: number; y: number }, to: { x: number; y: number }, tabId?: string | null): Promise<void> {
    await this.mouse(operationId, { type: "move", x: from.x, y: from.y }, tabId);
    await this.mouse(operationId, { type: "down", x: from.x, y: from.y }, tabId);
    const steps = 8;
    for (let i = 1; i <= steps; i += 1) await this.mouse(operationId, { type: "move", x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }, tabId);
    await this.mouse(operationId, { type: "up", x: to.x, y: to.y }, tabId);
  }

  async keyChord(operationId: string, chord: string, tabId?: string | null): Promise<void> {
    const parsed = parseKeyChord(chord);
    if (!parsed) throw new BrowserPolicyError("browser_key_invalid", `Unknown key "${chord}". Use xdotool names such as Return, Tab, Escape, BackSpace, Up, cmd+a.`);
    await this.dispatchKey(operationId, parsed.descriptor, parsed.modifiers, tabId);
  }


  private async dispatchKey(operationId: string, descriptor: { key: string; code: string; keyCode: number; text?: string }, mods: Modifiers, tabId?: string | null): Promise<void> {
    const op = this.operation(operationId);
    const tab = this.tab(op, tabId);
    const client = await this.engineClient();
    const modifiers = modifierBits(mods);
    const common = { key: descriptor.key, code: descriptor.code, windowsVirtualKeyCode: descriptor.keyCode, nativeVirtualKeyCode: descriptor.keyCode, modifiers };
    // macOS 편집 단축키(cmd+a·c·v·x·z)는 Chromium이 commands 로 받아야 실제 편집이 일어난다.
    const command = editCommand(descriptor.key, mods);
    await client.send("Input.dispatchKeyEvent", { ...common, type: descriptor.text ? "keyDown" : "rawKeyDown", ...(descriptor.text ? { text: descriptor.text, unmodifiedText: descriptor.text } : {}), ...(command ? { commands: [command] } : {}) }, tab.sessionId);
    await client.send("Input.dispatchKeyEvent", { ...common, type: "keyUp" }, tab.sessionId);
  }

  /** 에이전트의 `type` — 줄바꿈은 Enter 로, 나머지는 텍스트 삽입으로. */
  async typeText(operationId: string, text: string, tabId?: string | null): Promise<void> {
    const op = this.operation(operationId);
    const tab = this.tab(op, tabId);
    const client = await this.engineClient();
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i]) await client.send("Input.insertText", { text: parts[i] }, tab.sessionId);
      if (i < parts.length - 1) await this.keyChord(operationId, "Return", tabId);
    }
  }


  // ---------- 관찰 ----------

  async geometryVersion(operationId: string, tabId?: string | null): Promise<string> {
    const op = this.operation(operationId), tab = this.tab(op, tabId), client = await this.engineClient();
    const layout = await this.layoutViewport(client, tab);
    if (!layout) throw new BrowserPolicyError("browser_capture_not_ready", "Page geometry unavailable.");
    return `${tab.id}:${layout.width}x${layout.height}:${this.paneOf(op)?.scale ?? op.viewport.scale}`;
  }

  async screenshot(operationId: string, options: { tabId?: string | null; clip?: { x: number; y: number; width: number; height: number }; format?: "png" | "jpeg"; signal?: AbortSignal } = {}): Promise<{ pixels: { width: number; height: number }; geometryVersion: string; data: string; mimeType: string; width: number; height: number; viewport: { width: number; height: number; preset: ViewportPreset; followsPane: boolean }; layout: { width: number; height: number } | null; staleViewport: boolean }> {
    const op = this.operation(operationId);
    const tab = this.tab(op, options.tabId);
    const client = await this.engineClient();
    const format = options.format ?? "png";
    // 초기 native pane 크기/배율 통지가 오기 전의 추정값으로 캡처하지 않는다.
    let layout: { width: number; height: number } | null = null;
    let previous = "";
    let ready = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      this.throwIfAborted(options.signal);
      const pane = this.paneOf(op);
      layout = await this.layoutViewport(client, tab);
      const geometry = JSON.stringify([pane, layout]);
      if (pane && pane.width > 0 && pane.height > 0 && layout && geometry === previous) { ready = true; op.viewport = { ...op.viewport, scale: pane.scale }; break; }
      previous = geometry;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!ready || !layout) throw new BrowserPolicyError("browser_capture_not_ready", "Native pane geometry is not ready. Observe the page and request capture again; do not retry input.");
    // heal 전에 저장된 논리 뷰포트와 실측 layout 불일치를 잡는다 — 이전 스크린샷 좌표를 믿지 말라는 신호.
    const storedBeforeHeal = { width: op.viewport.width, height: op.viewport.height };
    const staleViewport = !options.clip && layout !== null && (layout.width !== storedBeforeHeal.width || layout.height !== storedBeforeHeal.height);
    if (op.viewportFollowsPane && layout && (layout.width !== op.viewport.width || layout.height !== op.viewport.height)) {
      op.viewport = { ...op.viewport, width: layout.width, height: layout.height };
      this.emitState(op);
    }
    // 캡처는 실제 페이지 layout(또는 명시 clip)을 쓴다 — 저장된 논리 크기와 어긋나도 잘리지 않게.
    const clip = options.clip ?? { x: 0, y: 0, width: layout?.width ?? op.viewport.width, height: layout?.height ?? op.viewport.height };
    this.throwIfAborted(options.signal);
    const result = await client.send<{ data: string }>("Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality: 80 } : {}), clip: { ...clip, scale: 1 / op.viewport.scale }, captureBeyondViewport: false }, tab.sessionId);
    const pixels = capturePixels(result.data);
    const after = await this.layoutViewport(client, tab);
    if (!after || after.width !== layout.width || after.height !== layout.height) throw new BrowserPolicyError("browser_capture_changed", "Viewport changed during capture; capture again before coordinate input.");
    return {
      pixels,
      geometryVersion: `${tab.id}:${layout.width}x${layout.height}:${op.viewport.scale}`,
      data: result.data,
      mimeType: format === "png" ? "image/png" : "image/jpeg",
      width: clip.width,
      height: clip.height,
      viewport: { width: op.viewport.width, height: op.viewport.height, preset: op.viewport.preset, followsPane: op.viewportFollowsPane },
      layout,
      staleViewport,
    };
  }

  private async layoutViewport(client: CdpClient, tab: Tab): Promise<{ width: number; height: number } | null> {
    try {
      const metrics = await client.send<{ cssLayoutViewport?: { clientWidth?: number; clientHeight?: number }; cssVisualViewport?: { clientWidth?: number; clientHeight?: number }; layoutViewport?: { clientWidth?: number; clientHeight?: number } }>("Page.getLayoutMetrics", {}, tab.sessionId);
      const box = metrics.cssLayoutViewport ?? metrics.cssVisualViewport ?? metrics.layoutViewport;
      const width = Math.round(Number(box?.clientWidth) || 0);
      const height = Math.round(Number(box?.clientHeight) || 0);
      if (width < 1 || height < 1) return null;
      return { width, height };
    } catch {
      return null;
    }
  }

  async evaluate<T = unknown>(operationId: string, expression: string, tabId?: string | null): Promise<{ value: T | undefined; error: string | null }> {
    const op = this.operation(operationId);
    const tab = this.tab(op, tabId);
    const client = await this.engineClient();
    const result = await client.send<{ result: { value?: T; description?: string; type: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, tab.sessionId);
    if (result.exceptionDetails) return { value: undefined, error: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation failed" };
    return { value: result.result.value ?? (result.result.type === "undefined" ? undefined : result.result.description as T | undefined), error: null };
  }

  async pageText(operationId: string, tabId?: string | null): Promise<string> {
    const { value } = await this.evaluate<string>(operationId, `(() => { const root = document.querySelector('article, main, [role="main"]') ?? document.body; return root ? root.innerText : ""; })()`, tabId);
    const text = typeof value === "string" ? value : "";
    return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n…(truncated)` : text;
  }

  /**
   * 접근성 트리를 YAML 비슷한 들여쓰기 목록으로. DOM 노드가 있는 항목엔 `ref_N`이 붙고, 그 번호는
   * 다음 read_page 까지 유효하다(form_input·scroll_to·click 이 씀).
   */
  async readPage(operationId: string, options: { tabId?: string | null; filter?: "interactive" | "all"; maxChars?: number; maxDepth?: number; within?: BrowserTarget } = {}): Promise<{ text: string; refs: number; truncated: boolean; total: number; observationId: string }> {
    const op = this.operation(operationId);
    const tab = this.tab(op, options.tabId);
    const client = await this.engineClient();
    const scope = options.within ? await this.targetRef(operationId, options.within, options.tabId) : null;
    const scopeBackend = scope ? tab.refs.get(scope) : null;
    const tree = await client.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree", {}, tab.sessionId);
    const observationId = `o${++this.observationSerial}`;
    tab.refs.clear();
    const byId = new Map(tree.nodes.map((node) => [node.nodeId, node]));
    const interactive = options.filter === "interactive";
    const lines: string[] = [];
    let refCount = 0;
    const walk = (node: AxNode, depth: number) => {
      if (depth > (options.maxDepth ?? 100)) return;
      const role = node.role?.value ?? "";
      const name = node.name?.value ?? "";
      const ignored = node.ignored === true;
      const isInteractive = INTERACTIVE_ROLES.has(role);
      if (!ignored && (!interactive || isInteractive) && (role !== "generic" && role !== "none" || name)) {
        let ref = "";
        if (node.backendDOMNodeId !== undefined && (isInteractive || !interactive)) { refCount += 1; ref = `ref_${observationId}_${refCount}`; tab.refs.set(ref, node.backendDOMNodeId); }
        const value = node.value?.value;
        const props = (node.properties ?? []).filter((prop) => ["checked", "expanded", "selected", "disabled", "focused", "pressed", "invalid", "required"].includes(prop.name) && prop.value?.value !== false && prop.value?.value !== "false").map((prop) => `${prop.name}=${String(prop.value?.value)}`);
        lines.push(`${"  ".repeat(Math.min(depth, 12))}- ${role}${name ? ` "${name.slice(0, 200)}"` : ""}${ref ? ` [${ref}]` : ""}${value !== undefined && value !== "" ? ` value="${String(value).slice(0, 120)}"` : ""}${props.length ? ` {${props.join(", ")}}` : ""}`);
      }
      for (const childId of node.childIds ?? []) { const child = byId.get(childId); if (child) walk(child, ignored ? depth : depth + 1); }
    };
    const root = scopeBackend ? tree.nodes.find((node) => node.backendDOMNodeId === scopeBackend) : tree.nodes.find((node) => !node.parentId) ?? tree.nodes[0];
    if (scopeBackend && !root) throw new BrowserPolicyError("browser_target_missing", "Scope is absent from the accessibility tree.");
    if (root) walk(root, 0);
    const full = lines.join("\n");
    const limit = Math.max(200, Math.min(400_000, options.maxChars ?? 12_000));
    const truncated = full.length > limit;
    const text = truncated ? full.slice(0, full.lastIndexOf("\n", limit)) + `\n…(truncated: ${full.length} chars total; pass a larger max_chars or use filter "interactive")` : full;
    return { text, refs: refCount, truncated, total: full.length, observationId };
  }

  async find(operationId: string, query: string, tabId?: string | null): Promise<string> {
    const page = await this.readPage(operationId, { tabId, filter: "all", maxChars: 400_000 });
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = page.text.split("\n").filter((line) => { if (/^\s*- (InlineTextBox|StaticText)\b/.test(line)) return false; const lower = line.toLowerCase(); return terms.every((term) => lower.includes(term)); }).slice(0, 40);
    return hits.length ? hits.map((line) => line.trim()).join("\n") : `No elements match "${query}". Use read_page to see the tree.`;
  }

  /** AX 이름을 사용하며 accessible name을 임의로 추측하지 않는다. 대상과 범위는 항상 유일해야 한다. */
  async targetRef(operationId: string, target: BrowserTarget, tabId?: string | null): Promise<string> {
    const op = this.operation(operationId), tab = this.tab(op, tabId), client = await this.engineClient();
    const modes = Number(!!target.ref) + Number(!!target.selector) + Number(!!target.role || target.name !== undefined);
    if (modes !== 1) throw new BrowserPolicyError("browser_target_invalid", "Choose exactly one of ref, selector, or role/name.");
    const scopeRef = target.within ? await this.targetRef(operationId, target.within, tabId) : null;
    const scope = scopeRef ? await this.resolveRef(client, tab, scopeRef) : null;
    let nodes: number[] = [];
    if (target.ref) {
      const resolved = await this.resolveRef(client, tab, target.ref);
      nodes = [resolved.backendNodeId];
    } else if (target.selector) {
      const result = await client.send<{ result: { objectId?: string }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression: `Array.from(document.querySelectorAll(${JSON.stringify(target.selector)}))` }, tab.sessionId);
      if (result.exceptionDetails || !result.result.objectId) throw new BrowserPolicyError("browser_target_invalid", "Invalid CSS selector.");
      try {
        const properties = await client.send<{ result: { name: string; value?: { objectId?: string } }[] }>("Runtime.getProperties", { objectId: result.result.objectId, ownProperties: true }, tab.sessionId);
        for (const property of properties.result) if (/^\d+$/.test(property.name) && property.value?.objectId) {
          const described = await client.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { objectId: property.value.objectId }, tab.sessionId);
          nodes.push(described.node.backendNodeId);
        }
      } finally { await client.send("Runtime.releaseObject", { objectId: result.result.objectId }, tab.sessionId).catch(() => undefined); }
    } else {
      const tree = await client.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree", {}, tab.sessionId);
      nodes = tree.nodes.filter(node => !node.ignored && node.backendDOMNodeId !== undefined && (!target.role || node.role?.value === target.role) && (target.name === undefined || (target.exact !== false ? node.name?.value === target.name : (node.name?.value ?? "").includes(target.name)))).map(node => node.backendDOMNodeId!);
    }
    if (scope) {
      const scoped: number[] = [];
      for (const backendNodeId of nodes) {
        const node = await client.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId }, tab.sessionId);
        const inside = await client.send<{ result: { value?: boolean } }>("Runtime.callFunctionOn", { objectId: scope.objectId, functionDeclaration: "function(node){for(let n=node;n;n=n.parentNode||n.host){if(n===this)return true}return false}", arguments: [{ objectId: node.object.objectId }], returnByValue: true }, tab.sessionId);
        if (inside.result.value) scoped.push(backendNodeId);
      }
      nodes = scoped;
    }
    nodes = [...new Set(nodes)];
    if (!nodes.length) throw new BrowserPolicyError("browser_target_missing", "No matching element.");
    if (nodes.length !== 1) throw new BrowserPolicyError("browser_target_ambiguous", "More than one element matches; narrow the target with within.", { matches: nodes.length });
    const ref = target.ref ?? `ref_t${nodes[0]}`;
    tab.refs.set(ref, nodes[0]!);
    return ref;
  }

  async elementState(operationId: string, ref: string, attributes: string[] = [], tabId?: string | null): Promise<BrowserElementState> {
    const tab = this.tab(this.operation(operationId), tabId), client = await this.engineClient();
    const { objectId } = await this.resolveRef(client, tab, ref);
    const result = await client.send<{ result: { value?: BrowserElementState } }>("Runtime.callFunctionOn", { objectId, arguments: [{ value: attributes.slice(0, 20) }], returnByValue: true, functionDeclaration: `function(attrs){
      const el=this, r=el.getBoundingClientRect(), style=getComputedStyle(el);
      return {tag:el.tagName.toLowerCase(), type:el.type||null, editable:el.isContentEditable, connected:el.isConnected, visible:el.isConnected&&r.width>0&&r.height>0&&style.visibility!=='hidden'&&style.display!=='none', enabled:!(el.matches(':disabled')||el.closest('[inert],[aria-disabled="true"]')), checked:typeof el.checked==='boolean'?el.checked:el.getAttribute('aria-checked')===null?null:el.getAttribute('aria-checked')==='true', value:el.type==='password'?null:typeof el.value==='string'?el.value:null, text:(el.innerText||'').slice(0,2000), attributes:Object.fromEntries(attrs.map(a=>[a,el.type==='password'&&a==='value'?null:el.getAttribute(a)]))};
    }` }, tab.sessionId);
    if (!result.result.value) throw new BrowserPolicyError("browser_ref_unknown", "Element state unavailable; observe again.");
    return result.result.value;
  }

  private async resolveRef(client: CdpClient, tab: Tab, ref: string): Promise<{ objectId: string; backendNodeId: number }> {
    const backendNodeId = tab.refs.get(ref);
    if (backendNodeId === undefined) throw new BrowserPolicyError("browser_ref_unknown", `${ref} is not a current element reference. Call read_page or find again and use a fresh ref.`);
    try {
      const resolved = await client.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId }, tab.sessionId);
      return { objectId: resolved.object.objectId, backendNodeId };
    } catch (error) {
      this.rethrowStaleRef(ref, error);
      throw error;
    }
  }

  async refCenter(operationId: string, ref: string, tabId?: string | null): Promise<{ x: number; y: number }> {
    const op = this.operation(operationId);
    const tab = this.tab(op, tabId);
    const client = await this.engineClient();
    const { objectId, backendNodeId } = await this.resolveRef(client, tab, ref);
    await client.send("Runtime.callFunctionOn", { objectId, functionDeclaration: "function(){ this.scrollIntoView({block:'center', inline:'center'}); }" }, tab.sessionId);
    const box = await client.send<{ model: { content: number[] } }>("DOM.getBoxModel", { backendNodeId }, tab.sessionId);
    const q = box.model.content;
    return { x: (q[0]! + q[2]! + q[4]! + q[6]!) / 4, y: (q[1]! + q[3]! + q[5]! + q[7]!) / 4 };
  }

  async scrollToRef(operationId: string, ref: string, tabId?: string | null): Promise<void> { await this.refCenter(operationId, ref, tabId); }

  async formInput(operationId: string, ref: string, value: string | number | boolean, tabId?: string | null): Promise<string> {
    const op = this.operation(operationId);
    const tab = this.tab(op, tabId);
    const client = await this.engineClient();
    const { objectId } = await this.resolveRef(client, tab, ref);
    const result = await client.send<{ result: { value?: string } }>("Runtime.callFunctionOn", { objectId, returnByValue: true, arguments: [{ value }], functionDeclaration: `function(v){
      const el = this; const tag = el.tagName ? el.tagName.toLowerCase() : "";
      const fire = () => { el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); };
      if (tag === 'select') { const opt = Array.from(el.options).find(o => o.value === String(v) || o.text === String(v)); if (!opt) return 'option not found'; el.value = opt.value; fire(); return 'selected ' + opt.text; }
      if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) { const next = typeof v === 'boolean' ? v : String(v) === 'true'; if (el.checked !== next) { el.click(); } return (el.checked ? 'checked' : 'unchecked'); }
      if (tag === 'input' || tag === 'textarea') { const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto, 'value').set; el.focus(); setter.call(el, String(v)); fire(); return 'set'; }
      if (el.isContentEditable) { el.focus(); el.textContent = String(v); fire(); return 'set'; }
      return 'element is not a form control';
    }` }, tab.sessionId);
    return result.result.value ?? "set";
  }

  /**
   * 좌표의 요소를 읽는다 — 셀렉터·태그·텍스트·상자·React 컴포넌트(가능하면 소스 위치까지).
   * 요소 선택과 주석 매핑이 같이 쓴다. 결과는 페이지가 준 데이터이지 지시가 아니다.
   */
  async inspectAt(operationId: string, x: number, y: number, tabId?: string | null): Promise<ElementInfo | null> {
    const op = this.operation(operationId);
    const tab = this.tab(op, tabId);
    const client = await this.engineClient();
    let backendNodeId: number;
    try {
      // DOM 에이전트는 문서를 한 번 요청한 뒤에야 좌표 조회에 답한다 — 항해마다 문서가 바뀌므로 매번 가볍게 요청한다.
      await client.send("DOM.getDocument", { depth: 0 }, tab.sessionId);
      const found = await client.send<{ backendNodeId: number }>("DOM.getNodeForLocation", { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false }, tab.sessionId);
      backendNodeId = found.backendNodeId;
    } catch (error) { this.deps.log(`inspect failed: ${error instanceof Error ? error.message : "unknown"}`); return null; }
    const resolved = await client.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId }, tab.sessionId);
    const result = await client.send<{ result: { value?: ElementInfo }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>("Runtime.callFunctionOn", { objectId: resolved.object.objectId, returnByValue: true, functionDeclaration: INSPECT_FUNCTION }, tab.sessionId);
    if (result.exceptionDetails) this.deps.log(`inspect script failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "unknown"}`);
    const info = result.result.value ?? null;
    if (info) { const ref = `ref_i${backendNodeId}`; tab.refs.set(ref, backendNodeId); return { ...info, ref }; }
    return null;
  }

  consoleMessages(operationId: string, options: { tabId?: string | null; pattern?: string; limit?: number } = {}): ConsoleEntry[] {
    const op = this.operation(operationId);
    const tab = this.tab(op, options.tabId);
    let regex: RegExp | null = null;
    if (options.pattern) { try { regex = new RegExp(options.pattern, "i"); } catch { regex = null; } }
    const entries = regex ? tab.console.filter((entry) => regex!.test(entry.text) || regex!.test(entry.level)) : tab.console;
    return entries.slice(-(options.limit ?? 100));
  }

  networkRequests(operationId: string, options: { tabId?: string | null; pattern?: string; limit?: number } = {}): NetworkEntry[] {
    const op = this.operation(operationId);
    const tab = this.tab(op, options.tabId);
    let regex: RegExp | null = null;
    if (options.pattern) { try { regex = new RegExp(options.pattern, "i"); } catch { regex = null; } }
    const entries = [...tab.network.values()].filter((entry) => !regex || regex.test(entry.url) || regex.test(entry.method) || regex.test(String(entry.status ?? "")));
    return entries.slice(-(options.limit ?? 100));
  }

  async responseBody(operationId: string, requestId: string, tabId?: string | null): Promise<{ body: string; base64: boolean; truncated: boolean }> {
    const op = this.operation(operationId);
    const tab = this.tab(op, tabId);
    if (!tab.network.has(requestId)) throw new BrowserPolicyError("browser_request_unknown", `Request ${requestId} is not in this tab's log.`);
    const client = await this.engineClient();
    const result = await client.send<{ body: string; base64Encoded: boolean }>("Network.getResponseBody", { requestId }, tab.sessionId);
    const truncated = result.body.length > BODY_LIMIT;
    return { body: truncated ? result.body.slice(0, BODY_LIMIT) : result.body, base64: result.base64Encoded, truncated };
  }
}

export interface ElementInfo {
  readonly ref?: string;
  readonly selector: string;
  readonly tag: string;
  readonly id: string | null;
  readonly classes: readonly string[];
  readonly text: string;
  readonly role: string | null;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly component: string | null;
  readonly source: string | null;
  readonly styles: Record<string, string>;
}

/** ref 클릭 직전 — 가운데 점이 자신(또는 자손)인지, disabled 인지. */
const HIT_TEST_FUNCTION = `function () {
  const el = this.nodeType === 3 ? this.parentElement : this;
  if (!el || !el.getBoundingClientRect) return { ok: false, reason: 'not_visible', x: 0, y: 0, disabled: false, hit: null };
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { ok: false, reason: 'not_visible', x: 0, y: 0, disabled: false, hit: null };
  const desc = (node) => {
    if (!node || !node.tagName) return null;
    const id = node.id || null;
    const cls = node.classList ? Array.from(node.classList).slice(0, 2) : [];
    const selector = node.tagName.toLowerCase() + (id ? '#' + id : (cls.length ? '.' + cls.join('.') : ''));
    const text = ((node.innerText || node.value || node.getAttribute?.('aria-label') || '') + '').trim().slice(0, 120);
    const disabled = !!(node.disabled || node.getAttribute?.('aria-disabled') === 'true' || node.closest?.('[disabled], [aria-disabled="true"]'));
    return { tag: node.tagName.toLowerCase(), id, text, disabled, selector };
  };
  const disabled = !!(el.disabled || el.getAttribute?.('aria-disabled') === 'true' || el.closest?.('[disabled], [aria-disabled="true"]'));
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  let top = document.elementFromPoint(x, y);
  // 바깥 문서의 가림 판정을 보존하며 대상의 shadow root 경로만 따라간다(닫힌 root 포함).
  const roots = [];
  for (let root = el.getRootNode(); root && root.host; root = root.host.getRootNode()) roots.unshift(root);
  for (const root of roots) {
    if (top !== root.host) break;
    top = root.elementFromPoint(x, y);
  }
  if (!top) return { ok: false, reason: 'no_hit', x, y, disabled, hit: null };
  const within = el === top || el.contains(top);
  const hit = desc(top);
  if (!within) return { ok: false, reason: 'occluded', x, y, disabled, hit };
  if (disabled) return { ok: false, reason: 'disabled', x, y, disabled: true, hit };
  return { ok: true, x, y, disabled: false, hit };
}`;

/** 페이지 안에서 실행 — 셀렉터, React 파이버의 컴포넌트 이름과 개발 빌드의 소스 위치를 읽는다. */
const INSPECT_FUNCTION = `function () {
  const el = this.nodeType === 3 ? this.parentElement : this;
  if (!el || !el.getBoundingClientRect) return null;
  const esc = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : v);
  const part = (node) => {
    let s = node.tagName.toLowerCase();
    if (node.id) return s + "#" + esc(node.id);
    const cls = Array.from(node.classList).filter((c) => c.length < 40 && !/[0-9a-f]{6,}/i.test(c)).slice(0, 2);
    if (cls.length) s += "." + cls.map(esc).join(".");
    const parent = node.parentElement;
    if (parent) { const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName); if (same.length > 1 && !cls.length) s += ":nth-of-type(" + (same.indexOf(node) + 1) + ")"; }
    return s;
  };
  const chain = []; let cur = el; let depth = 0;
  while (cur && cur.nodeType === 1 && depth < 4) { chain.unshift(part(cur)); if (cur.id) break; cur = cur.parentElement; depth += 1; }
  const selector = chain.join(" > ");
  const r = el.getBoundingClientRect();
  let component = null, source = null;
  const key = Object.keys(el).find((k) => k.indexOf("__reactFiber$") === 0);
  if (key) {
    let fiber = el[key]; let hops = 0;
    while (fiber && hops < 25) {
      const t = fiber.type;
      const name = typeof t === "function" ? (t.displayName || t.name) : (t && typeof t === "object" && (t.displayName || (t.render && t.render.name) || (t.type && t.type.name))) || null;
      if (name && !component) component = name;
      const src = fiber._debugSource;
      if (src && src.fileName && !source) { const segs = String(src.fileName).split("/"); source = segs.slice(-3).join("/") + ":" + src.lineNumber; }
      if (component && source) break;
      fiber = fiber.return; hops += 1;
    }
  }
  const cs = getComputedStyle(el);
  const styles = {}; const props = ["display", "position", "color", "background-color", "font-size", "font-weight", "font-family", "margin", "padding"];
  for (let i = 0; i < props.length; i += 1) styles[props[i]] = cs.getPropertyValue(props[i]);
  return { selector, tag: el.tagName.toLowerCase(), id: el.id || null, classes: Array.from(el.classList).slice(0, 8), text: String(el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 160), role: el.getAttribute("role"), box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }, component, source, styles };
}`;

interface AxNode {
  nodeId: string; ignored?: boolean; role?: { value?: string }; name?: { value?: string }; value?: { value?: unknown };
  properties?: { name: string; value?: { value?: unknown } }[]; childIds?: string[]; parentId?: string; backendDOMNodeId?: number;
}

const INTERACTIVE_ROLES = new Set(["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider", "spinbutton", "textarea"]);

/**
 * 이 뷰는 사람이 쓰는 브라우저다. 셸의 Chromium 이 보고한 버전 그대로의 일반 Chrome 브랜드 메타데이터를 만든다 — 버전을
 * 꾸미지는 않는다.
 */
async function browserIdentity(client: CdpClient): Promise<{ userAgent: string; metadata: Record<string, unknown> } | null> {
  const version = await client.send<{ userAgent: string; product: string }>("Browser.getVersion");
  const userAgent = version.userAgent.replace("HeadlessChrome/", "Chrome/");
  const full = /Chrome\/(\d+(?:\.\d+){0,3})/.exec(userAgent)?.[1] ?? version.product.replace(/^.*\//, "");
  const major = full.split(".")[0] ?? full;
  const platform = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";
  const brands = [{ brand: "Google Chrome", version: major }, { brand: "Chromium", version: major }, { brand: "Not:A-Brand", version: "99" }];
  const metadata = { brands, fullVersionList: [{ brand: "Google Chrome", version: full }, { brand: "Chromium", version: full }, { brand: "Not:A-Brand", version: "99.0.0.0" }], fullVersion: full, platform, platformVersion: platform === "macOS" ? "14.0.0" : platform === "Windows" ? "15.0.0" : "6.0.0", architecture: process.arch.startsWith("arm") ? "arm" : "x86", model: "", mobile: false, bitness: "64", wow64: false };
  return { userAgent, metadata };
}


function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, Math.round(value))); }
