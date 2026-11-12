import {
  DESKTOP_BROWSER_FRAME_MAX_BYTES,
  DESKTOP_BROWSER_FRAME_SEQ_HEADER,
  DESKTOP_BROWSER_VIEWER_EVENT,
  DESKTOP_BROWSER_VIEWER_EVENTS_PATH,
  DESKTOP_BROWSER_VIEWER_PATH,
  isDesktopBrowserViewerSnapshot,
  type DesktopBrowserChrome,
  type DesktopBrowserSurface,
  type DesktopBrowserViewerSnapshot,
} from "@fleet-console/protocol/desktop";

import type { SurfaceControl } from "./browser-surface.js";
import type { ChromeAction, ChromeRole, ChromeViewOnly } from "./chrome/contract.js";
import { translator } from "./chrome/messages.js";
import { normalizeConsoleOrigin as normalizeAnyConsoleOrigin } from "./console-links.js";
import { createDesktopEventStream } from "./desktop-event-stream.js";

/**
 * 보기 전용 플릿 브라우저 셸 — 창이 이 Desktop 이 관리하지 않는 Console(원격으로 건너온 곳, 비관리 Console)을 보는 동안의 브라우저 화면.
 *
 * 화면은 이 Desktop 의 것이다: 관리 Console 에서 쓰는 것과 같은 표면(칸·독립 창, 주소줄·탭 표시줄·스페이스)을 세우되 페이지 뷰가 없고,
 * 스테이지가 실행 측이 찍어 올린 최신 프레임 한 장을 그린다. Console 은 투영과 프레임을 중계할 뿐 화면을 그리지 않는다.
 * 여기서 보내는 요청은 읽기와 「그만 본다」 둘뿐이다 — 어느 탭·스페이스를 보는지는 이 셸만의 보기 상태라 실행 측의 표시 탭을 바꾸지 않는다.
 */

const VIEWER_FRAME_PATH = "/api/v1/browser/viewer/frame";
const VIEWER_UNWATCH_PATH = "/api/v1/browser/viewer/unwatch";
const FRAME_WAIT_MS = 12_000;
const FRAME_RETRY_MS = 1_000;
const MAX_VIEWER_SSE_BUFFER_CHARS = 16 * 1024 * 1024;
const VIEWER_BROWSER_ID = "global";

/** 보기 전용 셸이 쓰는 표면의 좁은 면. 관리 세션이 쓰는 표면과 같은 객체다. */
export interface BrowserViewerDisplay {
  apply(surface: DesktopBrowserSurface | null, chrome: DesktopBrowserChrome | null, origin: string | null, viewOnly?: ChromeViewOnly | null): void;
  conceal(): void;
  /** 지금 서 있는 표면이 보기 전용 셸인가. */
  viewing(): boolean;
  frame(tabId: string, jpeg: Buffer): void;
}

export interface RemoteBrowserViewerDeps {
  readonly display: BrowserViewerDisplay;
  readonly fetch: typeof fetch;
  readonly lang: "ko" | "en";
  /** 표면의 모양만 바꾸는 동작(표시줄 방향·고정·펼침·스페이스 화면 열기)은 관리 표면과 같은 처리기가 맡는다. Console 에 요청을 보내지 않는 동작만 넘긴다. */
  readonly localAct: (control: SurfaceControl, role: ChromeRole, action: ChromeAction) => void;
  readonly log?: (message: string) => void;
  readonly setTimeout?: (callback: () => void, delay: number) => unknown;
  readonly clearTimeout?: (timer: unknown) => void;
}

export interface RemoteBrowserViewer {
  /** 창이 보는 Console 이 바뀌었다. 이 Desktop 이 관리하지 않는 Console 이면 그 origin, 관리 Console 이거나 없으면 null. 다른 Console 로 옮기면 보던 셸은 닫힌다. */
  follow(origin: string | null): void;
  /** 사람이 그 Console 화면의 브라우저 단추를 눌렀다 — 열려 있으면 닫고, 닫혀 있으면 연다. 관리 Console 을 보는 동안에는 아무 일도 없다. */
  toggle(): void;
  /** 보기 전용 셸이 열려 있는가. 열려 있는 동안 표면의 동작과 닫힘 보고는 이 모듈로 온다. */
  active(): boolean;
  act(control: SurfaceControl, role: ChromeRole, action: ChromeAction): void;
  /** 독립 창이 닫혔다. */
  closed(): void;
  stop(): void;
}

