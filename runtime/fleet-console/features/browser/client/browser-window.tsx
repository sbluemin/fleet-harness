import * as React from "react";
import { createPortal, flushSync } from "react-dom";
import { DESKTOP_BROWSER_DETACH_CAPABILITY, DESKTOP_BROWSER_PANE_CAPABILITY, DESKTOP_BROWSER_WINDOW_PAGE, type DesktopBrowserSurface } from "@fleet-console/protocol/desktop";
import { desktopShellCapabilities } from "../../../core/client/src/integration/desktop-shell.js";
import { BROWSER_GLOBAL_ID } from "../shared/spaces.js";

/**
 * 분리 창은 Console 전역 브라우저(`BROWSER_GLOBAL_ID`)의 것이다 — 어느 사령관·Objective 를 보고 있든 하나이고, 그 화면을 오가도 풀리지 않는다.
 * 수명은 패널(React 트리)이 아니라 이 모듈이 쥔다. 패널은 마운트·언마운트되어도 창을 열거나 닫지 않고, 창은 사람이 되돌리거나
 * 창이 닫히거나 Desktop 이 lease 를 거둘 때만 돌아온다. 창 안의 내용은 Console 전역 호스트(BrowserSessionHost)의 패널 하나가 그린다.
 */

export interface BrowserSurfaceState extends DesktopBrowserSurface { readonly status: "opening" | "ready" | "opened" | "closing" }
interface SurfaceDocument { readonly document: Document; readonly id: string; readonly mode: "pane" | "window"; readonly focus: () => void }

let current: SurfaceDocument | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function publish(next: SurfaceDocument | null): void {
  current = next;
  for (const listener of listeners) listener();
}
export function useBrowserDocument(): SurfaceDocument | null {
  return React.useSyncExternalStore(subscribe, () => current, () => null);
}

/** 현재 표면만 다시 부른다. 없는 표면을 만들거나 inline 복귀로 토글하지 않는다. */
export function focusBrowserWindow(): boolean {
  if (!current) return false;
  current.focus();
  return true;
}

/** 분리 창의 한 슬롯(주소줄 줄·본문)에 내용을 그린다. 문서 수명마다 portal target 을 새로 만들어 종료된 문서의 event listener 를 재사용하지 않는다. */
export function BrowserSurfaceContent({ role, children }: { readonly role: "caption" | "body"; readonly children: React.ReactNode }) {
  const surface = useBrowserDocument();
  const container = React.useMemo(() => {
    if (!surface) return null;
    const element = surface.document.createElement("div");
    element.className = `op-browser-${role}-content`;
    return element;
  }, [surface, role]);
  React.useLayoutEffect(() => {
    if (!container || !surface) return;
    surface.document.getElementById(`browser-window-${role}`)?.append(container);
    return () => container.remove();
  }, [container, surface, role]);
  return container ? createPortal(children, container) : null;
}

/** 수동 문서는 앱을 실행하지 않는다. 부모가 소유한 테마/스타일만 같은 origin에서 이어 준다. */
function mirrorStyles(target: Document): () => void {
  const copy = () => {
    for (const attribute of [...target.documentElement.attributes]) if (attribute.name !== "data-browser-surface" && attribute.name !== "data-browser-mode") target.documentElement.removeAttribute(attribute.name);
    for (const attribute of document.documentElement.attributes) target.documentElement.setAttribute(attribute.name, attribute.value);
    target.body.className = `${document.body.className} browser-window-document`;
    for (const previous of target.head.querySelectorAll("[data-browser-style]")) previous.remove();
    for (const source of document.head.querySelectorAll("style, link[rel='stylesheet']")) {
      if (source.tagName === "LINK" && new URL((source as HTMLLinkElement).href).origin !== location.origin) continue;
      const clone = source.cloneNode(true) as Element;
      clone.setAttribute("data-browser-style", "");
      target.head.append(clone);
    }
  };
  copy();
  const observer = new MutationObserver(copy);
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  observer.observe(document.documentElement, { attributes: true });
  observer.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
  return () => observer.disconnect();
}

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 30));
const endpoint = `/api/v1/browser/objectives/${encodeURIComponent(BROWSER_GLOBAL_ID)}`;
/** 이 Console 화면(창)의 id — 어느 패널이 열든 같은 값이라 lease 의 주인이 패널을 따라 바뀌지 않는다. */
const clientId = crypto.randomUUID();

interface Controller { readonly pending: boolean; readonly failed: boolean }
let controller: Controller = { pending: false, failed: false };
const controllerListeners = new Set<() => void>();
function setController(next: Partial<Controller>): void {
  controller = { ...controller, ...next };
  for (const listener of controllerListeners) listener();
}
const subscribeController = (listener: () => void) => { controllerListeners.add(listener); return () => { controllerListeners.delete(listener); }; };

let record: { id: string; child: Window | null; stop: (() => void) | null } | null = null;
let returning = false;

async function request(action: "open" | "close" | "focus" | "mode", id?: string, mode?: "pane" | "window"): Promise<{ surface: BrowserSurfaceState | null }> {
  const response = await fetch(`${endpoint}/surface`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, id, clientId, mode }) });
  if (!response.ok) throw new Error("browser_surface_failed");
  return await response.json() as { surface: BrowserSurfaceState | null };
}

