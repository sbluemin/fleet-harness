import { clampZoomLevel, type ZoomState } from "./zoom-state.js";

export interface ConsoleControlsWebContents {
  getZoomLevel(): number;
  setZoomLevel(level: number): void;
  reload(): void;
}

export interface ConsoleControlsWindow {
  isDestroyed(): boolean;
  readonly webContents: ConsoleControlsWebContents;
}

export interface ConsoleControlsDependencies {
  readonly zoomState: ZoomState;
  readonly refreshNativeActions: () => void;
}

export interface ConsoleControls {
  attachWindow(window: ConsoleControlsWindow): void;
  handoffStarted(): void;
  onConsoleCommitted(contents: ConsoleControlsWebContents): void;
  onConsoleLoaded(): void;
  /** 넘겨주기 중이면 곧 적용될 저장 줌 레벨, 아니면 null — 그때는 창의 현재 줌이 곧 Console 줌이다. */
  pendingZoomLevel(): number | null;
  zoomChanged(contents: ConsoleControlsWebContents, zoomDirection: "in" | "out"): void;
  zoomIn(): void;
  zoomOut(): void;
  actualSize(): void;
  reloadConsole(): void;
  consoleReady(): boolean;
}

export function createConsoleControls(dependencies: ConsoleControlsDependencies): ConsoleControls {
  let window: ConsoleControlsWindow | null = null;
  let handoffPending = false;
  let handoffComplete = false;

  const activeContents = (): ConsoleControlsWebContents | null => window && !window.isDestroyed() ? window.webContents : null;
  const runWhenReady = (action: (contents: ConsoleControlsWebContents) => void): void => {
    const contents = handoffComplete ? activeContents() : null;
    if (contents) action(contents);
  };

  return {
    attachWindow(nextWindow): void {
      window = nextWindow;
      handoffPending = false;
      handoffComplete = false;
    },
    handoffStarted(): void {
      if (activeContents()) handoffPending = true;
    },
    onConsoleCommitted(contents): void {
      // 넘겨주기 적재가 커밋된 자리 — 진입 배율(대개 1)로 첫 프레임을 그리기 전에 저장 줌을 건다.
      // 넘겨주기 완료(zoom-changed·메뉴 줌을 받기 시작하는 시점)는 여전히 onConsoleLoaded가 정한다.
      if (!handoffPending || activeContents() !== contents) return;
      contents.setZoomLevel(dependencies.zoomState.load());
    },
    onConsoleLoaded(): void {
      const contents = handoffPending ? activeContents() : null;
      if (!contents) return;
      handoffPending = false;
      handoffComplete = true;
      contents.setZoomLevel(dependencies.zoomState.load());
      dependencies.refreshNativeActions();
    },
    zoomChanged(contents, zoomDirection): void {
      // zoom-changed는 상태 통지가 아니라 사용자 요청이다 — Chromium이 줌을 적용해 주지 않으므로 방향대로 직접 적용·저장한다.
      if (!handoffComplete || activeContents() !== contents) return;
      setAndSaveZoom(contents, contents.getZoomLevel() + (zoomDirection === "in" ? 0.5 : -0.5), dependencies.zoomState);
    },
    zoomIn: () => runWhenReady((contents) => setAndSaveZoom(contents, contents.getZoomLevel() + 0.5, dependencies.zoomState)),
    zoomOut: () => runWhenReady((contents) => setAndSaveZoom(contents, contents.getZoomLevel() - 0.5, dependencies.zoomState)),
    actualSize: () => runWhenReady((contents) => setAndSaveZoom(contents, 0, dependencies.zoomState)),
    reloadConsole: () => runWhenReady((contents) => contents.reload()),
    consoleReady: () => handoffComplete && activeContents() !== null,
    pendingZoomLevel: () => handoffPending && activeContents() ? dependencies.zoomState.load() : null,
  };
}

function setAndSaveZoom(contents: ConsoleControlsWebContents, nextLevel: number, zoomState: ZoomState): void {
  const level = clampZoomLevel(nextLevel);
  contents.setZoomLevel(level);
  zoomState.save(level);
}
