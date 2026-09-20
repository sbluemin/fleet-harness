import crypto from "node:crypto";
import { DESKTOP_BROWSER_SHELL_VIEW, type DesktopBrowserBounds, type DesktopBrowserCommand, type DesktopBrowserRelay, type DesktopBrowserSnapshot, type DesktopBrowserView } from "@fleet-console/protocol/desktop";
import { CdpError, type CdpClient, type CdpEvent, type CdpListener } from "./cdp.js";

/**
 * Operation Browser 의 엔진 — 창을 든 Fleet Desktop 안의 실제 Chromium 뷰.
 *
 * `CdpClient` 얼굴을 하고 있어 BrowserService 는 전송을 모른다. 명령은 스냅샷(SSE)에 실려 셸로 내려가고, 응답과
 * 이벤트는 relay(POST)로 올라온다. 브라우저 수준의 명령(`Target.*`, `Browser.*`)은 셸에 CDP 브라우저 세션이 없으므로
 * 여기서 뷰 목록으로 풀어 낸다 — 탭 하나가 뷰 하나, 세션 id 가 곧 뷰 id 다.
 *
 * 셸은 여럿 붙을 수 있다(이 기계의 Desktop, 원격에서 건너온 Desktop). 뷰는 그중 **호스트** 하나의 창에만 산다 —
 * 어느 셸이 호스트인지는 서버가 제어 보유자로 정해 `setHost` 로 알린다. 호스트가 아닌 셸은 빈 스냅샷만 받고 그 relay 는
 * 무시된다. 호스트가 바뀌면 옛 창의 뷰는 옮길 수 없으므로 모두 닫힌다.
 *
 * 호스트의 구독이 끊기면(창 종료·재시작) 유예 뒤 `closed` 가 풀리고 서비스는 탭을 정리한다.
 */

const ATTACH_TIMEOUT_MS = 10_000;
/** 셸의 구독이 끊긴 뒤 이만큼 안에 다시 붙으면 뷰와 탭을 그대로 잇는다 — 절전·루프백 순단은 창이 닫힌 것이 아니다. */
const RECONNECT_GRACE_MS = 5_000;
const COMMAND_TIMEOUT_MS = 60_000;

interface Pending { readonly command: DesktopBrowserCommand; readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> }
interface ViewRecord { id: string; operationId: string; partition: string; profile: string | null; url: string; attached: boolean; active: boolean; size: { width: number; height: number; scale: number } | null }
interface Placement { bounds: DesktopBrowserBounds; visible: boolean }

export interface DesktopEngineDeps {
  /** 스냅샷이 바뀌었다 — 호스트 셸에는 전체를, 다른 셸에는 빈 스냅샷을 보낸다. */
  readonly publish: (snapshot: DesktopBrowserSnapshot, host: string | null) => void;
  readonly log: (message: string) => void;
}

export class DesktopEngine implements CdpClient {
  private readonly views = new Map<string, ViewRecord>();
  /** 컨텍스트마다의 영속 프로필. Operation 은 컨텍스트를 하나씩 가지므로 파티션은 늘 Operation 마다 다르고,
   *  같은 프로필을 고른 Operation 들만 셸에서 같은 디스크 세션을 나눠 쓴다. */
  private readonly contextProfiles = new Map<string, string | null>();
  private readonly placements = new Map<string, Placement>();
  private readonly pending = new Map<number, Pending>();
  private readonly attachWaiters = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly listeners = new Set<CdpListener>();
  private readonly subscribers = new Map<string, number>();
  private readonly identities = new Map<string, { product: string; userAgent: string }>();
  private nextCommandId = 1;
  private generation = 0;
  private host: string | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private closedResolve: (() => void) | null = null;
  private closedPromise: Promise<void>;

  constructor(private readonly deps: DesktopEngineDeps) {
    this.closedPromise = new Promise((resolve) => { this.closedResolve = resolve; });
  }

  /** 지금 열려 있는 수명이 끝날 때 풀린다. 호스트 셸이 다시 붙으면 새 수명이 시작된다. */
  get closed(): Promise<void> { return this.closedPromise; }

  /** 호스트 셸이 스냅샷을 구독 중인가 — 그래야 뷰를 띄울 창이 있다. */
  get connected(): boolean { return this.host !== null && ((this.subscribers.get(this.host) ?? 0) > 0 || this.graceTimer !== null); }

  /** 지금 뷰를 그리는 셸. `"local"` 은 이 기계의 창, 그 밖은 원격 세션의 공개 이름. */
  get currentHost(): string | null { return this.host; }

