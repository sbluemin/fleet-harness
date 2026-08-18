import { describe, expect, it, vi } from "vitest";

import { createTitleBarOverlayRefresher, OVERLAY_REFRESH_DELAY_MS, zoomedOverlayHeight, type DesktopTitleBarOverlay, type OverlayRefreshScreen, type OverlayRefreshWindow } from "../src/title-bar-overlay-refresh.js";

const INITIAL: DesktopTitleBarOverlay = { color: "#03080e", symbolColor: "#989fa6", height: 43 };

interface Harness {
  readonly setTitleBarOverlay: ReturnType<typeof vi.fn>;
  readonly refresher: ReturnType<typeof createTitleBarOverlayRefresher>;
  setScaleFactor(scaleFactor: number): void;
  setZoomFactor(zoomFactor: number): void;
  destroyWindow(): void;
  fireMoved(): void;
  fireDisplayMetricsChanged(changedMetrics: string[]): void;
  runPending(): void;
  pendingCount(): number;
  readonly windowListeners: Map<string, () => void>;
  readonly screenListeners: Map<string, Parameters<OverlayRefreshScreen["on"]>[1]>;
}

function createHarness(scaleFactorInitial = 1.5): Harness {
  let scaleFactor = scaleFactorInitial;
  let zoomFactor = 1;
  let destroyed = false;
  const windowListeners = new Map<string, () => void>();
  const screenListeners = new Map<string, Parameters<OverlayRefreshScreen["on"]>[1]>();
  const scheduled: { callback: () => void; delay: number; cancelled: boolean }[] = [];
  const setTitleBarOverlay = vi.fn();

  const window: OverlayRefreshWindow = {
    isDestroyed: () => destroyed,
    getBounds: () => ({ x: 0, y: 0, width: 900, height: 560 }),
    setTitleBarOverlay,
    on(event, listener) { windowListeners.set(event, listener); return window; },
    removeListener(event, listener) {
      if (windowListeners.get(event) === listener) windowListeners.delete(event);
      return window;
    },
  };
  const display = (factor: number) => ({ scaleFactor: factor } as ReturnType<OverlayRefreshScreen["getDisplayMatching"]>);
  const screen: OverlayRefreshScreen = {
    getDisplayMatching: () => display(scaleFactor),
    on(event, listener) { screenListeners.set(event, listener); return screen; },
    removeListener(event, listener) {
      if (screenListeners.get(event) === listener) screenListeners.delete(event);
      return screen;
    },
  };
  const refresher = createTitleBarOverlayRefresher(window, {
    screen,
    initialOverlay: INITIAL,
    getZoomFactor: () => zoomFactor,
    setTimeout: (callback, delay) => {
      const entry = { callback, delay, cancelled: false };
      scheduled.push(entry);
      return scheduled.length as never;
    },
    clearTimeout: (timer) => {
      const entry = scheduled[(timer as unknown as number) - 1];
      if (entry) entry.cancelled = true;
    },
  });

  return {
    setTitleBarOverlay,
    refresher,
    setScaleFactor: (next) => { scaleFactor = next; },
    setZoomFactor: (next) => { zoomFactor = next; },
    destroyWindow: () => { destroyed = true; },
    fireMoved: () => windowListeners.get("moved")?.(),
    fireDisplayMetricsChanged: (changedMetrics) => screenListeners.get("display-metrics-changed")?.({}, display(scaleFactor), changedMetrics),
    runPending: () => {
      for (const entry of scheduled.splice(0)) {
        if (entry.cancelled) continue;
        expect(entry.delay).toBe(OVERLAY_REFRESH_DELAY_MS);
        entry.callback();
      }
    },
    pendingCount: () => scheduled.filter((entry) => !entry.cancelled).length,
    windowListeners,
    screenListeners,
  };
}

describe("zoomedOverlayHeight", () => {
  it("follows the page zoom because the CSS band grows with zoom while the native overlay does not", () => {
    expect(zoomedOverlayHeight(43, 1)).toBe(43);
    expect(zoomedOverlayHeight(43, 1.25)).toBe(54);
    expect(zoomedOverlayHeight(43, 5 / 6)).toBe(36);
    expect(zoomedOverlayHeight(43, 0.5)).toBe(22);
  });

  it("passes the height through on unusable zoom factors and never returns less than one", () => {
    expect(zoomedOverlayHeight(43, 0)).toBe(43);
    expect(zoomedOverlayHeight(43, Number.NaN)).toBe(43);
    expect(zoomedOverlayHeight(1, 0.1)).toBe(1);
  });
});

