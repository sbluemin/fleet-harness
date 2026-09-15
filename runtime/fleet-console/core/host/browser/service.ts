import crypto from "node:crypto";
import path from "node:path";
import { launchChromium, locateChromium, type CdpClient, type CdpEvent } from "./cdp.js";
import { isGoogleChrome, listChromeProfiles, readChromeCookies, type ChromeProfile } from "./chrome-import.js";
import { describeDomKey, modifierBits, parseKeyChord, type Modifiers } from "./keys.js";

/**
 * Operation Browser — Operation마다 격리된 브라우저 컨텍스트(쿠키·스토리지 파티션)와 탭을 소유하는
 * Console 서비스. 사람(패널)과 에이전트(MCP)가 같은 탭을 본다.
 *
 * 정책 두 줄:
 * - 사람은 어디든 갈 수 있다. 에이전트는 루프백과 **이 Operation에서 사람이 이미 연 호스트**에만
 *   갈 수 있다 — 사용자가 사이트를 여는 행위가 곧 그 사이트에 대한 조작 허용이다.
 * - 원격 세션이 열려 있으면 서비스는 쓰이지 않는다(로컬 전용). 컴퓨터 사용과 같은 경계.
 */

export const BROWSER_DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
/** 헤드리스 창 표면의 물리 배율 — 스크린캐스트 픽셀 수의 상한이다. 패널의 devicePixelRatio 는 이 안에서 에뮬레이션된다. */
const BROWSER_SURFACE_SCALE = 2;
const MAX_TABS = 8;
const IDLE_SHUTDOWN_MS = 5 * 60_000;
const CONSOLE_RING = 500;
const NETWORK_RING = 400;
const BODY_LIMIT = 64 * 1024;
const TEXT_LIMIT = 200_000;

export type ViewportPreset = "responsive" | "mobile" | "tablet";
export interface BrowserViewport { readonly width: number; readonly height: number; /** 패널이 보고한 devicePixelRatio — 프레임은 이 배율로 찍고 좌표·크기는 CSS px 로 말한다. */ readonly scale: number; readonly preset: ViewportPreset; readonly setBy: "user" | "agent" | null; readonly colorScheme: "light" | "dark" | null }
export interface BrowserTabState { readonly id: string; readonly url: string; readonly title: string; readonly favicon: string | null; readonly loading: boolean; readonly canGoBack: boolean; readonly canGoForward: boolean }
export interface BrowserOperationState {
  readonly operationId: string;
  readonly tabs: readonly BrowserTabState[];
  readonly activeTabId: string | null;
  readonly viewport: BrowserViewport;
  readonly driving: boolean;
  readonly consoleErrors: number;
  readonly engine: "idle" | "starting" | "ready" | "failed";
  readonly engineError: string | null;
}
export interface BrowserFrame { readonly tabId: string; readonly data: string; readonly width: number; readonly height: number; readonly scrollX: number; readonly scrollY: number }
export type BrowserSubscriber = { state?: (state: BrowserOperationState) => void; frame?: (frame: BrowserFrame) => void };

export interface ConsoleEntry { readonly at: number; readonly level: string; readonly text: string; readonly url?: string; readonly line?: number }
export interface NetworkEntry { requestId: string; loaderId: string; at: number; method: string; url: string; type: string; status: number | null; mimeType: string | null; size: number; failed: string | null; finished: boolean }

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
  loading: boolean;
  history: { index: number; length: number; leadingBlank: boolean };
  console: ConsoleEntry[];
  consoleErrors: number;
  network: Map<string, NetworkEntry>;
  refs: Map<string, number>;
  screencasting: boolean;
  lastFrame: BrowserFrame | null;
}

interface OperationBrowser {
  readonly operationId: string;
  contextId: string;
  tabs: Map<string, Tab>;
  activeTabId: string | null;
  viewport: BrowserViewport;
  subscribers: Set<BrowserSubscriber>;
  /** 에이전트 사용 세션 — 첫 도구 호출에 열리고 턴 종료·중단·회수·유휴로 닫힌다. 호출 사이에도 유지된다. */
  agentSession: { since: number; lastCallAt: number; idle: ReturnType<typeof setTimeout> | null } | null;
  /** 「중단」이 눌린 횟수 — 배치처럼 여러 호출로 이어지는 실행이 중단을 건너뛰지 못하게 세대를 비교한다. */
  interruptSerial: number;
  /** 사람이 누르고 있는 포인터 버튼 — 드래그·선택 동안 mouseMoved 가 버튼을 실어야 한다. */
  pointer: { button: "left" | "right" | "middle"; buttons: number } | null;
  agentCalls: Set<AbortController>;
}

