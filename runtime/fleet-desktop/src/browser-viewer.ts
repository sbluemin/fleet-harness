import {
  DESKTOP_BROWSER_VIEWER_EVENT,
  DESKTOP_BROWSER_VIEWER_EVENTS_PATH,
  DESKTOP_BROWSER_VIEWER_PATH,
  isDesktopBrowserViewerSnapshot,
  type DesktopBrowserChrome,
  type DesktopBrowserSurface,
  type DesktopBrowserViewerSnapshot,
  type RemoteBrowserUploadFile,
} from "@fleet-console/protocol/desktop";

import { createBrowserActions } from "./browser-actions.js";
import type { SurfaceControl } from "./browser-surface.js";
import { createRemoteBrowserViewerStream } from "./browser-viewer-stream.js";
import type { ChromeAction, ChromeRole, ChromeViewOnly } from "./chrome/contract.js";
import { translator } from "./chrome/messages.js";
import { normalizeConsoleOrigin as normalizeAnyConsoleOrigin } from "./console-links.js";
import { createDesktopEventStream } from "./desktop-event-stream.js";

/**
 * 원격 플릿 브라우저 셸 — 창이 이 Desktop 이 관리하지 않는 Console(원격으로 건너온 곳, 비관리 Console)을 보는 동안의 브라우저 화면.
 *
 * 화면은 이 Desktop 의 것이다. 페이지 뷰는 없고 스테이지가 실행 측 프레임을 그린다.
 * 스냅샷이 `remoteControl` 이고 실행 호스트가 붙어 있으면 원격 조작이다. 주소줄·탭·스페이스·대화상자·뷰포트·캡처·제어권은
 * 그 Console 의 REST 로 가고(창 쿠키, 락 토큰 없음), 스페이스를 옮기면 실행 측 activeTabId 도 맞춘다.
 * 미관리·연결 끊김·`remoteControl` 이 없는 옛 Console 은 보기 전용으로 남는다. 그때의 탭·스페이스는 이 셸의 보기 상태이고 쓰는 요청은 보내지 않는다.
 */

const MAX_VIEWER_SSE_BUFFER_CHARS = 16 * 1024 * 1024;
const VIEWER_BROWSER_ID = "global";

/** 보기 전용 셸이 쓰는 표면의 좁은 면. 관리 세션이 쓰는 표면과 같은 객체다. */
export interface BrowserViewerDisplay {
  apply(surface: DesktopBrowserSurface | null, chrome: DesktopBrowserChrome | null, origin: string | null, viewOnly?: ChromeViewOnly | null): void;
  conceal(): void;
  /** 지금 서 있는 표면이 보기 전용 셸인가. */
  viewing(): boolean;
  frame(tabId: string, jpeg: Buffer, meta?: { readonly cssWidth: number; readonly cssHeight: number } | null): void;
}

export interface RemoteBrowserViewerDeps {
  readonly display: BrowserViewerDisplay;
  readonly fetch: typeof fetch;
  readonly lang: "ko" | "en";
  /** 표면의 모양만 바꾸는 동작(표시줄 방향·고정·펼침·스페이스 화면 열기)은 관리 표면과 같은 처리기가 맡는다. Console 에 요청을 보내지 않는 동작만 넘긴다. */
  readonly localAct: (control: SurfaceControl, role: ChromeRole, action: ChromeAction) => void;
  /** 「브라우저에서 열기」는 이 창을 든 기계의 브라우저로 연다. 실행 측 기기의 브라우저가 아니다. */
  readonly openExternal?: (url: string) => void;
  /** 원격 파일 선택기 — 지금 보는 기기에서 고른 파일 바이트를 돌려준다. */
  readonly pickFiles?: (options: { readonly multiple: boolean }) => Promise<{ readonly cancelled: boolean; readonly files?: readonly RemoteBrowserUploadFile[]; readonly error?: string }>;
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
  let origin: string | null = null;
  const remoteActions = createBrowserActions({
    fetch: deps.fetch,
    origin: () => origin,
    cookieSession: true,
    lang: deps.lang,
    openExternal: (url) => deps.openExternal?.(url),
    log,
  });
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
  /** 원격 입력 배치는 앞선 서버 처리가 끝난 뒤에 다음 배치를 보내 click/drag 순서를 지킨다. */
  let remoteInputQueue: Promise<void> = Promise.resolve();
  const frameStream = createRemoteBrowserViewerStream({
    fetch: deps.fetch,
    onFrame: (tabId, frame) => {
      if (!open) return;
      deps.display.frame(tabId, frame.jpeg, { cssWidth: frame.cssWidth, cssHeight: frame.cssHeight });
    },
    log,
    setTimeout: deps.setTimeout,
    clearTimeout: deps.clearTimeout,
  });

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