  hasSubscriber(owner: string): boolean { return (this.subscribers.get(owner) ?? 0) > 0; }

  /**
   * 뷰를 그릴 셸을 정한다. 바뀌면 옛 창에 살던 뷰는 모두 닫힌다 — 다른 기계의 창으로 옮길 수 없기 때문이다.
   * 서비스는 `closed` 로 그 사실을 듣고 탭을 정리한다.
   */
  setHost(next: string | null): boolean {
    if (next === this.host) return false;
    const previous = this.host;
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    this.host = next;
    this.deps.log(`browser view host ${previous ?? "none"} → ${next ?? "none"}`);
    // 옛 호스트의 세션은 끝난다 — 뷰·명령이 없어도 서비스의 엔진 바인딩은 옛 셸을 가리키고 있으므로 닫아 다시 집게 한다.
    if (previous !== null) { void this.close(); return true; }
    if (next !== null && this.hasSubscriber(next) && this.closedResolve === null) this.closedPromise = new Promise((resolve) => { this.closedResolve = resolve; });
    this.publish();
    return true;
  }

  /** 셸의 SSE 구독 하나가 열리고 닫힐 때. 호스트의 마지막 구독이 닫히면 유예 뒤 엔진도 닫힌다. */
  subscriberOpened(owner: string): void {
    this.subscribers.set(owner, (this.subscribers.get(owner) ?? 0) + 1);
    if (owner !== this.host) return;
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    if (this.closedResolve === null) this.closedPromise = new Promise((resolve) => { this.closedResolve = resolve; });
  }
  subscriberClosed(owner: string): void {
    const remaining = Math.max(0, (this.subscribers.get(owner) ?? 0) - 1);
    if (remaining === 0) this.subscribers.delete(owner); else this.subscribers.set(owner, remaining);
    if (owner !== this.host || remaining > 0 || this.graceTimer) return;
    // 셸의 스트림은 끊기면 1초 뒤 다시 붙는다 — 그 사이를 닫힘으로 읽으면 열린 페이지가 전부 사라진다.
    this.graceTimer = setTimeout(() => { this.graceTimer = null; if (!this.hasSubscriber(owner) && this.host === owner) void this.close(); }, RECONNECT_GRACE_MS);
  }

  snapshot(): DesktopBrowserSnapshot {
    const views: DesktopBrowserView[] = [...this.views.values()].map((view) => {
      const placement = this.placements.get(view.operationId) ?? null;
      // `visible` 은 Companion presentation. 자리(bounds)는 숨겨도 남겨 셸이 parking 때 마지막 유효 크기를 지키게 한다.
      const visible = view.active && placement !== null && placement.visible;
      return { id: view.id, operationId: view.operationId, partition: view.partition, profile: view.profile, visible, bounds: placement?.bounds ?? null, url: view.url };
    });
    return { generation: this.generation, views, commands: [...this.pending.values()].map((entry) => entry.command) };
  }

  /** 호스트가 아닌 셸이 받는 스냅샷 — 그 창에는 아무 뷰도 없다. */
  emptySnapshot(): DesktopBrowserSnapshot { return { generation: this.generation, views: [], commands: [] }; }

  /**
   * Companion 자리. `null` 은 presentation 만 내린다 — 마지막 양수 bounds 는 남겨 실행 크기와 자리를 분리한다.
   * 활성 탭만 `visible: true` 로 그려지고, 같은 Operation 의 다른 탭은 그 bounds 크기로 parking 된다.
   */
  place(operationId: string, placement: Placement | null): void {
    if (placement) this.placements.set(operationId, placement);
    else {
      const previous = this.placements.get(operationId);
      if (previous && previous.bounds.width >= 1 && previous.bounds.height >= 1) {
        this.placements.set(operationId, { bounds: previous.bounds, visible: false });
      } else {
        this.placements.delete(operationId);
      }
    }
    this.publish();
  }

  /** 셸이 알려 준 **그 뷰**의 실제 크기 — 다른 탭 pane 과 섞지 않는다. */
  viewSize(viewId: string): { width: number; height: number; scale: number } | null { return this.views.get(viewId)?.size ?? null; }
  viewOperation(viewId: string): string | null { return this.views.get(viewId)?.operationId ?? null; }

