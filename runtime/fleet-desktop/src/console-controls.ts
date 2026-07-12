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
  readonly schedule?: (callback: () => void) => void;
}

export interface ConsoleControls {
  attachWindow(window: ConsoleControlsWindow): void;
  handoffStarted(): void;
  onConsoleLoaded(): void;
  zoomChanged(contents: ConsoleControlsWebContents): void;
  zoomIn(): void;
  zoomOut(): void;
  actualSize(): void;
  reloadConsole(): void;
  consoleReady(): boolean;
}

export function createConsoleControls(dependencies: ConsoleControlsDependencies): ConsoleControls {
  // 휠 줌은 zoom-changed 발화 시점에 아직 적용 전일 수 있어 매크로태스크로 지연 판독한다.
  const schedule = dependencies.schedule ?? ((callback: () => void) => { setImmediate(callback); });
  let window: ConsoleControlsWindow | null = null;
  let handoffPending = false;
  let handoffComplete = false;
  let zoomSavePending = false;
  let scheduledContents: ConsoleControlsWebContents | null = null;

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
      zoomSavePending = false;
      scheduledContents = null;
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
    zoomChanged(contents): void {
      if (!handoffComplete || activeContents() !== contents || zoomSavePending) return;
      zoomSavePending = true;
      scheduledContents = contents;
      schedule(() => {
        if (scheduledContents !== contents) return;
        zoomSavePending = false;
        scheduledContents = null;
        if (!handoffComplete || activeContents() !== contents) return;
        const current = contents.getZoomLevel();
        const clamped = clampZoomLevel(current);
        if (clamped !== current) contents.setZoomLevel(clamped);
        dependencies.zoomState.save(clamped);
      });
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