  /** 실행 호스트가 붙어 있고 스냅샷이 원격 조작을 말할 때만. 옛 Console 은 필드가 없어 보기 전용이다. */
  const controllable = (): boolean => open && snapshot?.remoteControl === true && snapshot.executionHost.status === "connected";

  const place = (): ChromeViewOnly => {
    const host = snapshot?.executionHost ?? null;
    if (!host) return { place: "", status: "connected" };
    const text = host.status === "unmanaged" ? t("viewOnly.unmanagedPlace")
      : host.status === "manager_disconnected" ? (host.hostLabel ? t("viewOnly.disconnectedHost", { host: host.hostLabel }) : t("viewOnly.disconnectedPlace"))
        : host.accessPath === "wsl" ? (host.hostLabel ? `${t("viewOnly.wsl")} · ${host.hostLabel}` : t("viewOnly.wsl"))
          : host.hostLabel ? t("viewOnly.host", { host: host.hostLabel }) : t("viewOnly.desktop");
    const base: ChromeViewOnly = { place: text, status: host.status };
    if (!controllable()) return base;
    return {
      ...base,
      control: true,
      ...(snapshot?.shortcuts ? { shortcuts: snapshot.shortcuts } : {}),
      selectPopup: snapshot?.selectPopup ?? null,
      permissionPrompts: snapshot?.permissionPrompts ?? [],
      passwordPrompt: snapshot?.passwordPrompt ?? null,
      fileChooser: snapshot?.fileChooser ?? null,
    };
  };

  /** 문서에 줄 투영 — 실행 측 표시 탭 자리에 이 셸이 보는 탭을 넣는다. 실행 측 표시 탭이 바뀌면 따라가고, 보던 탭이 닫히면 놓는다. */
  const derive = (): DesktopBrowserChrome | null => {
    const remote = snapshot?.chrome ?? null;
    if (!remote) return null;
    // 원격 조작은 실행 측 표시 탭을 그대로 따른다. 스페이스를 옮기면 REST 가 activeTabId 를 맞춘다.
    if (controllable()) { remoteActive = remote.activeTabId; viewed = remote.activeTabId; return remote; }
    if (remote.activeTabId !== remoteActive) {
      remoteActive = remote.activeTabId;
      if (remote.activeTabId !== null) viewed = remote.activeTabId;
    }
    if (viewed !== null && !remote.tabs.some((tab) => tab.id === viewed)) viewed = null;
    return { ...remote, activeTabId: viewed };
  };

  /** 보는 탭이 있고 실행 측이 붙어 있는 동안만 프레임을 기다린다. */
  const syncWatch = (): void => {
    const want = open && origin !== null && snapshot?.executionHost.status === "connected" ? viewed : null;
    if (want !== null && origin !== null) frameStream.watch(want, origin);
    else frameStream.unwatch();
  };

  function render(): void {
    if (!open || origin === null) return;
    const chrome = derive();
    deps.display.apply({ id: surfaceId, browserId: chrome?.browserId ?? VIEWER_BROWSER_ID, mode }, chrome, origin, place());
    // 표면이 스페이스를 맞추며 보는 탭을 바꿨을 수 있다(apply 안에서 show-tab 이 온다) — 그 뒤의 값으로 프레임을 맞춘다.
    syncWatch();
  }