async function restore(): Promise<void> {
  const active = record;
  if (!active || returning) return;
  returning = true;
  active.stop?.();
  // native close ack보다 먼저 DOM을 inline으로 반환한다.
  flushSync(() => publish(null));
  try { await request("close", active.id); } catch { /* shell/host 수명 종료에서도 local UI는 반환한다. */ }
  if (record === active) record = null;
  returning = false;
  setController({ pending: false });
}

async function detach(mode: "pane" | "window" = "window"): Promise<void> {
  if (controller.pending || record) { record?.child?.focus(); return; }
  setController({ pending: true, failed: false });
  try {
    const opened = await request("open", undefined, mode);
    if (!opened.surface || opened.surface.clientId !== clientId) throw new Error("browser_surface_busy");
    const active = { id: opened.surface.id, child: null as Window | null, stop: null as (() => void) | null };
    record = active;
    let ready = opened.surface.status === "ready";
    const until = Date.now() + 5_000;
    while (!ready && record === active && Date.now() < until) {
      await pause();
      const response = await fetch(`${endpoint}/state`);
      if (!response.ok) throw new Error("browser_surface_failed");
      const state = await response.json() as { surface: BrowserSurfaceState | null };
      if (state.surface?.id !== active.id) throw new Error("browser_surface_revoked");
      ready = state.surface.status === "ready";
    }
    if (!ready || record !== active) throw new Error("browser_surface_revoked");
    const child = window.open(DESKTOP_BROWSER_WINDOW_PAGE, active.id, "popup,width=1000,height=760");
    if (!child) throw new Error("browser_surface_blocked");
    active.child = child;
    while (record === active && Date.now() < until) {
      if (child.closed) throw new Error("browser_surface_closed");
      if (child.location.href === `${location.origin}${DESKTOP_BROWSER_WINDOW_PAGE}` && child.document.readyState === "complete") break;
      await pause();
    }
    if (record !== active || child.closed || child.document.readyState !== "complete"
      || child.location.href !== `${location.origin}${DESKTOP_BROWSER_WINDOW_PAGE}`) throw new Error("browser_surface_failed");
    active.stop = mirrorStyles(child.document);
    child.document.documentElement.dataset.browserSurface = active.id;
    child.document.documentElement.dataset.browserMode = mode;
    flushSync(() => publish({ document: child.document, id: active.id, mode, focus: () => {
      if (record === active) void request("focus", active.id).catch(() => undefined);
    } }));
    child.focus();
  } catch {
    setController({ failed: true });
    await restore();
  } finally { setController({ pending: false }); }
}

/**
 * 분리 창의 상태와 손잡이. 호출한 패널이 사라져도 창은 그대로이며, lease(서버가 알리는 `state.surface`)와 어긋나면 돌아온다.
 * `synced` 가 아니면(아직 서버 상태를 못 받은 패널) 어긋남을 판정하지 않는다 — 새로 마운트된 패널이 열려 있는 창을 거두지 않게.
 */
export function useBrowserWindow(lease: BrowserSurfaceState | null, synced: boolean, available: boolean, readCapabilities: () => readonly string[]) {
  const surface = useBrowserDocument();
  const state = React.useSyncExternalStore(subscribeController, () => controller, () => controller);
  React.useEffect(() => {
    const active = record;
    if (!synced || !active) return;
    if (!available || lease?.id !== active.id || lease.clientId !== clientId) {
      queueMicrotask(() => { if (record === active) void restore(); });
      return;
    }
    if (lease.status === "closing") {
      queueMicrotask(() => {
        if (record !== active) return;
        if (readCapabilities().includes(DESKTOP_BROWSER_PANE_CAPABILITY)) void request("mode", active.id, "pane").catch(() => restore());
        else void restore();
      });
    }
    const mode = lease.mode ?? "window";
    if (current?.id === active.id && current.mode !== mode) {
      current.document.documentElement.dataset.browserMode = mode;
      publish({ ...current, mode });
    }
  }, [synced, available, lease, readCapabilities]);

  return {
    clientId, surface: record?.id === surface?.id ? surface : null,
    blocked: lease !== null && lease.clientId !== clientId,
    available: readCapabilities().includes(DESKTOP_BROWSER_DETACH_CAPABILITY),
    disabled: state.pending || !available || (lease !== null && lease.clientId !== clientId),
    failed: state.failed,
    toggle: () => {
      if (!surface) { void detach("window"); return; }
      void request("mode", surface.id, surface.mode === "pane" ? "window" : "pane").catch(() => setController({ failed: true }));
    },
    close: () => { void restore(); },
  };
}

/** 지구본/링크는 기본 셸 칸을 연다. 옛 셸 지원 종료 시 window fallback을 걷는다. */
export function openBrowserPane(): void {
  if (focusBrowserWindow()) return;
  const capabilities = desktopShellCapabilities();
  void detach(capabilities.includes(DESKTOP_BROWSER_PANE_CAPABILITY) ? "pane" : "window");
}
export function closeBrowserSurface(): void { void restore(); }
export function toggleBrowserPane(): void {
  if (current?.mode === "window") { current.focus(); return; }
  if (current) void restore(); else openBrowserPane();
}
