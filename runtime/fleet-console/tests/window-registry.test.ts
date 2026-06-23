import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSnapshot, loadForTheater, minimizePanel, restorePanel, setPanelGeometry, type PanelGeometry } from "../client/src/canvas/canvas-store.js";
import { addShellPanel, clearShellPanels, getActiveShellId, getMinimizedShellPanelIds, loadShellPanelsForTheater, minimizeShellPanel, restoreShellPanel } from "../client/src/canvas/shell-panels.js";
import { activateWindowPanel, clearMaximizedPanelId, focusWindowPanel, getMaximizedPanelId, getMinimizedPanelHandles, getPanelHandles, maximizeWindowPanel, minimizeWindowPanel, nextPanelHandle, operationPanelHandle, pruneDanglingMaximizedPanelId, setMaximizedPanelId } from "../client/src/canvas/window-registry.js";

const GEOMETRY: PanelGeometry = { x: 0, y: 0, width: 100, height: 100, zIndex: 0 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", {
    clearTimeout,
    localStorage: createStorage(),
    sessionStorage: createStorage(),
    setTimeout,
  });
  window.localStorage.clear();
  window.sessionStorage.clear();
  loadForTheater("theater-a");
  loadShellPanelsForTheater("theater-a");
  clearMaximizedPanelId();
});