describe("title bar overlay refresher", () => {
  it("applies the overlay immediately on creation so a window born off the primary display gets a current-scale layout", () => {
    const harness = createHarness(1);

    expect(harness.setTitleBarOverlay).toHaveBeenCalledExactlyOnceWith({ ...INITIAL });
  });

  it("applies theme snapshots through applyOverlay with the zoomed height", () => {
    const harness = createHarness(1);
    harness.setZoomFactor(5 / 6);
    harness.setTitleBarOverlay.mockClear();

    harness.refresher.applyOverlay({ color: "#101215", symbolColor: "#bfc1c3", height: 43 });

    expect(harness.setTitleBarOverlay).toHaveBeenCalledExactlyOnceWith({ color: "#101215", symbolColor: "#bfc1c3", height: 36 });
  });

  it("reapplies the same height after the window lands on a display with a different scale factor, because the stale layout must be redone at the current scale", () => {
    const harness = createHarness(1.5);
    harness.setTitleBarOverlay.mockClear();

    harness.setScaleFactor(1);
    harness.fireMoved();
    expect(harness.setTitleBarOverlay).not.toHaveBeenCalled();
    harness.runPending();

    expect(harness.setTitleBarOverlay).toHaveBeenCalledExactlyOnceWith({ ...INITIAL });
  });

  it("does not schedule anything for moves within the same display scale", () => {
    const harness = createHarness(1.5);
    harness.setTitleBarOverlay.mockClear();

    harness.fireMoved();

    expect(harness.pendingCount()).toBe(0);
    harness.runPending();
    expect(harness.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it("coalesces a burst of moved events into a single delayed reapply", () => {
    const harness = createHarness(1.5);
    harness.setTitleBarOverlay.mockClear();

    harness.setScaleFactor(1);
    harness.fireMoved();
    harness.fireMoved();
    harness.fireMoved();
    expect(harness.pendingCount()).toBe(1);
    harness.runPending();

    expect(harness.setTitleBarOverlay).toHaveBeenCalledOnce();
  });

  it("reapplies when the current display's scale factor changes in place", () => {
    const harness = createHarness(1.5);
    harness.setTitleBarOverlay.mockClear();

    harness.setScaleFactor(1.25);
    harness.fireDisplayMetricsChanged(["scaleFactor"]);
    harness.runPending();

    expect(harness.setTitleBarOverlay).toHaveBeenCalledExactlyOnceWith({ ...INITIAL });
  });

  it("ignores display metric changes that do not touch the scale factor", () => {
    const harness = createHarness(1.5);
    harness.setTitleBarOverlay.mockClear();

    harness.setScaleFactor(1);
    harness.fireDisplayMetricsChanged(["workArea", "bounds"]);

    expect(harness.pendingCount()).toBe(0);
    expect(harness.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it("reapplies with the new zoomed height after a zoom change is signalled through refresh", () => {
    const harness = createHarness(1.5);
    harness.setTitleBarOverlay.mockClear();

    harness.setZoomFactor(1.25);
    harness.refresher.refresh();
    harness.runPending();

    expect(harness.setTitleBarOverlay).toHaveBeenCalledExactlyOnceWith({ ...INITIAL, height: 54 });
  });

  it("treats refresh as a no-op while the applied height and display scale are unchanged", () => {
    const harness = createHarness(1.5);
    harness.setTitleBarOverlay.mockClear();

    harness.refresher.refresh();

    expect(harness.pendingCount()).toBe(0);
    expect(harness.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it("skips the reapply when the display scale returns to the applied value before the delay elapses", () => {
    const harness = createHarness(1.5);
    harness.setTitleBarOverlay.mockClear();

    harness.setScaleFactor(1);
    harness.fireMoved();
    harness.setScaleFactor(1.5);
    harness.runPending();

    expect(harness.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it("does not reapply on a destroyed window", () => {
    const harness = createHarness(1.5);
    harness.setTitleBarOverlay.mockClear();

    harness.setScaleFactor(1);
    harness.fireMoved();
    harness.destroyWindow();
    harness.runPending();

    expect(harness.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it("stop removes both listeners and cancels the pending reapply", () => {
    const harness = createHarness(1.5);
    harness.setTitleBarOverlay.mockClear();

    harness.setScaleFactor(1);
    harness.fireMoved();
    expect(harness.pendingCount()).toBe(1);
    harness.refresher.stop();

    expect(harness.pendingCount()).toBe(0);
    expect(harness.windowListeners.size).toBe(0);
    expect(harness.screenListeners.size).toBe(0);
    harness.runPending();
    expect(harness.setTitleBarOverlay).not.toHaveBeenCalled();
  });
});
