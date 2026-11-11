import type { ConsoleLocale } from "@fleet-console/i18n";
import * as React from "react";

import { subscribeConsoleChannel } from "../../../core/client/src/integration/objective-records-sse.js";
import { BROWSER_GLOBAL_ID } from "../shared/browser-id.js";
import { readBrowserEngineBody, useBrowserEngine, type BrowserExecutionHost } from "./browser-engine.js";
import { getT } from "./i18n.js";
import "./browser-viewer.css";

/**
 * 이 클라이언트 화면의 보기 전용 브라우저. 서버의 탭·제어권은 바꾸지 않고, 보고 있는 탭의 최신 JPEG 만 받는다.
 * 패널이 닫히거나 문서가 숨으면 폴링을 끊어 캡처가 멈추게 한다.
 */

let viewerOpen = false;
const viewerListeners = new Set<() => void>();

function emitViewer(): void {
  for (const listener of viewerListeners) listener();
}

export function toggleBrowserViewer(): void {
  viewerOpen = !viewerOpen;
  emitViewer();
}

export function useBrowserViewerOpen(): boolean {
  return React.useSyncExternalStore((listener) => { viewerListeners.add(listener); return () => { viewerListeners.delete(listener); }; }, () => viewerOpen, () => false);
}

interface ViewerTab { readonly id: string; readonly spaceId: string; readonly url: string; readonly title: string }
interface ViewerSpace { readonly id: string; readonly label: string }
interface ViewerSnapshot {
  readonly tabs: readonly ViewerTab[];
  readonly spaces: readonly ViewerSpace[];
  readonly activeTabId: string | null;
  readonly driving: boolean;
  readonly executionHost: BrowserExecutionHost | null;
}

const EMPTY_SNAPSHOT: ViewerSnapshot = { tabs: [], spaces: [], activeTabId: null, driving: false, executionHost: null };

function asSnapshot(payload: unknown): ViewerSnapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as { browserId?: unknown; tabs?: unknown; spaces?: unknown; activeTabId?: unknown; driving?: unknown; executionHost?: unknown; available?: unknown; surfaceMode?: unknown };
  if (body.browserId !== undefined && body.browserId !== BROWSER_GLOBAL_ID) return null;
  const engine = readBrowserEngineBody({ available: typeof body.available === "boolean" ? body.available : true, surfaceMode: typeof body.surfaceMode === "string" ? body.surfaceMode : undefined, executionHost: body.executionHost && typeof body.executionHost === "object" ? body.executionHost as Partial<BrowserExecutionHost> : null });
  const tabs = Array.isArray(body.tabs) ? body.tabs.flatMap((tab) => {
    if (!tab || typeof tab !== "object") return [];
    const row = tab as { id?: unknown; spaceId?: unknown; url?: unknown; title?: unknown };
    return typeof row.id === "string" ? [{ id: row.id, spaceId: typeof row.spaceId === "string" ? row.spaceId : "default", url: typeof row.url === "string" ? row.url : "", title: typeof row.title === "string" ? row.title : "" }] : [];
  }) : [];
  const spaces = Array.isArray(body.spaces) ? body.spaces.flatMap((space) => {
    if (!space || typeof space !== "object") return [];
    const row = space as { id?: unknown; label?: unknown };
    return typeof row.id === "string" ? [{ id: row.id, label: typeof row.label === "string" ? row.label : "" }] : [];
  }) : [];
  return { tabs, spaces, activeTabId: typeof body.activeTabId === "string" ? body.activeTabId : null, driving: body.driving === true, executionHost: engine?.executionHost ?? null };
}

