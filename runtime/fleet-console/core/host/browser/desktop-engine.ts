import crypto from "node:crypto";
import type { DesktopBrowserBounds, DesktopBrowserCommand, DesktopBrowserRelay, DesktopBrowserSnapshot, DesktopBrowserView } from "@fleet-console/desktop-protocol";
import { CdpError, type CdpClient, type CdpEvent, type CdpListener } from "./cdp.js";

/**
 * Operation Browser 의 두 번째 엔진 — 창을 든 Fleet Desktop 안의 실제 Chromium 뷰.
 *
 * 헤드리스 엔진과 같은 `CdpClient` 얼굴을 하고 있어 BrowserService 는 어느 쪽인지 거의 모른다. 차이는 전송뿐이다:
 * 명령은 스냅샷(SSE)에 실려 셸로 내려가고, 응답과 이벤트는 relay(POST)로 올라온다. 브라우저 수준의 명령
 * (`Target.*`, `Browser.*`)은 셸에 CDP 브라우저 세션이 없으므로 여기서 뷰 목록으로 풀어 낸다 — 탭 하나가 뷰 하나,
 * 세션 id 가 곧 뷰 id 다.
 *
 * 셸이 스냅샷을 구독하고 있는 동안만 산다. 구독이 끊기면(창 종료·재시작) `closed` 가 풀리고 서비스는 헤드리스 엔진이
 * 죽었을 때와 같은 길로 탭을 정리한다.
 */

const ATTACH_TIMEOUT_MS = 10_000;
/** 셸의 구독이 끊긴 뒤 이만큼 안에 다시 붙으면 뷰와 탭을 그대로 잇는다 — 절전·루프백 순단은 창이 닫힌 것이 아니다. */
const RECONNECT_GRACE_MS = 5_000;
const COMMAND_TIMEOUT_MS = 60_000;

interface Pending { readonly command: DesktopBrowserCommand; readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> }
interface ViewRecord { id: string; operationId: string; partition: string; url: string; attached: boolean; active: boolean; size: { width: number; height: number; scale: number } | null }
interface Placement { bounds: DesktopBrowserBounds; visible: boolean }

export interface DesktopEngineDeps {
  /** 스냅샷이 바뀌었다 — 구독 중인 셸에 새 스냅샷을 보낸다. */
  readonly publish: (snapshot: DesktopBrowserSnapshot) => void;
  readonly log: (message: string) => void;
}

export class DesktopEngine implements CdpClient {
  private readonly views = new Map<string, ViewRecord>();
  private readonly placements = new Map<string, Placement>();
  private readonly pending = new Map<number, Pending>();
  private readonly attachWaiters = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly listeners = new Set<CdpListener>();
  private nextCommandId = 1;
  private generation = 0;
  private identity: { product: string; userAgent: string } | null = null;
  private subscribers = 0;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private closedResolve: (() => void) | null = null;
  private closedPromise: Promise<void>;

  constructor(private readonly deps: DesktopEngineDeps) {
    this.closedPromise = new Promise((resolve) => { this.closedResolve = resolve; });
  }

  /** 지금 열려 있는 수명이 끝날 때 풀린다. 셸이 다시 붙으면 새 수명이 시작된다. */
  get closed(): Promise<void> { return this.closedPromise; }

  /** 셸이 스냅샷을 구독 중인가 — 그래야 뷰를 띄울 상대가 있다. */
  get connected(): boolean { return this.subscribers > 0 || this.graceTimer !== null; }

  /** 셸의 SSE 구독 하나가 열리고 닫힐 때. 마지막 구독이 닫히면 엔진도 닫힌다. */
  subscriberOpened(): void {
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    if (this.subscribers === 0 && this.closedResolve === null) this.closedPromise = new Promise((resolve) => { this.closedResolve = resolve; });
    this.subscribers += 1;
  }
  subscriberClosed(): void {
    this.subscribers = Math.max(0, this.subscribers - 1);
    if (this.subscribers > 0 || this.graceTimer) return;
    // 셸의 스트림은 끊기면 1초 뒤 다시 붙는다 — 그 사이를 닫힘으로 읽으면 열린 페이지가 전부 사라진다.
    this.graceTimer = setTimeout(() => { this.graceTimer = null; if (this.subscribers === 0) void this.close(); }, RECONNECT_GRACE_MS);
  }