  /** 셸이 되돌려 보낸 것들. 호스트가 아닌 셸의 것은 자기소개만 받고 나머지는 무시한다 — 그 창에는 뷰가 없다. */
  relay(owner: string, body: DesktopBrowserRelay): void {
    if (body.hello) this.identities.set(owner, body.hello);
    if (owner !== this.host) return;
    for (const id of body.attached ?? []) {
      const view = this.views.get(id);
      if (!view) continue;
      view.attached = true;
      const waiter = this.attachWaiters.get(id);
      if (waiter) { clearTimeout(waiter.timer); this.attachWaiters.delete(id); waiter.resolve(); }
    }
    for (const id of body.detached ?? []) {
      if (!this.views.has(id)) continue;
      // 셸이 뷰를 잃었다(디버거 부착 실패·렌더러 사망) — 부착을 기다리던 탭 생성도 지금 실패한다.
      this.dropView(id);
      this.emit({ method: "Target.detachedFromTarget", params: { sessionId: id, targetId: id }, sessionId: id });
    }
    for (const size of body.sizes ?? []) {
      const view = this.views.get(size.viewId);
      if (!view || size.width < 1 || size.height < 1) continue;
      view.size = { width: size.width, height: size.height, scale: size.scale > 0 ? size.scale : 1 };
      this.emit({ method: "Fleet.viewResized", params: { width: view.size.width, height: view.size.height, scale: view.size.scale }, sessionId: size.viewId });
    }
    for (const entry of body.results ?? []) {
      const waiting = this.pending.get(entry.id);
      if (!waiting) continue;
      this.pending.delete(entry.id);
      clearTimeout(waiting.timer);
      if (entry.error !== undefined) waiting.reject(new CdpError(waiting.command.method, -32000, entry.error)); else waiting.resolve(entry.result ?? {});
    }
    for (const event of body.events ?? []) {
      if (!this.views.has(event.viewId)) continue;
      this.emit({ method: event.method, params: event.params, sessionId: event.viewId });
    }
    if ((body.attached?.length ?? 0) + (body.detached?.length ?? 0) > 0 || (body.results?.length ?? 0) > 0) this.publish();
  }

  // ---------- CdpClient ----------