  const close = (animate = false): void => {
    if (!open) return;
    open = false;
    stream.stop();
    frameStream.unwatch();
    snapshot = null; viewed = null; remoteActive = undefined;
    if (deps.display.viewing()) {
      if (animate) deps.display.apply(null, null, null);
      else deps.display.conceal();
    }
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
      if (open) { close(true); return; }
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
      if (controllable()) {
        switch (action.action) {
          case "close-surface": close(true); return;
          case "toggle-mode": mode = mode === "pane" ? "window" : "pane"; render(); return;
          // 이 창을 든 기계의 브라우저. 실행 기기에서 열지 않는다 — 어느 쪽인지는 지휘관 결정으로 남긴다.
          case "open-external": {
            const chrome = control.chrome();
            const tab = chrome?.tabs.find((candidate) => candidate.id === chrome.activeTabId);
            if (tab && /^https?:\/\//iu.test(tab.url)) deps.openExternal?.(tab.url);
            return;
          }
          case "import-open": case "import-run":
            // 원격에서는 로컬 Chrome 가져오기를 제공하지 않는다.
            return;
          case "file-chooser-open": {
            if (!origin || !deps.pickFiles) return;
            const at = origin;
            const browserId = control.surface()?.browserId ?? control.chrome()?.browserId ?? VIEWER_BROWSER_ID;
            void (async () => {
              control.patch({ busy: true });
              try {
                const picked = await deps.pickFiles!({ multiple: action.multiple });
                if (picked.error) {
                  control.notify(t(picked.error), "error");
                  await deps.fetch(`${at}/api/v1/browser/objectives/${encodeURIComponent(browserId)}/file-chooser`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Origin: at },
                    body: JSON.stringify({ chooserId: action.chooserId, tabId: action.tabId, action: "cancel" }),
                  }).catch(() => undefined);
                  return;
                }
                const payload = picked.cancelled || !picked.files || picked.files.length === 0
                  ? { chooserId: action.chooserId, tabId: action.tabId, action: "cancel" }
                  : { chooserId: action.chooserId, tabId: action.tabId, action: "choose", files: picked.files };
                const response = await deps.fetch(`${at}/api/v1/browser/objectives/${encodeURIComponent(browserId)}/file-chooser`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Origin: at },
                  body: JSON.stringify(payload),
                });
                if (!response.ok) control.notify(t("requestFailed"), "error");
              } catch {
                control.notify(t("requestFailed"), "error");
              } finally {
                control.patch({ busy: false });
              }
            })();
            return;
          }
          case "file-chooser-cancel": {
            if (!origin) return;
            const browserId = control.surface()?.browserId ?? control.chrome()?.browserId ?? VIEWER_BROWSER_ID;
            void deps.fetch(`${origin}/api/v1/browser/objectives/${encodeURIComponent(browserId)}/file-chooser`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Origin: origin },
              body: JSON.stringify({ chooserId: action.chooserId, tabId: action.tabId, action: "cancel" }),
            }).catch(() => undefined);
            return;
          }
          case "dialog-close": {
            if (control.ui().overlay) { deps.localAct(control, role, action); return; }
            const view = place();
            if (view.passwordPrompt) { remoteActions(control, role, { action: "password-dismiss", promptId: view.passwordPrompt.id, tabId: view.passwordPrompt.tabId }); return; }
            if (view.fileChooser) {
              const browserId = control.surface()?.browserId ?? control.chrome()?.browserId ?? VIEWER_BROWSER_ID;
              if (origin) void deps.fetch(`${origin}/api/v1/browser/objectives/${encodeURIComponent(browserId)}/file-chooser`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ chooserId: view.fileChooser.id, tabId: view.fileChooser.tabId, action: "cancel" }) }).catch(() => undefined);
              return;
            }
            if (view.selectPopup) { remoteActions(control, role, { action: "select-popup", popupId: view.selectPopup.id, tabId: view.selectPopup.tabId, choice: "cancel" }); return; }
            const permission = view.permissionPrompts?.[0];
            if (permission) { remoteActions(control, role, { action: "permission-answer", promptId: permission.id, tabId: permission.tabId, allow: false }); return; }
            deps.localAct(control, role, action);
            return;
          }
          case "remote-input": {
            if (!origin || control.control()?.holder === "agent") return;
            const targetOrigin = origin;
            const browserId = control.surface()?.browserId ?? control.chrome()?.browserId ?? VIEWER_BROWSER_ID;
            const payload = JSON.stringify({ tabId: action.tabId, seq: action.seq, events: action.events });
            remoteInputQueue = remoteInputQueue
              .then(async () => {
                if (!open || origin !== targetOrigin || control.control()?.holder === "agent") return;
                await deps.fetch(`${targetOrigin}/api/v1/browser/objectives/${encodeURIComponent(browserId)}/input`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Origin: targetOrigin },
                  body: payload,
                });
              })
              .catch(() => undefined);
            return;
          }
          case "remote-select":
            remoteActions(control, role, { action: "select-popup", popupId: action.popupId, tabId: action.tabId, choice: action.choice, ...(action.indices ? { indices: action.indices } : {}) });
            return;
          case "remote-permission":
            remoteActions(control, role, { action: "permission-answer", promptId: action.promptId, tabId: action.tabId, allow: action.allow });
            return;
          case "pin": case "expand": case "tabs-menu": case "orientation": case "auto-expand":
          case "overlay": case "draft": case "guard-size": case "ready":
            deps.localAct(control, role, action); return;
          default:
            remoteActions(control, role, action); return;
        }
      }
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
        case "close-surface": close(true); return;
        case "overlay": if (action.kind === null || action.kind === "spaces") deps.localAct(control, role, action); return;
        case "pin": case "expand": case "tabs-menu": case "orientation": case "auto-expand": case "dialog-close": case "ready":
          deps.localAct(control, role, action); return;
        // 그 밖의 동작(탐색, 탭 열기·닫기, 프로필, 뷰포트, 제어권, 캡처·주석 …)은 보기 전용 셸에서 뜻이 없다. 문서가 그리지 않지만 와도 버린다.
        default: return;
      }
    },
    closed() { close(); },
    stop() { close(); frameStream.stop(); origin = null; },
  };
}