  snapshot(): DesktopBrowserSnapshot {
    const views: DesktopBrowserView[] = [...this.views.values()].map((view) => {
      const placement = this.placements.get(view.operationId) ?? null;
      const visible = view.active && placement !== null && placement.visible;
      return { id: view.id, operationId: view.operationId, partition: view.partition, visible, bounds: placement?.bounds ?? null, url: view.url };
    });
    return { generation: this.generation, views, commands: [...this.pending.values()].map((entry) => entry.command) };
  }

  /** 패널이 알려 준 자기 자리. Operation 의 활성 탭 뷰가 이 자리에 놓인다. */
  place(operationId: string, placement: Placement | null): void {
    if (placement) this.placements.set(operationId, placement); else this.placements.delete(operationId);
    this.publish();
  }

  /** 셸이 알려 준 뷰의 실제 크기 — 서비스가 뷰포트로 삼는다. */
  viewSize(viewId: string): { width: number; height: number; scale: number } | null { return this.views.get(viewId)?.size ?? null; }
  viewOperation(viewId: string): string | null { return this.views.get(viewId)?.operationId ?? null; }

  /** 셸이 되돌려 보낸 것들. */
  relay(body: DesktopBrowserRelay): void {
    if (body.hello) this.identity = body.hello;
    for (const id of body.attached ?? []) {
      const view = this.views.get(id);
      if (!view) continue;
      view.attached = true;
      const waiter = this.attachWaiters.get(id);
      if (waiter) { clearTimeout(waiter.timer); this.attachWaiters.delete(id); waiter.resolve(); }
    }
    for (const id of body.detached ?? []) {
      const view = this.views.get(id);
      if (!view) continue;
      this.views.delete(id);
      this.failPendingFor(id, "desktop_view_detached");
      this.emit({ method: "Target.detachedFromTarget", params: { sessionId: id, targetId: id }, sessionId: id });
    }
    for (const size of body.sizes ?? []) {
      const view = this.views.get(size.viewId);
      if (!view) continue;
      view.size = { width: size.width, height: size.height, scale: size.scale };
      this.emit({ method: "Fleet.viewResized", params: { width: size.width, height: size.height, scale: size.scale }, sessionId: size.viewId });
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
        const identity = this.identity ?? { product: "Chrome/0", userAgent: "" };
        return { product: identity.product, userAgent: identity.userAgent, protocolVersion: "1.3" } as T;
      }
      case "Target.createBrowserContext": return { browserContextId: `fleet-browser-${crypto.randomUUID().slice(0, 8)}` } as T;
      case "Target.disposeBrowserContext": {
        const partition = String(params.browserContextId ?? "");
        for (const view of [...this.views.values()]) if (view.partition === partition) this.dropView(view.id);
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
        const size = view?.size ?? { width: 0, height: 0 };
        return { windowId: 1, bounds: { left: 0, top: 0, width: size.width, height: size.height, windowState: "normal" } } as T;
      }
      case "Browser.setWindowBounds": return {} as T;
      default: break;
    }
    if (!sessionId || !this.views.has(sessionId)) throw new CdpError(method, -32601, "desktop_engine_unsupported");
    // 뷰 세션에는 브라우저 컨텍스트가 없다 — 컨텍스트를 짚는 인자는 뷰 자신을 뜻하므로 뗀다.
    const { browserContextId: _context, ...rest } = params;
    return this.dispatch<T>(sessionId, method, rest);
  }

  on(listener: CdpListener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  async close(): Promise<void> {
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    for (const view of [...this.views.keys()]) this.dropView(view);
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new CdpError("desktop", -32000, "desktop_browser_disconnected")); }
    this.pending.clear();
    this.placements.clear();
    this.subscribers = 0;
    this.publish();
    this.closedResolve?.();
    this.closedResolve = null;
  }

  // ---------- 내부 ----------

  private async createView(partition: string, url: string): Promise<string> {
    const id = `view-${crypto.randomUUID().slice(0, 8)}`;
    this.views.set(id, { id, operationId: "", partition, url, attached: false, active: false, size: null });
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
    this.deps.publish(this.snapshot());
  }
}
