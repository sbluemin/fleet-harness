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
  onConsoleLoaded(): void;
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
  };
}

function setAndSaveZoom(contents: ConsoleControlsWebContents, nextLevel: number, zoomState: ZoomState): void {
  const level = clampZoomLevel(nextLevel);
  contents.setZoomLevel(level);
  zoomState.save(level);
}
