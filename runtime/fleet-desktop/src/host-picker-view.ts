import type { BrowserWindow, WebContents, WebContentsView } from "electron";

/**
 * 집의 호스트 목록을 지금 보고 있는 콘솔 위에 그대로 펼치는 덮개.
 *
 * 목록은 이 셸이 띄운 콘솔(집)이 자기 루프백에서 직접 그린다. 원격 콘솔이 서빙한 화면은
 * 이 렌더러를 참조할 수도, 그 응답을 읽을 수도 없으므로 남의 기계 주소는 그 화면을 지나가지
 * 않는다 — 화면 아래에 깔린 콘솔은 픽셀로만 남는다.
 *
 * 덮개는 하나뿐이고, 걷는 일은 여러 경로에서 불린다: 고르고 났을 때, Esc, 렌더러 사망,
 * 적재 실패, 메인 창의 항해, 창 종료. 전부 같은 함수로 모여 몇 번을 불려도 같은 결과가 된다.
 */
export interface HostPickerViewDeps {
  readonly createView: () => WebContentsView;
  readonly window: () => BrowserWindow | null;
  /** 이 contents의 항해 울타리. 세션에는 손대지 않는다(window-policy 참조). */
  readonly confine: (contents: WebContents) => void;
  /** 여기서 고른 콘솔을 메인 창으로 보내는 다리. */
  readonly attachBridge: (contents: WebContents) => void;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
}

export interface HostPickerView {
  open(url: string): Promise<void>;
  close(): void;
  isOpen(): boolean;
}

/**
 * 덮개를 걷자마자 다시 소환하는 것은 사람의 손이 아니다. 아래에 깔린 화면은 남의 콘솔이므로,
 * 그 화면의 스크립트가 신뢰 UI를 반복해서 띄우는 길을 좁혀 둔다.
 */
const REOPEN_COOLDOWN_MS = 400;

interface OpenPicker {
  readonly view: WebContentsView;
  readonly onResize: () => void;
}

export function createHostPickerView(deps: HostPickerViewDeps): HostPickerView {
  const now = deps.now ?? Date.now;
  let current: OpenPicker | null = null;
  let closedAt = 0;

  function close(): void {
    const open = current;
    if (!open) return;
    // 먼저 비운다 — 아래 정리 중에 다시 불려도 두 번 걷지 않는다.
    current = null;
    closedAt = now();
    const window = deps.window();
    try { window?.off("resize", open.onResize); } catch { /* 이미 사라진 창은 뗄 리스너도 없다. */ }
    try { window?.contentView.removeChildView(open.view); } catch { /* 창이 먼저 닫힌 경우. */ }
    try { open.view.webContents.close(); } catch { /* 이미 죽은 렌더러. */ }
    // 덮개가 걷히면 손은 원래 보던 콘솔로 돌아가야 한다.
    try { if (window && !window.isDestroyed()) window.webContents.focus(); } catch { /* 창이 없으면 돌려줄 포커스도 없다. */ }
  }

  return {
    isOpen: () => current !== null,

    close,

    async open(url: string): Promise<void> {
      const window = deps.window();
      if (!window || window.isDestroyed()) throw new Error("remote_bridge_no_picker");
      if (current) {
        // 이미 떠 있으면 하나 더 만들지 않는다.
        try { current.view.webContents.focus(); } catch { /* 포커스는 부가 동작이다. */ }
        return;
      }
      if (now() - closedAt < REOPEN_COOLDOWN_MS) {
        deps.log?.("host picker reopen ignored: too soon after the last dismissal");
        return;
      }

      const view = deps.createView();
      const contents = view.webContents;
      const applyBounds = (): void => {
        const target = deps.window();
        if (!target || target.isDestroyed()) return;
        const { width, height } = target.getContentBounds();
        view.setBounds({ x: 0, y: 0, width, height });
      };
      const onResize = (): void => applyBounds();
      const open: OpenPicker = { view, onResize };
      current = open;

      window.contentView.addChildView(view);
      // 목록이 그려지기 전에는 보이지 않는다 — 빈 판을 먼저 보여 주면 목록이 사라진 것처럼 읽힌다.
      view.setVisible(false);
      applyBounds();
      window.on("resize", onResize);

      deps.confine(contents);
      deps.attachBridge(contents);
      contents.on("before-input-event", (_event, input) => {
        if (input.type === "keyDown" && input.key === "Escape") close();
      });
      // 덮개만 살아남는 상태를 만들지 않는다.
      contents.on("render-process-gone", () => close());
      contents.once("did-fail-load", (_event, _code, description) => {
        deps.log?.(`host picker load failed: ${description}`);
        close();
      });
      contents.once("did-finish-load", () => {
        if (current !== open) return;
        view.setVisible(true);
        try { contents.focus(); } catch { /* 포커스는 부가 동작이다. */ }
      });

      try {
        await contents.loadURL(url);
      } catch (error) {
        close();
        throw error;
      }
    },
  };
}