export interface BrowserServiceDeps {
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly enabled: () => boolean;
  readonly localControl: () => boolean;
  readonly log: (message: string) => void;
}

export interface BrowserServiceStatus {
  readonly enabled: boolean;
  readonly executable: string | null;
  readonly executableSource: "env" | "playwright" | "system" | null;
  readonly engine: "idle" | "starting" | "ready" | "failed";
  readonly engineError: string | null;
  readonly operations: readonly string[];
}

function isLoopbackHost(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value.endsWith(".localhost") || value === "::1" || /^127(\.\d{1,3}){3}$/.test(value) || value === "0.0.0.0";
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
  private starting: Promise<CdpClient> | null = null;
  private engine: BrowserServiceStatus["engine"] = "idle";
  private engineError: string | null = null;
  private readonly operations = new Map<string, OperationBrowser>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** 헤드리스 창 높이와 문서 innerHeight 의 차(가상 크롬). 창을 뷰포트에 맞출 때 더한다. */
  private windowChrome: number | null = null;
  /** 헤드리스 표기를 뺀 일반 Chrome UA 와 브랜드 메타데이터 — 엔진이 뜰 때 Chrome 이 보고한 버전으로 만든다. */
  private identity: { userAgent: string; metadata: Record<string, unknown> } | null = null;
  private unsubscribeEvents: (() => void) | null = null;

  constructor(private readonly deps: BrowserServiceDeps) {}

  status(): BrowserServiceStatus {
    const located = locateChromium(this.deps.env);
    return { enabled: this.deps.enabled(), executable: located?.executable ?? null, executableSource: located?.source ?? null, engine: this.engine, engineError: this.engineError, operations: [...this.operations.keys()] };
  }

  available(): boolean { return this.deps.enabled() && this.deps.localControl(); }

  // ---------- 엔진 ----------

  private async engineClient(): Promise<CdpClient> {
    if (this.client) return this.client;
    if (this.starting) return this.starting;
    const located = locateChromium(this.deps.env);
    if (!located) { this.engine = "failed"; this.engineError = "browser_engine_missing"; throw new BrowserPolicyError("browser_engine_missing", "No local Chromium was found. Install Google Chrome or a Playwright Chromium, or set FLEET_BROWSER_CHROMIUM."); }
    this.engine = "starting";
    this.starting = launchChromium({ executable: located.executable, userDataDir: path.join(this.deps.dataDir, "profile"), windowSize: BROWSER_DEFAULT_VIEWPORT, deviceScaleFactor: BROWSER_SURFACE_SCALE, env: this.deps.env, log: this.deps.log })
      .then(async (client) => {
        this.client = client;
        this.identity = await browserIdentity(client).catch(() => null);
        this.engine = "ready";
        this.engineError = null;
        this.unsubscribeEvents = client.on((event) => this.onEvent(event));
        void client.closed.then(() => this.onEngineClosed());
        this.deps.log(`browser engine ready (${located.source}: ${located.executable})`);
        return client;
      })
      .catch((error: unknown) => { this.engine = "failed"; this.engineError = error instanceof Error ? error.message : "browser_engine_start_failed"; throw error; })
      .finally(() => { this.starting = null; });
    return this.starting;
  }

  private onEngineClosed(): void {
    this.client = null;
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    if (this.engine !== "failed") this.engine = "idle";
    for (const op of this.operations.values()) {
      for (const tab of op.tabs.values()) tab.screencasting = false;
      op.tabs.clear();
      op.activeTabId = null;
      op.contextId = "";
      this.emitState(op);
    }
  }

  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      const busy = [...this.operations.values()].some((op) => op.tabs.size > 0 || op.subscribers.size > 0 || op.agentCalls.size > 0);
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
    for (const op of this.operations.values()) { for (const call of op.agentCalls) call.abort(); op.subscribers.clear(); }
    await this.stopEngine();
    this.operations.clear();
  }

  // ---------- Operation 컨텍스트 ----------

  private operation(operationId: string): OperationBrowser {
    let op = this.operations.get(operationId);
    if (!op) {
      op = { operationId, contextId: "", tabs: new Map(), activeTabId: null, viewport: { ...BROWSER_DEFAULT_VIEWPORT, scale: 1, preset: "responsive", setBy: null, colorScheme: null }, subscribers: new Set(), agentCalls: new Set(), agentSession: null, interruptSerial: 0, pointer: null };
      this.operations.set(operationId, op);
    }
    return op;
  }

  private async context(op: OperationBrowser): Promise<{ client: CdpClient; contextId: string }> {
    const client = await this.engineClient();
    if (!op.contextId) {
      const created = await client.send<{ browserContextId: string }>("Target.createBrowserContext", { disposeOnDetach: false });
      op.contextId = created.browserContextId;
    }
    return { client, contextId: op.contextId };
  }

  state(operationId: string): BrowserOperationState {
    const op = this.operation(operationId);
    return {
      operationId,
      tabs: [...op.tabs.values()].map((tab) => ({ id: tab.id, url: tab.url, title: tab.title, favicon: tab.favicon, loading: tab.loading, canGoBack: tab.history.index > (tab.history.leadingBlank ? 1 : 0), canGoForward: tab.history.index < tab.history.length - 1 })),
      activeTabId: op.activeTabId,
      viewport: op.viewport,
      driving: op.agentSession !== null,
      consoleErrors: [...op.tabs.values()].reduce((sum, tab) => sum + tab.consoleErrors, 0),
      engine: this.engine,
      engineError: this.engineError,
    };
  }

  subscribe(operationId: string, subscriber: BrowserSubscriber): () => void {
    const op = this.operation(operationId);
    op.subscribers.add(subscriber);
    subscriber.state?.(this.state(operationId));
    const active = op.activeTabId ? op.tabs.get(op.activeTabId) : null;
    if (active) { if (active.lastFrame) subscriber.frame?.(active.lastFrame); void this.ensureScreencast(op, active); }
    return () => { op.subscribers.delete(subscriber); void this.reconcileScreencast(op); this.scheduleIdle(); };
  }

  private emitState(op: OperationBrowser): void {
    const state = this.state(op.operationId);
    for (const subscriber of op.subscribers) { try { subscriber.state?.(state); } catch { /* 구독자 오류는 서비스에 번지지 않는다 */ } }
  }

  /** 허용 회수·Operation 종료 — 진행 중 에이전트 호출을 끊고 탭과 컨텍스트를 닫는다. */
  async closeOperation(operationId: string): Promise<void> {
    const op = this.operations.get(operationId);
    if (!op) return;
    for (const call of op.agentCalls) call.abort();
    op.agentCalls.clear();
    const client = this.client;
    if (client && op.contextId) { try { await client.send("Target.disposeBrowserContext", { browserContextId: op.contextId }); } catch { /* 이미 사라졌다 */ } }
    op.tabs.clear();
    op.activeTabId = null;
    op.contextId = "";
    this.endAgentSession(operationId, "revoke");
    this.emitState(op);
    if (op.subscribers.size === 0) this.operations.delete(operationId);
    this.scheduleIdle();
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
    if (!this.available()) throw new BrowserPolicyError("browser_unavailable", "The Operation Browser is not available in this session.");
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
    const { client, contextId } = await this.context(op);
    const created = await client.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", browserContextId: contextId });
    const attached = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId: created.targetId, flatten: true });
    const tab: Tab = { id: crypto.randomUUID().slice(0, 8), targetId: created.targetId, sessionId: attached.sessionId, url: "about:blank", title: "", favicon: null, loading: false, history: { index: 0, length: 1, leadingBlank: true }, console: [], consoleErrors: 0, network: new Map(), refs: new Map(), screencasting: false, lastFrame: null };
    op.tabs.set(tab.id, tab);
    await Promise.all([
      client.send("Page.enable", {}, tab.sessionId),
      client.send("Runtime.enable", {}, tab.sessionId),
      client.send("Network.enable", { maxResourceBufferSize: 5_000_000, maxTotalBufferSize: 20_000_000 }, tab.sessionId),
      client.send("Log.enable", {}, tab.sessionId),
      client.send("DOM.enable", {}, tab.sessionId),
      client.send("Emulation.setFocusEmulationEnabled", { enabled: true }, tab.sessionId),
      ...(this.identity ? [client.send("Emulation.setUserAgentOverride", { userAgent: this.identity.userAgent, platform: process.platform === "darwin" ? "MacIntel" : process.platform === "win32" ? "Win32" : "Linux x86_64", userAgentMetadata: this.identity.metadata }, tab.sessionId)] : []),
    ]);
    if (this.windowChrome === null) this.windowChrome = await this.measureWindowChrome(client);
    await this.applyViewport(client, tab, op.viewport);
    await this.selectTab(operationId, tab.id);
    if (target) await this.navigateTab(op, tab, target.href);
    return this.state(operationId).tabs.find((entry) => entry.id === tab.id)!;
  }

  async closeTab(operationId: string, tabId: string): Promise<void> {
    const op = this.operation(operationId);
    const tab = this.tab(op, tabId);
    op.tabs.delete(tab.id);
    if (op.activeTabId === tab.id) op.activeTabId = [...op.tabs.keys()].pop() ?? null;
    if (this.client) { try { await this.client.send("Target.closeTarget", { targetId: tab.targetId }); } catch { /* 이미 닫혔다 */ } }
    const next = op.activeTabId ? op.tabs.get(op.activeTabId) : null;
    if (next) await this.ensureScreencast(op, next);
    this.emitState(op);
    this.scheduleIdle();
  }

  async selectTab(operationId: string, tabId: string): Promise<void> {
    const op = this.operation(operationId);
    const tab = this.tab(op, tabId);
    const previous = op.activeTabId ? op.tabs.get(op.activeTabId) : null;
    op.activeTabId = tab.id;
    if (previous && previous !== tab) await this.stopScreencast(previous);
    if (this.client) { try { await this.client.send("Target.activateTarget", { targetId: tab.targetId }); } catch { /* 헤드리스는 무시할 수 있다 */ } }
    await this.ensureScreencast(op, tab);
    if (tab.lastFrame) for (const subscriber of op.subscribers) subscriber.frame?.(tab.lastFrame);
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

  // ---------- Chrome 에서 가져오기 ----------

  /** 가져올 수 있는 원본 — 엔진이 Google Chrome 일 때만, 그 Chrome 의 프로필들. */
  importSources(): { available: boolean; reason: "chrome_required" | "no_profiles" | null; profiles: ChromeProfile[] } {
    const located = locateChromium(this.deps.env);
    if (!isGoogleChrome(located?.executable ?? null)) return { available: false, reason: "chrome_required", profiles: [] };
    const profiles = listChromeProfiles();
    return { available: profiles.length > 0, reason: profiles.length > 0 ? null : "no_profiles", profiles };
  }

  /** 프로필의 쿠키를 이 Operation 의 브라우저 컨텍스트에 넣는다. 열린 탭은 다음 항해부터 로그인 상태를 본다. */
  async importFromChrome(operationId: string, profileId: string): Promise<{ cookies: number }> {
    const located = locateChromium(this.deps.env);
    if (!isGoogleChrome(located?.executable ?? null) || !located) throw new BrowserPolicyError("chrome_required", "Importing needs Google Chrome as the browser engine.");
    const op = this.operation(operationId);
    const { client, contextId } = await this.context(op);
    let cookies: Awaited<ReturnType<typeof readChromeCookies>>;
    try { cookies = await readChromeCookies({ executable: located.executable, profileId, env: this.deps.env, log: this.deps.log }); }
    catch (error) { const code = error instanceof Error && error.message.startsWith("chrome_") ? error.message : "chrome_import_failed"; throw new BrowserPolicyError(code, code === "chrome_profile_not_found" ? "That Chrome profile no longer exists." : code === "chrome_cookies_missing" ? "That Chrome profile has no cookie database." : "Chrome could not open the copied profile."); }
    const params = cookies.map((cookie) => ({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}), ...(cookie.expires > 0 ? { expires: cookie.expires } : {}), ...(cookie.priority ? { priority: cookie.priority } : {}), ...(cookie.sourceScheme ? { sourceScheme: cookie.sourceScheme } : {}), ...(typeof cookie.sourcePort === "number" ? { sourcePort: cookie.sourcePort } : {}) }));
    let imported = 0;
    for (let index = 0; index < params.length; index += 200) {
      const chunk = params.slice(index, index + 200);
      try { await client.send("Storage.setCookies", { cookies: chunk, browserContextId: contextId }); imported += chunk.length; }
      catch { for (const one of chunk) { try { await client.send("Storage.setCookies", { cookies: [one], browserContextId: contextId }); imported += 1; } catch { /* 이 쿠키는 못 넣는다 */ } } }
    }
    this.deps.log(`imported ${imported}/${cookies.length} cookies from Chrome profile ${profileId} into ${operationId}`);
    return { cookies: imported };
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
      case "Page.screencastFrame": {
        const client = this.client;
        if (client) void client.send("Page.screencastFrameAck", { sessionId: p.sessionId }, tab.sessionId).catch(() => undefined);
        const meta = p.metadata ?? {};
        // 프레임의 좌표 공간은 에뮬레이션된 뷰포트(CSS px)다 — 스크린캐스트 메타데이터의 deviceWidth는
        // 창 크기를 말하므로 그대로 쓰면 패널의 클릭이 실제 위치의 배수로 어긋난다.
        // 창을 뷰포트에 맞추고 항해마다 에뮬레이션을 다시 걸어도 렌더러 교체 직후 한 장은 창 표면 크기로 올 수
        // 있다. JPEG 헤더의 실제 크기를 그대로 알리면 그 한 장도 좌표는 맞는다(상한 = 뷰포트라 축소되지 않는다).
        // 픽셀 비율이 뷰포트와 같으면 뷰포트 CSS 크기를 그대로 선언한다 — 픽셀 수는 표면 배율 상한과 JPEG
        // 축소에 따라 달라질 수 있어 픽셀을 배율로 나누면 좌표가 어긋난다. 비율이 다른 프레임(렌더러 교체
        // 직후 창 표면 크기)만 픽셀에서 환산한다.
        const pixels = jpegDimensions(p.data);
        const sameShape = pixels ? Math.abs(pixels.width / pixels.height - op.viewport.width / op.viewport.height) < 0.015 : true;
        const actual = pixels && !sameShape ? { width: Math.round(pixels.width / op.viewport.scale), height: Math.round(pixels.height / op.viewport.scale) } : { width: op.viewport.width, height: op.viewport.height };
        const frame: BrowserFrame = { tabId: tab.id, data: p.data, width: actual.width, height: actual.height, scrollX: meta.scrollOffsetX ?? 0, scrollY: meta.scrollOffsetY ?? 0 };
        tab.lastFrame = frame;
        if (op.activeTabId === tab.id) for (const subscriber of op.subscribers) subscriber.frame?.(frame);
        return;
      }
      case "Page.frameNavigated": {
        if (p.frame?.parentId) return;
        tab.url = p.frame?.url ?? tab.url;
        tab.title = "";
        // 파비콘은 새 문서의 것이 도착할 때까지 이전 것을 둔다 — 탭이 점으로 깜빡이지 않게.
        // 새 문서의 loader 가 아닌 요청은 이전 페이지의 것 — 문서 요청 자체는 남긴다.
        for (const [id, entry] of tab.network) if (entry.loaderId !== p.frame?.loaderId) tab.network.delete(id);
        tab.refs.clear();
        this.emitState(op);
        // 교차 출처 항해로 렌더러가 바뀌면 페이지의 innerWidth 는 그대로여도 컴포지터가 창 표면(1280×657)으로
        // 되돌아가 스크린캐스트 프레임이 창 크기로 온다. 에뮬레이션을 다시 걸어야 프레임이 뷰포트를 따른다.
        if (this.client) void this.applyViewport(this.client, tab, op.viewport).catch(() => undefined);
        return;
      }
      case "Page.frameStartedLoading": tab.loading = true; this.emitState(op); return;
      case "Page.loadEventFired": case "Page.frameStoppedLoading": {
        tab.loading = false;
        const client = this.client;
        if (client) void this.refreshTab(client, tab).then(() => this.emitState(op));
        if (client) void this.applyViewport(client, tab, op.viewport).catch(() => undefined);
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

  // ---------- 스크린캐스트 ----------

  private async ensureScreencast(op: OperationBrowser, tab: Tab): Promise<void> {
    if (op.subscribers.size === 0 || tab.screencasting || !this.client) return;
    tab.screencasting = true;
    try { await this.client.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: Math.round(op.viewport.width * op.viewport.scale), maxHeight: Math.round(op.viewport.height * op.viewport.scale), everyNthFrame: 1 }, tab.sessionId); }
    catch { tab.screencasting = false; }
  }

  private async stopScreencast(tab: Tab): Promise<void> {
    if (!tab.screencasting || !this.client) return;
    tab.screencasting = false;
    try { await this.client.send("Page.stopScreencast", {}, tab.sessionId); } catch { /* 탭이 사라졌다 */ }
  }

  private async reconcileScreencast(op: OperationBrowser): Promise<void> {
    if (op.subscribers.size > 0) return;
    for (const tab of op.tabs.values()) await this.stopScreencast(tab);
  }

  // ---------- 뷰포트 ----------

  /** about:blank 는 표면이 없어 innerHeight 가 창 높이를 그대로 말한다 — 문서를 하나 띄운 탐침 탭으로 잰다. */
  private async measureWindowChrome(client: CdpClient): Promise<number> {
    let targetId: string | null = null;
    try {
      const created = await client.send<{ targetId: string }>("Target.createTarget", { url: "data:text/html,<title>probe</title>" });
      targetId = created.targetId;
      const { sessionId } = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
      await client.send("Runtime.enable", {}, sessionId);
      const win = await client.send<{ bounds: { height: number } }>("Browser.getWindowForTarget", { targetId });
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        const inner = await client.send<{ result: { value?: number } }>("Runtime.evaluate", { expression: "innerHeight", returnByValue: true }, sessionId);
        const value = inner.result.value;
        if (typeof value === "number" && value > 0 && value < win.bounds.height) return win.bounds.height - value;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return 0;
    } catch { return 0; }
    finally { if (targetId) await client.send("Target.closeTarget", { targetId }).catch(() => undefined); }
  }

  private async applyViewport(client: CdpClient, tab: Tab, viewport: BrowserViewport): Promise<void> {
    const preset = viewport.preset === "responsive" ? null : PRESETS[viewport.preset];
    // 창 표면을 뷰포트와 같게 둔다 — 에뮬레이션이 잠시 풀리는 순간(렌더러 교체)에도 프레임이 창 크기로
    // 되돌아가 뷰포트와 어긋나지 않게. 창 높이에는 헤드리스의 가상 크롬만큼을 더한다.
    try {
      const win = await client.send<{ windowId: number; bounds: { width: number; height: number } }>("Browser.getWindowForTarget", { targetId: tab.targetId });
      const height = viewport.height + (this.windowChrome ?? 0);
      if (win.bounds.width !== viewport.width || win.bounds.height !== height) await client.send("Browser.setWindowBounds", { windowId: win.windowId, bounds: { width: viewport.width, height } });
    } catch { /* 창 조정은 보조 수단이다 */ }
    // 화면 크기도 창과 같게 알린다 — 헤드리스 기본 400×300 화면은 어떤 실제 기기와도 맞지 않는다.
    await client.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.scale, mobile: preset?.mobile ?? false, screenWidth: viewport.width, screenHeight: viewport.height }, tab.sessionId);
    await client.send("Emulation.setEmulatedMedia", { features: viewport.colorScheme ? [{ name: "prefers-color-scheme", value: viewport.colorScheme }] : [] }, tab.sessionId);
    if (tab.screencasting) { await this.stopScreencast(tab); const op = [...this.operations.values()].find((entry) => entry.tabs.has(tab.id)); if (op) await this.ensureScreencast(op, tab); }
  }

  async setViewport(operationId: string, request: { preset?: ViewportPreset; width?: number; height?: number; scale?: number; colorScheme?: "light" | "dark" | null }, actor: "user" | "agent"): Promise<BrowserViewport> {
    const op = this.operation(operationId);
    const preset = request.preset ?? (request.width || request.height ? "responsive" : op.viewport.preset);
    const size = preset === "responsive"
      ? { width: clamp(request.width ?? op.viewport.width, 320, 3840), height: clamp(request.height ?? op.viewport.height, 240, 2400) }
      : PRESETS[preset];
    const scale = typeof request.scale === "number" && Number.isFinite(request.scale) ? Math.min(BROWSER_SURFACE_SCALE, Math.max(1, Math.round(request.scale * 4) / 4)) : op.viewport.scale;
    op.viewport = { width: size.width, height: size.height, scale, preset, setBy: actor, colorScheme: request.colorScheme === undefined ? op.viewport.colorScheme : request.colorScheme };
    if (this.client) for (const tab of op.tabs.values()) await this.applyViewport(this.client, tab, op.viewport).catch(() => undefined);
    this.emitState(op);
    // 정적인 페이지는 크기가 바뀌어도 새 프레임을 그리지 않을 수 있다 — 한 장을 직접 찍어 즉시 보낸다.
    const active = op.activeTabId ? op.tabs.get(op.activeTabId) : null;
    if (active && op.subscribers.size > 0) {
      try {
        // 스크린캐스트와 같은 물리 배율로 찍는다 — screenshot() 은 에이전트·첨부용이라 CSS px 로 줄인다.
        const shot = await this.engineClient().then((client) => client.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 70, captureBeyondViewport: false }, active.sessionId));
        const frame: BrowserFrame = { tabId: active.id, data: shot.data, width: op.viewport.width, height: op.viewport.height, scrollX: 0, scrollY: 0 };
        active.lastFrame = frame;
        for (const subscriber of op.subscribers) subscriber.frame?.(frame);
      } catch { /* 다음 스크린캐스트 프레임이 대신한다 */ }
    }
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

  async domKey(operationId: string, input: { type: "down" | "up"; key: string; code: string; modifiers: Modifiers; repeat?: boolean }, tabId?: string | null): Promise<void> {
    const op = this.operation(operationId);
    const tab = this.tab(op, tabId);
    const client = await this.engineClient();
    const descriptor = describeDomKey(input.key, input.code, input.modifiers);
    const modifiers = modifierBits(input.modifiers);
    // macOS 편집 단축키(cmd+a·c·v·x·z)는 에이전트 경로와 같이 commands 로 실어야 실제 편집이 일어난다.
    const command = editCommand(descriptor.key, input.modifiers);
    if (input.type === "down") await client.send("Input.dispatchKeyEvent", { type: descriptor.text ? "keyDown" : "rawKeyDown", key: descriptor.key, code: descriptor.code, windowsVirtualKeyCode: descriptor.keyCode, nativeVirtualKeyCode: descriptor.keyCode, modifiers, autoRepeat: input.repeat === true, ...(command ? { commands: [command] } : {}), ...(descriptor.text ? { text: descriptor.text, unmodifiedText: descriptor.text } : {}) }, tab.sessionId);
    else await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: descriptor.key, code: descriptor.code, windowsVirtualKeyCode: descriptor.keyCode, nativeVirtualKeyCode: descriptor.keyCode, modifiers }, tab.sessionId);
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

  async insertText(operationId: string, text: string, tabId?: string | null): Promise<void> {
    const op = this.operation(operationId);
    const tab = this.tab(op, tabId);
    const client = await this.engineClient();
    await client.send("Input.insertText", { text }, tab.sessionId);
  }

  /** IME 조합 중 글자 — 페이지의 입력 필드에 조합 상태로 보여 준다. 빈 문자열은 조합 취소. 확정은 insertText 가 한다. */
  async imeComposition(operationId: string, text: string, tabId?: string | null): Promise<void> {
    const op = this.operation(operationId);
    const tab = this.tab(op, tabId);
    const client = await this.engineClient();
    await client.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length }, tab.sessionId);
  }

  /** 에이전트의 `type` — 줄바꿈은 Enter 로, 나머지는 텍스트 삽입으로. */
  async typeText(operationId: string, text: string, tabId?: string | null): Promise<void> {
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i]) await this.insertText(operationId, parts[i]!, tabId);
      if (i < parts.length - 1) await this.keyChord(operationId, "Return", tabId);
    }
  }

  // ---------- 관찰 ----------

  async screenshot(operationId: string, options: { tabId?: string | null; clip?: { x: number; y: number; width: number; height: number }; format?: "png" | "jpeg" } = {}): Promise<{ data: string; mimeType: string; width: number; height: number }> {
    const op = this.operation(operationId);
    const tab = this.tab(op, options.tabId);
    const client = await this.engineClient();
    const format = options.format ?? "png";
    const result = await client.send<{ data: string }>("Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality: 80 } : {}), clip: { ...(options.clip ?? { x: 0, y: 0, width: op.viewport.width, height: op.viewport.height }), scale: 1 / op.viewport.scale }, captureBeyondViewport: false }, tab.sessionId);
    return { data: result.data, mimeType: format === "png" ? "image/png" : "image/jpeg", width: options.clip?.width ?? op.viewport.width, height: options.clip?.height ?? op.viewport.height };
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
  async readPage(operationId: string, options: { tabId?: string | null; filter?: "interactive" | "all"; maxChars?: number } = {}): Promise<{ text: string; refs: number; truncated: boolean; total: number }> {
    const op = this.operation(operationId);
    const tab = this.tab(op, options.tabId);
    const client = await this.engineClient();
    const tree = await client.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree", {}, tab.sessionId);
    tab.refs.clear();
    const byId = new Map(tree.nodes.map((node) => [node.nodeId, node]));
    const interactive = options.filter === "interactive";
    const lines: string[] = [];
    let refCount = 0;
    const walk = (node: AxNode, depth: number) => {
      const role = node.role?.value ?? "";
      const name = node.name?.value ?? "";
      const ignored = node.ignored === true;
      const isInteractive = INTERACTIVE_ROLES.has(role);
      if (!ignored && (!interactive || isInteractive) && (role !== "generic" && role !== "none" || name)) {
        let ref = "";
        if (node.backendDOMNodeId !== undefined && (isInteractive || !interactive)) { refCount += 1; ref = `ref_${refCount}`; tab.refs.set(ref, node.backendDOMNodeId); }
        const value = node.value?.value;
        const props = (node.properties ?? []).filter((prop) => ["checked", "expanded", "selected", "disabled", "focused", "pressed", "invalid", "required"].includes(prop.name) && prop.value?.value !== false && prop.value?.value !== "false").map((prop) => `${prop.name}=${String(prop.value?.value)}`);
        lines.push(`${"  ".repeat(Math.min(depth, 12))}- ${role}${name ? ` "${name.slice(0, 200)}"` : ""}${ref ? ` [${ref}]` : ""}${value !== undefined && value !== "" ? ` value="${String(value).slice(0, 120)}"` : ""}${props.length ? ` {${props.join(", ")}}` : ""}`);
      }
      for (const childId of node.childIds ?? []) { const child = byId.get(childId); if (child) walk(child, ignored ? depth : depth + 1); }
    };
    const root = tree.nodes.find((node) => !node.parentId) ?? tree.nodes[0];
    if (root) walk(root, 0);
    const full = lines.join("\n");
    const limit = options.maxChars ?? 50_000;
    const truncated = full.length > limit;
    const text = truncated ? full.slice(0, full.lastIndexOf("\n", limit)) + `\n…(truncated: ${full.length} chars total; pass a larger max_chars or use filter "interactive")` : full;
    return { text, refs: refCount, truncated, total: full.length };
  }

  async find(operationId: string, query: string, tabId?: string | null): Promise<string> {
    const page = await this.readPage(operationId, { tabId, filter: "all", maxChars: 400_000 });
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = page.text.split("\n").filter((line) => { if (/^\s*- (InlineTextBox|StaticText)\b/.test(line)) return false; const lower = line.toLowerCase(); return terms.every((term) => lower.includes(term)); }).slice(0, 40);
    return hits.length ? hits.map((line) => line.trim()).join("\n") : `No elements match "${query}". Use read_page to see the tree.`;
  }

  private async resolveRef(client: CdpClient, tab: Tab, ref: string): Promise<{ objectId: string; backendNodeId: number }> {
    const backendNodeId = tab.refs.get(ref);
    if (backendNodeId === undefined) throw new BrowserPolicyError("browser_ref_unknown", `${ref} is not a current element reference. Call read_page or find again and use a fresh ref.`);
    const resolved = await client.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId }, tab.sessionId);
    return { objectId: resolved.object.objectId, backendNodeId };
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
 * 이 창은 사람이 쓰는 로컬 Chrome 이다. 헤드리스 빌드가 UA 에 붙이는 HeadlessChrome 표기와 Chromium 브랜드를
 * Chrome 이 스스로 보고한 버전 그대로의 일반 Chrome 값으로 바꾼다 — 버전을 꾸미지는 않는다.
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

/** base64 JPEG 의 SOF 마커에서 픽셀 크기를 읽는다. 디코딩 없이 헤더만 훑는다. */
function jpegDimensions(base64: string): { width: number; height: number } | null {
  const bytes = Buffer.from(base64.slice(0, 4096), "base64");
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i += 1; continue; }
    const marker = bytes[i + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  return null;
}

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, Math.round(value))); }
