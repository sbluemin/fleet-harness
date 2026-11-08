import * as React from "react";
import { createPortal, flushSync } from "react-dom";
import { DESKTOP_BROWSER_DETACH_CAPABILITY, DESKTOP_BROWSER_WINDOW_PAGE, type DesktopBrowserSurface } from "@fleet-console/protocol/desktop";

export interface BrowserSurfaceState extends DesktopBrowserSurface { readonly status: "opening" | "ready" | "opened" | "closing" }
interface SurfaceDocument { readonly document: Document; readonly id: string; readonly focus: () => void }
const documents = new Map<string, SurfaceDocument>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function publish(ownerId: string, next: SurfaceDocument | null): void {
  if (next) documents.set(ownerId, next); else documents.delete(ownerId);
  for (const listener of listeners) listener();
}
export function useBrowserDocument(ownerId: string): SurfaceDocument | null {
  return React.useSyncExternalStore(subscribe, () => documents.get(ownerId) ?? null, () => null);
}

/** 현재 controller의 표면만 다시 부른다. 없는 표면을 만들거나 inline 복귀로 토글하지 않는다. */
export function focusBrowserWindow(ownerId: string): boolean {
  const surface = documents.get(ownerId);
  if (!surface) return false;
  surface.focus();
  return true;
}

/** controller는 부모에 남긴다. 문서 수명마다 portal target을 새로 만들어 종료된 문서의 event listener를 재사용하지 않는다. */
export function BrowserSurfaceContent({ ownerId, role, children, placeholder, blocked = false }: { readonly ownerId: string; readonly role: "caption" | "body"; readonly children: React.ReactNode; readonly placeholder?: React.ReactNode; readonly blocked?: boolean }) {
  const published = useBrowserDocument(ownerId);
  const surface = blocked ? null : published;
  const documentFor = surface?.document ?? document;
  const container = React.useMemo(() => {
    const element = documentFor.createElement("div");
    element.className = `op-browser-${role}-content`;
    return element;
  }, [documentFor, role]);
  const slot = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const target = surface?.document.getElementById(`browser-window-${role}`) ?? slot.current;
    target?.append(container);
  }, [container, surface, role]);
  React.useLayoutEffect(() => () => container.remove(), [container]);
  return <><div ref={slot} className={`op-browser-${role}-slot`}>{surface ? placeholder : null}</div>{createPortal(children, container)}</>;
}

/** 수동 문서는 앱을 실행하지 않는다. 부모가 소유한 테마/스타일만 같은 origin에서 이어 준다. */
function mirrorStyles(target: Document): () => void {
  const copy = () => {
    for (const attribute of [...target.documentElement.attributes]) if (attribute.name !== "data-browser-surface") target.documentElement.removeAttribute(attribute.name);
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

export function useBrowserWindow(ownerId: string, browserId: string | null, lease: BrowserSurfaceState | null, available: boolean, readCapabilities: () => readonly string[]) {
  const [clientId] = React.useState(() => crypto.randomUUID());
  const [pending, setPending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const surface = useBrowserDocument(ownerId);
  const record = React.useRef<{ id: string; child: Window | null; stop: (() => void) | null } | null>(null);
  const alive = React.useRef(true);
  const returning = React.useRef(false);
  const endpoint = `/api/v1/browser/objectives/${encodeURIComponent(ownerId)}`;
  const request = React.useCallback(async (action: "open" | "close" | "focus", id?: string) => {
    const response = await fetch(`${endpoint}/surface`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, id, clientId }) });
    if (!response.ok) throw new Error("browser_surface_failed");
    return await response.json() as { surface: BrowserSurfaceState | null };
  }, [endpoint, clientId]);

  const restore = React.useCallback(async () => {
    const current = record.current;
    if (!current || returning.current) return;
    returning.current = true;
    current.stop?.();
    // native close ack보다 먼저 DOM을 inline으로 반환한다. main 자체의 teardown에서는 이 경로를 실행하지 않는다.
    if (alive.current) flushSync(() => publish(ownerId, null)); else publish(ownerId, null);
    try { await request("close", current.id); } catch { /* shell/host 수명 종료에서도 local UI는 반환한다. */ }
    if (record.current === current) record.current = null;
    returning.current = false;
    if (alive.current) setPending(false);
  }, [ownerId, request]);

  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const current = record.current;
      current?.stop?.();
      if (current) { publish(ownerId, null); void request("close", current.id).catch(() => undefined); }
      record.current = null;
    };
  }, [ownerId, request]);

  React.useEffect(() => {
    const current = record.current;
    if (current && (!available || lease?.id !== current.id || lease.clientId !== clientId || lease.status === "closing")) {
      queueMicrotask(() => { if (record.current === current) void restore(); });
    }
  }, [available, lease, clientId, restore]);

  const detach = async () => {
    if (pending || record.current) { record.current?.child?.focus(); return; }
    setPending(true); setFailed(false);
    try {
      const opened = await request("open");
      if (!opened.surface || opened.surface.clientId !== clientId) throw new Error("browser_surface_busy");
      const current = { id: opened.surface.id, child: null as Window | null, stop: null as (() => void) | null };
      record.current = current;
      let ready = opened.surface.status === "ready";
      const until = Date.now() + 5_000;
      while (!ready && alive.current && record.current === current && Date.now() < until) {
        await pause();
        const response = await fetch(`${endpoint}/state`);
        if (!response.ok) throw new Error("browser_surface_failed");
        const state = await response.json() as { surface: BrowserSurfaceState | null };
        if (state.surface?.id !== current.id) throw new Error("browser_surface_revoked");
        ready = state.surface.status === "ready";
      }
      if (!ready || !alive.current || record.current !== current) throw new Error("browser_surface_revoked");
      const child = window.open(DESKTOP_BROWSER_WINDOW_PAGE, current.id, "popup,width=1000,height=760");
      if (!child) throw new Error("browser_surface_blocked");
      current.child = child;
      while (alive.current && record.current === current && Date.now() < until) {
        if (child.closed) throw new Error("browser_surface_closed");
        if (child.location.href === `${location.origin}${DESKTOP_BROWSER_WINDOW_PAGE}` && child.document.readyState === "complete") break;
        await pause();
      }
      if (!alive.current || record.current !== current || child.closed || child.document.readyState !== "complete"
        || child.location.href !== `${location.origin}${DESKTOP_BROWSER_WINDOW_PAGE}`) throw new Error("browser_surface_failed");
      current.stop = mirrorStyles(child.document);
      child.document.documentElement.dataset.browserSurface = current.id;
      flushSync(() => publish(ownerId, { document: child.document, id: current.id, focus: () => {
        if (alive.current && record.current === current) void request("focus", current.id).catch(() => undefined);
      } }));
      child.focus();
    } catch {
      if (alive.current) setFailed(true);
      await restore();
    } finally { if (alive.current) setPending(false); }
  };

  return {
    clientId, surface: record.current?.id === surface?.id ? surface : null,
    blocked: lease?.browserId === browserId && lease.clientId !== clientId,
    available: readCapabilities().includes(DESKTOP_BROWSER_DETACH_CAPABILITY),
    disabled: pending || !available || (lease !== null && lease.clientId !== clientId),
    failed,
    toggle: () => { if (surface) void restore(); else void detach(); },
  };
}
