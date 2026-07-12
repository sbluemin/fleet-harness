import { describe, expect, it, vi } from "vitest";

import { createConsoleControls } from "../src/console-controls.js";

function createWindow(zoomLevel = 0) {
  let level = zoomLevel;
  return {
    destroyed: false,
    webContents: {
      getZoomLevel: () => level,
      setZoomLevel: vi.fn((next: number) => { level = next; }),
      reload: vi.fn(),
    },
    isDestroyed(): boolean { return this.destroyed; },
  };
}

describe("console controls", () => {
  it("keeps every control gated until Console load completes and resets the gate for a recreated window", () => {
    const refreshNativeActions = vi.fn();
    const zoomState = { load: vi.fn(() => 1.5), save: vi.fn() };
    const controls = createConsoleControls({ zoomState, refreshNativeActions });
    const first = createWindow();

    controls.attachWindow(first);
    controls.zoomIn();
    controls.zoomOut();
    controls.actualSize();
    controls.reloadConsole();
    expect(first.webContents.setZoomLevel).not.toHaveBeenCalled();
    expect(first.webContents.reload).not.toHaveBeenCalled();
    expect(controls.consoleReady()).toBe(false);

    controls.handoffStarted();
    controls.zoomIn();
    controls.reloadConsole();
    expect(first.webContents.setZoomLevel).not.toHaveBeenCalled();
    expect(first.webContents.reload).not.toHaveBeenCalled();
    expect(refreshNativeActions).not.toHaveBeenCalled();

    controls.onConsoleLoaded();
    expect(first.webContents.setZoomLevel).toHaveBeenCalledWith(1.5);
    expect(refreshNativeActions).toHaveBeenCalledOnce();
    expect(controls.consoleReady()).toBe(true);
    controls.zoomIn();
    controls.reloadConsole();
    expect(first.webContents.setZoomLevel).toHaveBeenLastCalledWith(2);
    expect(first.webContents.reload).toHaveBeenCalledOnce();

    first.destroyed = true;
    controls.zoomOut();
    controls.reloadConsole();
    expect(controls.consoleReady()).toBe(false);
    const second = createWindow();
    controls.attachWindow(second);
    controls.zoomIn();
    controls.reloadConsole();
    expect(second.webContents.setZoomLevel).not.toHaveBeenCalled();
    expect(second.webContents.reload).not.toHaveBeenCalled();
  });

  it("applies and persists the requested wheel zoom direction with clamping", () => {
    // zoom-changed는 상태 통지가 아니라 요청 이벤트다 — coordinator가 방향대로 직접 적용해야 휠 줌이 동작한다.
    let stored = 1;
    const zoomState = { load: vi.fn(() => stored), save: vi.fn((level: number) => { stored = level; }) };
    const controls = createConsoleControls({ zoomState, refreshNativeActions: vi.fn() });
    const first = createWindow();

    controls.attachWindow(first);
    controls.zoomChanged(first.webContents, "in");
    expect(first.webContents.setZoomLevel).not.toHaveBeenCalled();

    controls.handoffStarted();
    controls.onConsoleLoaded();
    first.webContents.setZoomLevel.mockClear();

    controls.zoomChanged(first.webContents, "in");
    expect(first.webContents.setZoomLevel).toHaveBeenLastCalledWith(1.5);
    expect(zoomState.save).toHaveBeenLastCalledWith(1.5);
    controls.zoomChanged(first.webContents, "out");
    expect(first.webContents.setZoomLevel).toHaveBeenLastCalledWith(1);
    expect(zoomState.save).toHaveBeenLastCalledWith(1);

    for (let step = 0; step < 5; step++) controls.zoomChanged(first.webContents, "in");
    expect(first.webContents.setZoomLevel).toHaveBeenLastCalledWith(3);
    expect(zoomState.save).toHaveBeenLastCalledWith(3);

    const second = createWindow();
    controls.attachWindow(second);
    controls.zoomChanged(first.webContents, "in");
    expect(second.webContents.setZoomLevel).not.toHaveBeenCalled();
    controls.handoffStarted();
    controls.onConsoleLoaded();
    expect(second.webContents.setZoomLevel).toHaveBeenCalledWith(3);
  });
});