export function BrowserViewer({ language }: { readonly language: ConsoleLocale | undefined }) {
  const t = getT(language);
  const engine = useBrowserEngine();
  const open = useBrowserViewerOpen();
  const [snapshot, setSnapshot] = React.useState<ViewerSnapshot>(EMPTY_SNAPSHOT);
  const [spaceId, setSpaceId] = React.useState<string | null>(null);
  const [tabId, setTabId] = React.useState<string | null>(null);
  const [src, setSrc] = React.useState<string | null>(null);
  const [visible, setVisible] = React.useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  const srcRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!open || engine?.surfaceMode === "native") return;
    let cancelled = false;
    const apply = (payload: unknown) => { const next = asSnapshot(payload); if (next && !cancelled) setSnapshot(next); };
    const unsubscribe = subscribeConsoleChannel("browser:state", apply);
    void fetch(`/api/v1/browser/objectives/${encodeURIComponent(BROWSER_GLOBAL_ID)}/state`).then(async (response) => {
      if (!response.ok) return;
      apply(await response.json());
    }).catch(() => undefined);
    return () => { cancelled = true; unsubscribe(); };
  }, [open, engine?.surfaceMode]);

  React.useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const tabsInSpace = snapshot.tabs.filter((tab) => spaceId === null || tab.spaceId === spaceId);
  const followed = tabsInSpace.some((tab) => tab.id === tabId) ? tabId : snapshot.activeTabId && tabsInSpace.some((tab) => tab.id === snapshot.activeTabId) ? snapshot.activeTabId : tabsInSpace[0]?.id ?? null;
  const selected = snapshot.tabs.find((tab) => tab.id === followed) ?? null;
  const host = snapshot.executionHost ?? engine?.executionHost ?? null;
  const status = host?.status ?? "unmanaged";

  React.useEffect(() => {
    if (!open || !visible || !followed || status !== "connected" || engine?.surfaceMode === "native") return;
    const controller = new AbortController();
    let after = 0;
    let stopped = false;
    const watchId = followed;
    const run = async () => {
      while (!stopped && !controller.signal.aborted) {
        const response = await fetch(`/api/v1/browser/viewer/frame?tabId=${encodeURIComponent(watchId)}&afterSeq=${after}&waitMs=12000`, { signal: controller.signal, cache: "no-store" });
        if (stopped || controller.signal.aborted) return;
        if (response.status === 204) continue;
        if (!response.ok) return;
        const seq = Number(response.headers.get("x-fleet-frame-seq") ?? "0");
        if (Number.isFinite(seq) && seq > after) after = seq;
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        if (srcRef.current) URL.revokeObjectURL(srcRef.current);
        srcRef.current = url;
        setSrc(url);
      }
    };
    void run().catch(() => undefined);
    return () => {
      stopped = true;
      controller.abort();
      if (srcRef.current) { URL.revokeObjectURL(srcRef.current); srcRef.current = null; }
      setSrc(null);
      void fetch(`/api/v1/browser/viewer/unwatch?tabId=${encodeURIComponent(watchId)}`, { method: "POST" }).catch(() => undefined);
    };
  }, [open, visible, followed, status, engine?.surfaceMode]);

  if (!open || engine?.surfaceMode === "native") return null;
  const place = host?.accessPath === "wsl"
    ? (host.hostLabel ? `${t("terminal.browser.executionWsl")} · ${host.hostLabel}` : t("terminal.browser.executionWsl"))
    : host?.hostLabel
      ? t("terminal.browser.executionHost", { host: host.hostLabel })
      : t("terminal.browser.executionDesktop");
  const empty = status === "unmanaged"
    ? t("terminal.browser.unmanaged")
    : status === "manager_disconnected"
      ? t("terminal.browser.managerDisconnected")
      : snapshot.tabs.length === 0
        ? t("terminal.browser.noTabs")
        : t("terminal.browser.waitingFrame");
  return (
    <aside className="browser-viewer" aria-label={t("terminal.browser.viewOnly")}>
      <div className="browser-viewer-bar">
        <div className="browser-viewer-lead">
          <span className="browser-viewer-badge">{t("terminal.browser.viewOnly")}</span>
          <span className="browser-viewer-place">{place}</span>
          {snapshot.driving ? <span className="browser-viewer-driving">{t("terminal.browser.driving")}</span> : null}
        </div>
        <button type="button" className="browser-viewer-close" onClick={toggleBrowserViewer}>{t("terminal.browser.closeViewer")}</button>
      </div>
      <div className="browser-viewer-tabs">
        <div className="browser-viewer-choices" role="group" aria-label={t("terminal.browser.tabSelect")}>
          {snapshot.spaces.map((space) => (
            <button type="button" key={space.id} className="browser-viewer-choice" aria-pressed={space.id === (selected?.spaceId ?? spaceId)} onClick={() => { setSpaceId(space.id); setTabId(null); }}>
              {space.label || (space.id === "default" ? t("terminal.browser.spaceDefault") : space.id)}
            </button>
          ))}
          {tabsInSpace.map((tab) => (
            <button type="button" key={tab.id} className="browser-viewer-choice" aria-pressed={tab.id === selected?.id} onClick={() => setTabId(tab.id)}>
              {tab.title || tab.url || tab.id}
            </button>
          ))}
        </div>
        <div className="browser-viewer-address">
          <strong>{selected?.title || t("terminal.browser.noTabs")}</strong>
          {selected?.url ? <span>{selected.url}</span> : null}
        </div>
      </div>
      <div className="browser-viewer-stage">
        {src && status === "connected" && selected ? <img src={src} alt={selected.title || t("terminal.browser.viewOnly")} /> : <p className="browser-viewer-empty">{empty}</p>}
      </div>
    </aside>
  );
}
