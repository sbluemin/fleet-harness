import type { WebContents, WebContentsView } from "electron";

import type { DesktopShellWindow } from "./shell-window.js";
import { CONSOLE_READY_TITLE_MARK, SWITCH_VEIL_FALLBACK_MS } from "./switch-veil.js";

/**
 * 이 앱이 띄운 콘솔이 아닌 콘솔을 그리는 뷰.
 *
 * 창과 함께 만들어 빈 문서로 로컬 뷰 뒤에 세워 둔다 — 전환 순간에 붙인 뷰는 첫 합성 프레임이 늦다. 다른 콘솔로
 * 갈 때 여기에 싣고, 로컬로 돌아오면 빈 문서로 되돌린다. 빈 문서로 돌리는 것이 그 콘솔의 스트림과 세션 사용을
 * 끝내는 일이다 — 뒤에 세워 두기만 하면 떠난 콘솔이 계속 이 기계를 붙들고 있다.
 */

const BLANK_URL = "about:blank";
/** 도착도 준비 신호도 없이 멈춘 적재의 끝. 이보다 오래 가리지 않는다. */
const READY_HARD_CAP_MS = 15_000;

export interface DataViewDeps {
  readonly createView: () => WebContentsView;
  /** 이 뷰의 항해 울타리와 권한 밖 창 열기 거부. */
  readonly confine: (contents: WebContents) => void;
  readonly attach: (contents: WebContents) => void;
  readonly log?: (message: string) => void;
}

export interface DataView {
  mount(shell: DesktopShellWindow): void;
  contents(): WebContents | null;
  /**
   * 콘솔을 싣고, 그 origin에 도착했으며(400 미만) 첫 화면을 그렸다고 말할 때까지 기다린다. 준비 표식을 모르는
   * 옛 콘솔은 적재가 끝난 뒤 잠깐 기다려 준비로 본다. 표식은 준비 신호일 뿐 인가가 아니다.
   */
  load(url: string): Promise<void>;
  /** 빈 문서로 되돌린다. 실은 콘솔의 문서·스트림이 여기서 끝난다. */
  release(): Promise<void>;
  unmount(): void;
}

export function createDataView(deps: DataViewDeps): DataView {
  let view: WebContentsView | null = null;
  let shell: DesktopShellWindow | null = null;

  const live = (): WebContents | null => {
    const contents = view?.webContents;
    return contents && !contents.isDestroyed() ? contents : null;
  };

  return {
    mount(next) {
      if (shell === next && view) return;
      this.unmount();
      shell = next;
      view = deps.createView();
      const contents = view.webContents;
      deps.confine(contents);
      deps.attach(contents);
      next.stack.mountDataView(view);
      void contents.loadURL(BLANK_URL).catch(() => undefined);
    },

    contents: live,

    async load(url) {
      const contents = live();
      if (!contents) throw new Error("data_view_unavailable");
      const target = new URL(url).origin;
      const ready = awaitReady(contents, target);
      try {
        await contents.loadURL(url);
      } catch (error) {
        ready.cancel();
        throw error;
      }
      await ready.promise;
    },

    async release() {
      const contents = live();
      if (!contents) return;
      try { await contents.loadURL(BLANK_URL); } catch { /* 앞선 적재를 끊은 -3은 실패가 아니다. */ }
    },

    unmount() {
      try { shell?.stack.unmountDataView(); } catch { /* 창이 먼저 닫혔다. */ }
      const contents = live();
      try { contents?.close(); } catch { /* 이미 죽은 렌더러. */ }
      view = null;
      shell = null;
    },
  };
}

export function awaitReady(contents: WebContents, targetOrigin: string): { readonly promise: Promise<void>; cancel(): void } {
  let arrived = false;
  let fallback: ReturnType<typeof setTimeout> | null = null;
  let finish: (error?: Error) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    finish = (error) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
  });
  const hardCap = setTimeout(() => finish(arrived ? undefined : new Error("remote_host_unavailable")), READY_HARD_CAP_MS);
  const onNavigate = (_event: unknown, url: string, httpResponseCode: number): void => {
    if (originOf(url) !== targetOrigin) return;
    // loadURL은 401 JSON 문서도 성공으로 돌려준다. 도착한 문서가 오류면 준비가 아니다.
    if (typeof httpResponseCode === "number" && httpResponseCode >= 400) {
      finish(new Error(httpResponseCode === 401 ? "remote_host_session_expired" : "remote_host_unavailable"));
      return;
    }
    arrived = true;
  };
  const onTitle = (_event: unknown, title: string): void => {
    if (arrived && title.includes(CONSOLE_READY_TITLE_MARK)) finish();
  };
  const onFinish = (): void => {
    if (!arrived || fallback !== null) return;
    fallback = setTimeout(() => finish(), SWITCH_VEIL_FALLBACK_MS);
  };
  const onGone = (): void => finish(new Error("remote_host_unavailable"));
  function cleanup(): void {
    clearTimeout(hardCap);
    if (fallback !== null) clearTimeout(fallback);
    contents.removeListener("did-navigate", onNavigate as never);
    contents.removeListener("page-title-updated", onTitle as never);
    contents.removeListener("did-finish-load", onFinish);
    contents.removeListener("render-process-gone", onGone);
  }
  contents.on("did-navigate", onNavigate as never);
  contents.on("page-title-updated", onTitle as never);
  contents.on("did-finish-load", onFinish);
  contents.on("render-process-gone", onGone);
  // 적재 실패는 loadURL이 던져 부른 쪽이 cancel한다. 대기 중인 약속은 조용히 버려진다.
  promise.catch(() => undefined);
  return { promise, cancel: () => cleanup() };
}

function originOf(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}