export function createRemoteBrowserViewer(deps: RemoteBrowserViewerDeps): RemoteBrowserViewer {
  const t = translator(deps.lang);
  const log = deps.log ?? (() => {});
  const schedule = deps.setTimeout ?? ((callback: () => void, delay: number) => setTimeout(callback, delay));
  const cancel = deps.clearTimeout ?? ((timer: unknown) => { clearTimeout(timer as ReturnType<typeof setTimeout>); });
  let origin: string | null = null;
  let open = false;
  /** 칸으로 열지 창으로 열지 — 앱이 켜져 있는 동안 기억한다. */
  let mode: "pane" | "window" = "pane";
  let serial = 0;
  let surfaceId = "";
  let snapshot: DesktopBrowserViewerSnapshot | null = null;
  /** 이 셸이 보는 탭. 실행 측의 표시 탭과 다를 수 있다. */
  let viewed: string | null = null;
  /** 마지막으로 본 실행 측 표시 탭 — 「바뀌었다」를 가린다. 아직 투영을 받지 못했으면 undefined. */
  let remoteActive: string | null | undefined;
  let watch: { readonly tabId: string; readonly origin: string; readonly controller: AbortController } | null = null;

  const stream = createDesktopEventStream<DesktopBrowserViewerSnapshot>({
    snapshotPath: DESKTOP_BROWSER_VIEWER_PATH,
    eventsPath: DESKTOP_BROWSER_VIEWER_EVENTS_PATH,
    eventName: DESKTOP_BROWSER_VIEWER_EVENT,
    parseSnapshot: (value) => (isDesktopBrowserViewerSnapshot(value) ? value : null),
    apply: (next) => { if (!open) return; snapshot = next; render(); },
    maxFrameChars: MAX_VIEWER_SSE_BUFFER_CHARS,
    normalizeOrigin: (value) => normalizeAnyConsoleOrigin(value, "desktop_browser_viewer_origin_invalid"),
    fetch: deps.fetch,
  });

  const place = (): ChromeViewOnly => {
    const host = snapshot?.executionHost ?? null;
    if (!host) return { place: "", status: "connected" };
    const text = host.status === "unmanaged" ? t("viewOnly.unmanagedPlace")
      : host.status === "manager_disconnected" ? (host.hostLabel ? t("viewOnly.disconnectedHost", { host: host.hostLabel }) : t("viewOnly.disconnectedPlace"))
        : host.accessPath === "wsl" ? (host.hostLabel ? `${t("viewOnly.wsl")} · ${host.hostLabel}` : t("viewOnly.wsl"))
          : host.hostLabel ? t("viewOnly.host", { host: host.hostLabel }) : t("viewOnly.desktop");
    return { place: text, status: host.status };
  };

  /** 문서에 줄 투영 — 실행 측 표시 탭 자리에 이 셸이 보는 탭을 넣는다. 실행 측 표시 탭이 바뀌면 따라가고, 보던 탭이 닫히면 놓는다. */
  const derive = (): DesktopBrowserChrome | null => {
    const remote = snapshot?.chrome ?? null;
    if (!remote) return null;
    if (remote.activeTabId !== remoteActive) {
      remoteActive = remote.activeTabId;
      if (remote.activeTabId !== null) viewed = remote.activeTabId;
    }
    if (viewed !== null && !remote.tabs.some((tab) => tab.id === viewed)) viewed = null;
    return { ...remote, activeTabId: viewed };
  };

  const stopWatch = (): void => {
    const current = watch;
    if (!current) return;
    watch = null;
    current.controller.abort();
    // 보던 탭을 그만 본다고 알린다 — 실행 측이 그 뷰의 캡처·업로드를 곧바로 멈춘다.
    void deps.fetch(`${current.origin}${VIEWER_UNWATCH_PATH}?tabId=${encodeURIComponent(current.tabId)}`, { method: "POST", headers: { Origin: current.origin } }).catch(() => undefined);
  };

  const startWatch = (tabId: string, at: string): void => {
    const controller = new AbortController();
    const mine = { tabId, origin: at, controller };
    watch = mine;
    const alive = (): boolean => watch === mine && !controller.signal.aborted;
    const pause = (): Promise<void> => new Promise((resolve) => {
      const timer = schedule(resolve, FRAME_RETRY_MS);
      controller.signal.addEventListener("abort", () => { cancel(timer); resolve(); }, { once: true });
    });
    void (async () => {
      let after = 0;
      while (alive()) {
        try {
          const response = await deps.fetch(`${at}${VIEWER_FRAME_PATH}?tabId=${encodeURIComponent(tabId)}&afterSeq=${after}&waitMs=${FRAME_WAIT_MS}`, { headers: { Origin: at }, signal: controller.signal, cache: "no-store" });
          if (!alive()) return;
          if (response.status === 204) continue;
          if (!response.ok) { await response.arrayBuffer().catch(() => undefined); await pause(); continue; }
          const seq = Number(response.headers.get(DESKTOP_BROWSER_FRAME_SEQ_HEADER) ?? "0");
          const bytes = Buffer.from(await response.arrayBuffer());
          if (!alive()) return;
          if (Number.isFinite(seq) && seq > after) after = seq;
          if (bytes.length >= 2 && bytes.length <= DESKTOP_BROWSER_FRAME_MAX_BYTES && bytes[0] === 0xff && bytes[1] === 0xd8) deps.display.frame(tabId, bytes);
        } catch {
          if (!alive()) return;
          await pause();
        }
      }
    })();
  };

  /** 보는 탭이 있고 실행 측이 붙어 있는 동안만 프레임을 기다린다. */
  const syncWatch = (): void => {
    const want = open && origin !== null && snapshot?.executionHost.status === "connected" ? viewed : null;
    if (watch && watch.tabId === want && watch.origin === origin) return;
    stopWatch();
    if (want !== null && origin !== null) startWatch(want, origin);
  };

  function render(): void {
    if (!open || origin === null) return;
    const chrome = derive();
    deps.display.apply({ id: surfaceId, browserId: chrome?.browserId ?? VIEWER_BROWSER_ID, mode }, chrome, origin, place());
    // 표면이 스페이스를 맞추며 보는 탭을 바꿨을 수 있다(apply 안에서 show-tab 이 온다) — 그 뒤의 값으로 프레임을 맞춘다.
    syncWatch();
  }

  const close = (): void => {
    if (!open) return;
    open = false;
    stream.stop();
    stopWatch();
    snapshot = null; viewed = null; remoteActive = undefined;
    if (deps.display.viewing()) deps.display.conceal();
  };

  const show = (tabId: string | null): void => {
    const next = tabId !== null && snapshot?.chrome?.tabs.some((tab) => tab.id === tabId) ? tabId : null;
    if (next === viewed) { syncWatch(); return; }
    viewed = next;
    render();
  };

  return {
    follow(next) {
      if (next === origin) return;
      close();
      origin = next;
    },
    toggle() {
      if (origin === null) return;
      if (open) { close(); return; }
      open = true;
      serial += 1;
      surfaceId = `viewer-${serial}`;
      const at = origin;
      render();
      void stream.start(at).catch((error: unknown) => log(`browser viewer stream failed: ${error instanceof Error ? error.message : "unknown"}`));
    },
    active: () => open,
    act(control, role, action) {
      if (!open) return;
      switch (action.action) {
        case "select-tab": show(action.id); return;
        // 표면이 스페이스를 맞추려고 내는 요청 — 관리 표면에서는 Console 로 가지만 여기서는 이 셸의 보기 상태만 바꾼다.
        case "show-tab": show(action.id); return;
        case "select-space": {
          control.patch({ overlay: null, suggestions: [] });
          const request = control.chooseSpace(action.id);
          if (request) show(request.kind === "select" ? request.tabId : null);
          return;
        }
        case "toggle-mode": mode = mode === "pane" ? "window" : "pane"; render(); return;
        case "close-surface": close(); return;
        case "overlay": if (action.kind === null || action.kind === "spaces") deps.localAct(control, role, action); return;
        case "pin": case "expand": case "tabs-menu": case "orientation": case "auto-expand": case "dialog-close": case "ready":
          deps.localAct(control, role, action); return;
        // 그 밖의 동작(탐색, 탭 열기·닫기, 프로필, 뷰포트, 제어권, 캡처·주석 …)은 보기 전용 셸에서 뜻이 없다. 문서가 그리지 않지만 와도 버린다.
        default: return;
      }
    },
    closed() { close(); },
    stop() { close(); origin = null; },
  };
}