afterEach(() => {
  clearShellPanels();
  loadForTheater(null);
  loadShellPanelsForTheater(null);
  clearMaximizedPanelId();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("window registry facade", () => {
  it("orders Operation and Shell handles by stable createdAt", () => {
    setPanelGeometry("op-a", { ...GEOMETRY });
    const shell = addShellPanel("theater-a", { ...GEOMETRY });
    setPanelGeometry("op-b", { ...GEOMETRY });

    expect(getPanelHandles(["op-a", "op-b"]).map((handle) => `${handle.kind}:${handle.id}`)).toEqual([
      "operation:op-a",
      `shell:${shell}`,
      "operation:op-b",
    ]);
  });

  it("does not reorder handles when focus changes z-index", () => {
    setPanelGeometry("op-a", { ...GEOMETRY });
    const shell = addShellPanel("theater-a", { ...GEOMETRY });
    setPanelGeometry("op-b", { ...GEOMETRY });
    const before = getPanelHandles(["op-a", "op-b"]).map((handle) => handle.id);

    setPanelGeometry("op-a", { ...GEOMETRY });
    restoreShellPanel(shell);

    expect(getPanelHandles(["op-a", "op-b"]).map((handle) => handle.id)).toEqual(before);
  });

  it("synthesizes minimized Operation and Shell handles without mixing persistence", () => {
    setPanelGeometry("op-a", { ...GEOMETRY });
    const shell = addShellPanel("theater-a", { ...GEOMETRY });
    minimizePanel("op-a");
    minimizeShellPanel(shell);

    expect(getMinimizedPanelHandles(["op-a"]).map((handle) => handle.id)).toEqual(["op-a", shell]);
    expect(getSnapshot().minimized).toEqual(["op-a"]);
    expect(getMinimizedShellPanelIds()).toEqual([shell]);
    expect(window.localStorage.getItem("fleet-console.canvas.shell.theater-a")).toBeNull();
  });

  it("sets and clears maximizedPanelId", () => {
    setMaximizedPanelId("op-a");
    expect(getMaximizedPanelId()).toBe("op-a");
    clearMaximizedPanelId();
    expect(getMaximizedPanelId()).toBeNull();
  });

  it("maximizeWindowPanel minimizes the others, restores the target, and replaces the previous maximize", () => {
    setPanelGeometry("op-a", { ...GEOMETRY });
    setPanelGeometry("op-b", { ...GEOMETRY });
    const handles = getPanelHandles(["op-a", "op-b"]);

    maximizeWindowPanel(operationPanelHandle("op-a"), handles);
    expect(getMaximizedPanelId()).toBe("op-a");
    expect(getSnapshot().minimized).toEqual(["op-b"]);

    // 전환: op-b를 최대화하면 이전 최대화 op-a는 Dock으로 내려가고 op-b는 복원된다(유령 칩 없음).
    maximizeWindowPanel(operationPanelHandle("op-b"), handles);
    expect(getMaximizedPanelId()).toBe("op-b");
    expect(getSnapshot().minimized).toEqual(["op-a"]);
  });

  it("clears maximizedPanelId when the maximized panel is minimized", () => {
    setPanelGeometry("op-a", { ...GEOMETRY });
    setMaximizedPanelId("op-a");
    minimizeWindowPanel({ kind: "operation", id: "op-a", createdAt: 0 });
    expect(getMaximizedPanelId()).toBeNull();
    expect(getSnapshot().minimized).toEqual(["op-a"]);
  });

  it("defers dangling maximizedPanelId prune until all hydration readiness flags are true", () => {
    setMaximizedPanelId("missing");
    expect(pruneDanglingMaximizedPanelId([], {
      operationSessionsHydrated: false,
      shellPanelsHydrated: true,
      theaterReady: true,
    })).toBe(false);
    expect(getMaximizedPanelId()).toBe("missing");

    expect(pruneDanglingMaximizedPanelId([], {
      operationSessionsHydrated: true,
      shellPanelsHydrated: true,
      theaterReady: true,
    })).toBe(true);
    expect(getMaximizedPanelId()).toBeNull();
  });

  it("activateWindowPanel restores and focuses a minimized panel when nothing is maximized", () => {
    setPanelGeometry("op-a", { ...GEOMETRY });
    setPanelGeometry("op-b", { ...GEOMETRY });
    minimizePanel("op-a");
    const handles = getPanelHandles(["op-a", "op-b"]);

    // 비최대화 Dock 칩 클릭: 최소화 복원 + 카메라 이동(전면 활성화).
    activateWindowPanel(operationPanelHandle("op-a"), handles, { width: 1000, height: 800 });

    expect(getMaximizedPanelId()).toBeNull();
    expect(getSnapshot().minimized).toEqual([]);
  });

  it("activateWindowPanel keeps maximized mode and swaps the target when a panel is maximized", () => {
    setPanelGeometry("op-a", { ...GEOMETRY });
    setPanelGeometry("op-b", { ...GEOMETRY });
    minimizePanel("op-a");
    const handles = getPanelHandles(["op-a", "op-b"]);
    setMaximizedPanelId("op-b");

    // 최대화 모드에서 최소화된 op-a 칩 클릭 → op-a가 최대화로 전환되고 op-b는 Dock으로 내려간다(최대화 모드 유지).
    activateWindowPanel(operationPanelHandle("op-a"), handles, { width: 1000, height: 800 });

    expect(getMaximizedPanelId()).toBe("op-a");
    expect(getSnapshot().minimized).toEqual(["op-b"]);
  });

  it("focuses Shell panels through Shell geometry and center zoom", () => {
    const shell = addShellPanel("theater-a", { x: 300, y: 200, width: 400, height: 200, zIndex: 1 });
    focusWindowPanel({ kind: "shell", id: shell, createdAt: 1 }, { width: 1000, height: 800 });

    expect(getActiveShellId()).toBe(shell);
    expect(getSnapshot().viewport.zoom).toBe(1);
    expect(getSnapshot().viewport.x).toBe(0);
    expect(getSnapshot().viewport.y).toBe(100);
  });

  it("minimize state does not alter stable handle order", () => {
    setPanelGeometry("op-a", { ...GEOMETRY });
    const shell = addShellPanel("theater-a", { ...GEOMETRY });
    const before = getPanelHandles(["op-a"]).map((handle) => handle.id);
    minimizeWindowPanel({ kind: "shell", id: shell, createdAt: 0 });
    minimizeWindowPanel({ kind: "operation", id: "op-a", createdAt: 0 });

    expect(getPanelHandles(["op-a"]).map((handle) => handle.id)).toEqual(before);
  });

  it("cycles Operation and Shell handles in stable order", () => {
    setPanelGeometry("op-a", { ...GEOMETRY });
    const shell = addShellPanel("theater-a", { ...GEOMETRY });
    setPanelGeometry("op-b", { ...GEOMETRY });
    const handles = getPanelHandles(["op-a", "op-b"]);

    expect(nextPanelHandle(handles, "op-a", 1)?.id).toBe(shell);
    expect(nextPanelHandle(handles, shell, 1)?.id).toBe("op-b");
    expect(nextPanelHandle(handles, "op-a", -1)?.id).toBe("op-b");
  });

  it("starts Alt cycling from the edge when no handle matches the current id", () => {
    setPanelGeometry("op-a", { ...GEOMETRY });
    setPanelGeometry("op-b", { ...GEOMETRY });
    const handles = getPanelHandles(["op-a", "op-b"]);

    // currentId 없음/stale → 정방향은 첫 핸들, 역방향은 마지막 핸들에서 시작(Math.max(0,-1) 회귀 방지).
    expect(nextPanelHandle(handles, null, 1)?.id).toBe("op-a");
    expect(nextPanelHandle(handles, null, -1)?.id).toBe("op-b");
    expect(nextPanelHandle(handles, "missing", 1)?.id).toBe("op-a");
  });

  it("maximized cycling changes maximizedPanelId without viewport movement", () => {
    setPanelGeometry("op-a", { ...GEOMETRY });
    const shell = addShellPanel("theater-a", { ...GEOMETRY });
    const handles = getPanelHandles(["op-a"]);
    setMaximizedPanelId("op-a");
    const before = getSnapshot().viewport;
    const next = nextPanelHandle(handles, getMaximizedPanelId(), 1);
    if (next) setMaximizedPanelId(next.id);

    expect(getMaximizedPanelId()).toBe(shell);
    expect(getSnapshot().viewport).toEqual(before);
  });
});

function createStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => Array.from(entries.keys())[index] ?? null,
    removeItem: (key) => entries.delete(key),
    setItem: (key, value) => { entries.set(key, value); },
  };
}