  async send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (!this.connected) throw new CdpError("desktop", -32000, "desktop_browser_disconnected");
    switch (method) {
      case "Browser.getVersion": {
        const identity = (this.host ? this.identities.get(this.host) : undefined) ?? { product: "Chrome/0", userAgent: "" };
        return { product: identity.product, userAgent: identity.userAgent, protocolVersion: "1.3" } as T;
      }
      case "Target.createBrowserContext": {
        // `fleetProfile` 은 Fleet 의 확장 인자다 — 이 컨텍스트의 뷰가 어느 영속 프로필에 살지.
        const contextId = `fleet-browser-${crypto.randomUUID().slice(0, 8)}`;
        this.contextProfiles.set(contextId, typeof params.fleetProfile === "string" ? params.fleetProfile : null);
        return { browserContextId: contextId } as T;
      }
      case "Target.disposeBrowserContext": {
        const partition = String(params.browserContextId ?? "");
        // 파티션은 Operation 마다 다르므로 여기서 떨어지는 뷰도 그 Operation 의 것뿐이다. 프로필을 공유하는
        // 다른 Operation 의 뷰는 파티션이 달라 살아남고, 디스크의 프로필도 지워지지 않는다.
        for (const view of [...this.views.values()]) if (view.partition === partition) this.dropView(view.id);
        this.contextProfiles.delete(partition);
        this.publish();
        return {} as T;
      }
      case "Target.createTarget": return { targetId: await this.createView(String(params.browserContextId ?? "default"), String(params.url ?? "about:blank")) } as T;
      case "Target.attachToTarget": {
        const targetId = String(params.targetId ?? "");
        if (!this.views.has(targetId)) throw new CdpError(method, -32000, "desktop_view_missing");
        return { sessionId: targetId } as T;
      }
      case "Target.closeTarget": { this.dropView(String(params.targetId ?? "")); this.publish(); return { success: true } as T; }
      case "Target.activateTarget": {
        const target = this.views.get(String(params.targetId ?? ""));
        if (target) { for (const view of this.views.values()) if (view.operationId === target.operationId) view.active = view.id === target.id; this.publish(); }
        return {} as T;
      }
      case "Browser.getWindowForTarget": {
        const view = this.views.get(String(params.targetId ?? ""));
        const size = view?.size && view.size.width >= 1 && view.size.height >= 1 ? view.size : { width: 0, height: 0 };
        return { windowId: 1, bounds: { left: 0, top: 0, width: size.width, height: size.height, windowState: "normal" } } as T;
      }
      case "Browser.setWindowBounds": return {} as T;
      default: break;
    }
    // 셸 자신에게 묻는 명령 — 뷰가 없어도 창을 든 기계가 답한다(이 기계의 Chrome 프로필·쿠키 가져오기).
    if (method.startsWith("Fleet.")) return this.dispatch<T>(DESKTOP_BROWSER_SHELL_VIEW, method, params);
    if (!sessionId || !this.views.has(sessionId)) throw new CdpError(method, -32601, "desktop_engine_unsupported");
    // 뷰 세션에는 브라우저 컨텍스트가 없다 — 컨텍스트를 짚는 인자는 뷰 자신을 뜻하므로 뗀다.
    const { browserContextId: _context, ...rest } = params;
    return this.dispatch<T>(sessionId, method, rest);
  }

  on(listener: CdpListener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  /**
   * 브라우저 세션을 닫는다 — 뷰·자리·기다리던 명령을 전부 거둔다. 셸의 구독(전송)은 건드리지 않는다: 서비스가 유휴로
   * 엔진을 내렸다가 다시 올릴 때 그 스트림은 그대로 열려 있으므로, 여기서 끊긴 것으로 세면 다시는 붙지 못한다.
   */
  async close(): Promise<void> {
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    for (const view of [...this.views.keys()]) this.dropView(view);
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new CdpError("desktop", -32000, "desktop_browser_disconnected")); }
    this.pending.clear();
    this.placements.clear();
    this.publish();
    const resolve = this.closedResolve;
    this.closedResolve = null;
    // 호스트의 구독이 살아 있으면 다음 세션을 위해 새 수명을 건다 — 서비스는 엔진을 다시 집을 때 이 약속을 새로 기다린다.
    if (this.host !== null && this.hasSubscriber(this.host)) this.closedPromise = new Promise((next) => { this.closedResolve = next; });
    resolve?.();
  }

  // ---------- 내부 ----------

  private async createView(partition: string, url: string): Promise<string> {
    const id = `view-${crypto.randomUUID().slice(0, 8)}`;
    this.views.set(id, { id, operationId: "", partition, profile: this.contextProfiles.get(partition) ?? null, url, attached: false, active: false, size: null });
    // Operation 은 컨텍스트 이름으로 안다 — 서비스가 컨텍스트를 Operation 마다 하나 만들기 때문이다.
    const attached = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.attachWaiters.delete(id); reject(new CdpError("Target.createTarget", -32000, "desktop_view_attach_timeout")); this.dropView(id); this.publish(); }, ATTACH_TIMEOUT_MS);
      this.attachWaiters.set(id, { resolve, reject, timer });
    });
    this.publish();
    await attached;
    return id;
  }

  /** 서비스가 뷰를 어느 Operation 에 묶는지 알려 준다 — 자리(placement)는 Operation 단위로 오기 때문이다. */
  bindView(viewId: string, operationId: string): void {
    const view = this.views.get(viewId);
    if (!view) return;
    view.operationId = operationId;
    this.publish();
  }

  private dropView(id: string): void {
    if (!this.views.delete(id)) return;
    // 부착을 기다리던 탭 생성도 여기서 끝난다 — 답 없이 남겨 두면 그 HTTP 요청이 영영 매달린다.
    const waiter = this.attachWaiters.get(id);
    if (waiter) { clearTimeout(waiter.timer); this.attachWaiters.delete(id); waiter.reject(new CdpError("Target.createTarget", -32000, "desktop_view_closed")); }
    this.failPendingFor(id, "desktop_view_closed");
  }

  private failPendingFor(viewId: string, reason: string): void {
    for (const [commandId, entry] of this.pending) {
      if (entry.command.viewId !== viewId) continue;
      this.pending.delete(commandId);
      clearTimeout(entry.timer);
      entry.reject(new CdpError(entry.command.method, -32000, reason));
    }
  }

  private dispatch<T>(viewId: string, method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextCommandId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CdpError(method, -32000, "desktop_command_timeout")); this.publish(); }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { command: { id, viewId, method, params }, resolve: resolve as (value: unknown) => void, reject, timer });
      this.publish();
    });
  }

  private emit(event: CdpEvent): void { for (const listener of this.listeners) listener(event); }

  private publish(): void {
    this.generation += 1;
    this.deps.publish(this.snapshot(), this.host);
  }
}
