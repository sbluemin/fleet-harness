// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OperationsCanvas } from "../core/client/src/canvas/canvas.js";
import { CanvasMinimap } from "../core/client/src/canvas/canvas-minimap.js";
import { clearCompanionOperationId, clearFormationView, clearMaximizedOperationId, consumePendingFitAllOperations, fitAllOperations, getCompanionOperationId, getFormationView, getMaximizedOperationId, getSnapshot, loadForTheater, minimizeOperation, OPERATION_WINDOW_CAPTION_HEIGHT, requestFitAllOperations, resetCanvasViewportSize, setCanvasViewportSize, setMaximizedOperationId, setState, toggleFormationView } from "../core/client/src/canvas/canvas-store.js";
import type { ConsoleState, OperationNode } from "../core/client/src/types.js";

vi.mock("../core/client/src/plugin-registry.js", () => ({ useExpandedSurfaceDescriptors: () => new Map(),
  usePluginRegistry: () => ({
    plugins: [],
    operationKinds: [{
      pluginId: "test-plugin",
      type: "shell",
      title: "Test",
      render: ({ operationId, companionsOpen, keyboardFocusRequestId, onRequestCompanions }: { readonly operationId: string; readonly companionsOpen?: boolean; readonly keyboardFocusRequestId?: number; readonly onRequestCompanions?: (open: boolean) => void }) => createElement("button", { "data-plugin-operation": operationId, "data-companions-open": String(companionsOpen), "data-keyboard-focus-request": keyboardFocusRequestId, onClick: () => onRequestCompanions?.(!companionsOpen) }, "Toggle companions"),
      companions: [
        { id: "chat", title: "Chat", render: ({ companionsOpen, keyboardFocusRequestId }: { readonly companionsOpen?: boolean; readonly keyboardFocusRequestId?: number }) => createElement("div", { "data-test-companion": "chat", "data-companions-open": String(companionsOpen), "data-keyboard-focus-request": keyboardFocusRequestId }) },
        { id: "artifacts", title: "Artifacts", hideCaption: true, render: ({ companionsOpen, keyboardFocusRequestId }: { readonly companionsOpen?: boolean; readonly keyboardFocusRequestId?: number }) => createElement("div", { "data-test-companion": "artifacts", "data-companions-open": String(companionsOpen), "data-keyboard-focus-request": keyboardFocusRequestId }) },
      ],
    }],
    failures: [],
    settingsSections: [],
    notificationKinds: [],
    railPanels: [],
  }),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let resizeObserverDescriptor: PropertyDescriptor | undefined;
let setPointerCaptureDescriptor: PropertyDescriptor | undefined;
let releasePointerCaptureDescriptor: PropertyDescriptor | undefined;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  resizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  setPointerCaptureDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "setPointerCapture");
  releasePointerCaptureDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "releasePointerCapture");
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      constructor(private readonly callback: ResizeObserverCallback) {}

      observe(target: Element) {
        Object.defineProperties(target, {
          clientWidth: { configurable: true, value: 900 },
          clientHeight: { configurable: true, value: 600 },
        });
        this.callback([], this as unknown as ResizeObserver);
      }

      disconnect() {}
      unobserve() {}
    },
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: () => {} });
  loadForTheater("minimap-boundary");
  clearFormationView();
  clearCompanionOperationId();
  clearMaximizedOperationId();
  setState({
    viewport: { x: 0, y: 0, zoom: 1 },
    operations: {
      operation: { x: 0, y: 0, width: 320, height: 200, zIndex: 1 },
      peer: { x: 360, y: 40, width: 320, height: 200, zIndex: 2 },
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  clearFormationView();
  clearCompanionOperationId();
  clearMaximizedOperationId();
  loadForTheater(null);
  window.localStorage.clear();
  restoreProperty(globalThis, "ResizeObserver", resizeObserverDescriptor);
  restoreProperty(HTMLElement.prototype, "setPointerCapture", setPointerCaptureDescriptor);
  restoreProperty(HTMLElement.prototype, "releasePointerCapture", releasePointerCaptureDescriptor);
  container?.remove();
  root = null;
  container = null;
});

describe("CanvasMinimap collapse behavior", () => {
  it("resets canvas size and clears a pending fit when OperationsCanvas unmounts", () => {
    renderOperationsCanvas();
    setCanvasViewportSize({ width: 0, height: 0 });
    requestFitAllOperations();
    act(() => root!.render(null));
    const viewport = { x: 12, y: 34, zoom: 0.75 };
    setState({ viewport });

    fitAllOperations();
    setCanvasViewportSize({ width: 900, height: 600 });
    consumePendingFitAllOperations();

    expect(getSnapshot().viewport).toEqual(viewport);
    resetCanvasViewportSize();
  });

  it("persists default-canvas collapse and expand preference", () => {
    act(() => root!.render(createElement(CanvasMinimap, {
      operations: { operation: { x: 0, y: 0, width: 320, height: 200, zIndex: 1 } },
      pluginOperations: {},
      viewport: { x: 0, y: 0, zoom: 1 },
      canvasSize: { width: 900, height: 600 },
      onJump: () => {},
    })));
    expect(document.querySelector(".canvas-minimap")).not.toBeNull();
    expect(document.querySelector('[aria-label="Collapse Map"]')).not.toBeNull();

    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Collapse Map"]')!.click());
    expect(document.querySelector('[aria-label="Open Map"]')).not.toBeNull();
    expect(window.localStorage.getItem("fleet-console.map.radarCollapsed")).toBe("true");

    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Open Map"]')!.click());
    expect(document.querySelector('[aria-label="Collapse Map"]')).not.toBeNull();
    expect(window.localStorage.getItem("fleet-console.map.radarCollapsed")).toBe("false");
  });

  it("does not mutate the saved preference in Formation and restores the pre-entry state", () => {
    act(() => root!.render(createElement(CanvasMinimap, {
      operations: { operation: { x: 0, y: 0, width: 320, height: 200, zIndex: 1 } },
      pluginOperations: {},
      viewport: { x: 0, y: 0, zoom: 1 },
      canvasSize: { width: 900, height: 600 },
      onJump: () => {},
    })));
    expect(document.querySelector('[aria-label="Collapse Map"]')).not.toBeNull();

    act(() => toggleFormationView());
    expect(document.querySelector('[aria-label="Open Map"]')).not.toBeNull();
    expect(window.localStorage.getItem("fleet-console.map.radarCollapsed")).toBeNull();

    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Open Map"]')!.click());
    expect(document.querySelector('[aria-label="Collapse Map"]')).not.toBeNull();
    expect(window.localStorage.getItem("fleet-console.map.radarCollapsed")).toBeNull();

    act(() => clearFormationView());
    expect(document.querySelector('[aria-label="Collapse Map"]')).not.toBeNull();
    expect(window.localStorage.getItem("fleet-console.map.radarCollapsed")).toBeNull();
  });

  it("preserves the no-operations and invalid-viewport guards", () => {
    act(() => root!.render(createElement(CanvasMinimap, {
      operations: {},
      pluginOperations: {},
      viewport: { x: 0, y: 0, zoom: 1 },
      canvasSize: { width: 900, height: 600 },
      onJump: () => {},
    })));
    expect(document.querySelector(".canvas-minimap")).toBeNull();

    act(() => root!.render(createElement(CanvasMinimap, {
      operations: { operation: { x: 0, y: 0, width: 320, height: 200, zIndex: 1 } },
      pluginOperations: {},
      viewport: { x: 0, y: 0, zoom: 0 },
      canvasSize: { width: 900, height: 600 },
      onJump: () => {},
    })));
    expect(document.querySelector(".canvas-minimap")).toBeNull();
  });

  it("keeps the minimap mounted through Formation and maximize so the collapsed preference restores", () => {
    window.localStorage.setItem("fleet-console.map.radarCollapsed", "true");
    renderOperationsCanvas();
    expect(document.querySelector('[aria-label="Open Map"]')).not.toBeNull();

    act(() => toggleFormationView());
    expect(document.querySelector(".operations-canvas")?.classList.contains("is-formation-view")).toBe(true);
    expect(document.querySelector('[aria-label="Open Map"]')).not.toBeNull();

    act(() => clearFormationView());
    expect(document.querySelector('[aria-label="Open Map"]')).not.toBeNull();

    act(() => setMaximizedOperationId("operation"));
    expect(document.querySelector(".operations-canvas")?.classList.contains("is-panel-maximized")).toBe(true);
    expect(document.querySelector('[aria-label="Open Map"]')).not.toBeNull();

    act(() => clearMaximizedOperationId());
    expect(document.querySelector('[aria-label="Open Map"]')).not.toBeNull();
  });

  it("renders shared mode chrome, numbered slots, an incomplete-row guide, and shows the curtain on every entry", () => {
    vi.useFakeTimers();
    try {
      const theaterId = "formation-chrome";
      const operations = [0, 1, 2].map((index) => ({
        ...OPERATION,
        id: `formation-${index + 1}`,
        theaterId,
        title: `Formation ${index + 1}`,
        ts: { createdAt: index, updatedAt: index },
      }));
      loadForTheater(theaterId);
      setState({
        operations: Object.fromEntries(operations.map((operation, index) => [
          operation.id,
          { x: index * 40, y: index * 40, width: 320, height: 200, zIndex: index + 1 },
        ])),
      });
      renderOperationsCanvas({
        ...CANVAS_STATE,
        activeTheaterId: theaterId,
        operations,
        operationRuntime: {
          "formation-1": { lifecycle: "live", activity: "awaiting" },
          "formation-2": { lifecycle: "live", activity: "running" },
          "formation-3": { lifecycle: "live", activity: "idle" },
        },
      });

      act(() => toggleFormationView());
      expect(document.querySelector(".operations-canvas")?.classList.contains("is-formation-entering")).toBe(true);
      expect(document.querySelector(".canvas-mode-frame")).not.toBeNull();
      expect(document.querySelectorAll(".canvas-mode-bracket")).toHaveLength(4);
      expect(document.querySelector(".canvas-mode-hud")).toBeNull();
      // 캡션은 순번을 싣지 않는다 — 빈 자리를 가리키는 가이드만 번호를 유지한다.
      expect(document.querySelector(".canvas-operation-formation-slot")).toBeNull();
      expect(document.querySelector(".canvas-formation-guide-index")?.textContent).toBe("04");
      const occupied = document.querySelector<HTMLElement>('[data-operation-id="formation-3"]');
      const guide = document.querySelector<HTMLElement>(".canvas-formation-guide");
      expect(occupied).not.toBeNull();
      expect(guide).not.toBeNull();
      expect(Number.parseFloat(guide!.style.height)).toBe(Number.parseFloat(occupied!.style.height) + OPERATION_WINDOW_CAPTION_HEIGHT);
      expect(Number.parseFloat(guide!.style.top)).toBe(Number.parseFloat(occupied!.style.top) - OPERATION_WINDOW_CAPTION_HEIGHT);
      expect(Number.parseFloat(guide!.style.width)).toBe(Number.parseFloat(occupied!.style.width));
      expect(document.querySelector(".canvas-formation-curtain")).not.toBeNull();

      act(() => vi.advanceTimersByTime(1_950));
      expect(document.querySelector(".operations-canvas")?.classList.contains("is-formation-entering")).toBe(false);
      expect(document.querySelector(".canvas-formation-curtain")).toBeNull();

      act(() => clearFormationView());
      act(() => toggleFormationView());
      expect(document.querySelector(".operations-canvas")?.classList.contains("is-formation-entering")).toBe(true);
      expect(document.querySelector(".canvas-formation-curtain")).not.toBeNull();
      act(() => vi.advanceTimersByTime(1_950));
      expect(document.querySelector(".operations-canvas")?.classList.contains("is-formation-entering")).toBe(false);
      expect(document.querySelector(".canvas-formation-curtain")).toBeNull();
    } finally {
      act(() => clearFormationView());
      vi.useRealTimers();
    }
  });

  it("names the mode the curtain is switching to and repeats it when Tactical returns to Cruise", () => {
    vi.useFakeTimers();
    try {
      const theaterId = "cruise-curtain";
      const operations = [0, 1].map((index) => ({
        ...OPERATION,
        id: `cruise-${index + 1}`,
        theaterId,
        title: `Cruise ${index + 1}`,
        ts: { createdAt: index, updatedAt: index },
      }));
      loadForTheater(theaterId);
      setState({
        operations: Object.fromEntries(operations.map((operation, index) => [
          operation.id,
          { x: index * 40, y: index * 40, width: 320, height: 200, zIndex: index + 1 },
        ])),
      });
      renderOperationsCanvas({ ...CANVAS_STATE, activeTheaterId: theaterId, operations });

      // 마운트 직후의 Cruise는 복귀가 아니다 — 커튼을 치지 않는다.
      expect(document.querySelector(".canvas-cruise-curtain")).toBeNull();

      act(() => toggleFormationView());
      // 모드 이름은 어느 로케일에서도 제품 고유 명칭 그대로 각인과 헤딩에 남는다.
      expect(document.querySelector(".canvas-formation-curtain strong")?.textContent).toMatch(/Tactical/);
      expect(document.querySelector(".canvas-formation-curtain .canvas-mode-curtain-kicker")?.textContent).toBe("TACTICAL");
      act(() => vi.advanceTimersByTime(1_950));

      act(() => clearFormationView());
      expect(document.querySelector(".canvas-cruise-curtain strong")?.textContent).toMatch(/Cruise/);
      expect(document.querySelector(".canvas-cruise-curtain .canvas-mode-curtain-kicker")?.textContent).toBe("CRUISE");

      act(() => vi.advanceTimersByTime(1_400));
      expect(document.querySelector(".canvas-cruise-curtain")).toBeNull();
    } finally {
      act(() => clearFormationView());
      vi.useRealTimers();
    }
  });

  it("does not render the empty canvas state beneath the Formation entry curtain", () => {
    vi.useFakeTimers();
    try {
      const theaterId = "formation-empty-curtain";
      loadForTheater(theaterId);
      setState({ operations: {}, minimized: [] });
      renderOperationsCanvas({
        ...CANVAS_STATE,
        activeTheaterId: theaterId,
        operations: [],
      });
      expect(document.querySelector(".operations-canvas-empty")).not.toBeNull();

      act(() => toggleFormationView());
      expect(document.querySelector(".canvas-formation-curtain")).not.toBeNull();
      expect(document.querySelector(".operations-canvas-empty")).toBeNull();

      act(() => vi.advanceTimersByTime(1_950));
      expect(document.querySelector(".canvas-formation-curtain")).toBeNull();
      expect(document.querySelector(".operations-canvas-empty")).not.toBeNull();
    } finally {
      act(() => clearFormationView());
      vi.useRealTimers();
    }
  });

  it("keeps peer frames mounted with geometry but visually and interactively absent in the focus layer", () => {
    renderOperationsCanvas();
    const peer = document.querySelector<HTMLElement>('[aria-label="Operation Peer"]');
    const peerIdentity = document.querySelector<HTMLButtonElement>('[aria-label="Rename operation Peer"]');
    expect(peer).not.toBeNull();
    expect(peerIdentity).not.toBeNull();
    expect(peer?.hidden).toBe(false);
    peerIdentity?.focus();
    expect(document.activeElement).toBe(peerIdentity);

    act(() => {
      toggleFormationView();
      setMaximizedOperationId("operation");
    });

    expect(document.querySelector('[aria-label="Operation Peer"]')).toBe(peer);
    expect(peer?.hidden).toBe(false);
    expect(getComputedStyle(peer!).visibility).toBe("hidden");
    expect(getComputedStyle(peer!).pointerEvents).toBe("none");
    expect(Number.parseFloat(getComputedStyle(peer!).width)).toBeGreaterThan(0);
    expect(Number.parseFloat(getComputedStyle(peer!).height)).toBeGreaterThan(0);
    expect(peer?.getAttribute("aria-hidden")).toBe("true");
    expect(peer?.hasAttribute("inert")).toBe(true);
    const focusedFrame = document.querySelector<HTMLElement>('[aria-label="Operation Minimap boundary"]');
    expect(focusedFrame?.hidden).toBe(false);
    expect(document.activeElement).toBe(focusedFrame);
    expect(getSnapshot().minimized).toEqual([]);

    act(() => clearMaximizedOperationId());

    expect(peer?.hidden).toBe(false);
    expect(getSnapshot().minimized).toEqual([]);
  });

  it("passes the companion callback through render context and restores Map geometry on exit", () => {
    renderOperationsCanvas({
      ...CANVAS_STATE,
      keyboardFocusRequest: { operationId: "operation", requestId: 7 },
    });
    const targetFrame = document.querySelector<HTMLElement>('[aria-label="Operation Minimap boundary"]');
    const targetBody = document.querySelector<HTMLElement>('[data-plugin-operation="operation"]');
    const peer = document.querySelector<HTMLElement>('[aria-label="Operation Peer"]');

    expect(targetBody?.getAttribute("data-keyboard-focus-request")).toBe("7");
    expect(document.querySelector('[data-plugin-operation="peer"]')?.getAttribute("data-keyboard-focus-request")).toBe("0");

    act(() => targetBody?.click());

    expect(getCompanionOperationId()).toBe("operation");
    expect(document.querySelector(".operations-canvas")?.classList.contains("is-companion-layout")).toBe(true);
    expect(document.querySelectorAll(".canvas-companion-frame")).toHaveLength(2);
    expect(document.querySelectorAll('[data-test-companion][data-companions-open="true"]')).toHaveLength(2);
    expect([...document.querySelectorAll('[data-test-companion]')].every((element) => !element.hasAttribute("data-keyboard-focus-request"))).toBe(true);
    expect(document.querySelector('[data-plugin-operation="operation"]')).toBe(targetBody);
    expect(getComputedStyle(peer!).visibility).toBe("hidden");
    expect(Number.parseFloat(targetFrame?.style.width ?? "0")).toBeCloseTo((900 - 16) / 3, 0);

    // 기본 companion은 캡션을 유지하고 opt-in companion만 캡션을 숨긴다. 두 프레임 모두 접근성 이름은 유지한다.
    expect(document.querySelector('.canvas-companion-frame button')).toBeNull();
    expect([...document.querySelectorAll(".canvas-companion-caption-title")].map((el) => el.textContent)).toEqual(["Chat"]);
    expect(document.querySelector('[aria-label="Companion Chat"] .canvas-companion-caption')).not.toBeNull();
    expect(document.querySelector('[aria-label="Companion Artifacts"] .canvas-companion-caption')).toBeNull();
    expect(document.querySelector('[aria-label="Companion Artifacts"]')).not.toBeNull();
    act(() => targetBody?.click());

    expect(getCompanionOperationId()).toBeNull();
    expect(document.querySelectorAll(".canvas-companion-frame")).toHaveLength(0);
    expect(document.querySelector('[data-plugin-operation="operation"]')).toBe(targetBody);
    expect(targetFrame?.style.width).toBe("320px");
    expect(getComputedStyle(peer!).visibility).not.toBe("hidden");

    act(() => targetBody?.click());
    expect(getCompanionOperationId()).toBe("operation");
    act(() => targetBody?.click());
    expect(getCompanionOperationId()).toBeNull();
  });

  it("renders Analyze over Formation and restores the preserved Formation layout on Exit", () => {
    renderOperationsCanvas();
    const targetFrame = document.querySelector<HTMLElement>('[aria-label="Operation Minimap boundary"]');
    const targetBody = document.querySelector<HTMLElement>('[data-plugin-operation="operation"]');
    act(() => toggleFormationView());
    expect(document.querySelector(".operations-canvas")?.classList.contains("is-formation-view")).toBe(true);

    act(() => targetBody?.click());
    expect(getCompanionOperationId()).toBe("operation");
    expect(getFormationView()).toBe(true);
    expect(document.querySelector(".operations-canvas")?.classList.contains("is-companion-layout")).toBe(true);
    const formationCompanionFrames = [
      targetFrame!,
      ...document.querySelectorAll<HTMLElement>(".canvas-companion-frame"),
    ].map(readInlineFrameRect);
    expect(formationCompanionFrames).toHaveLength(3);
    for (const frame of formationCompanionFrames) {
      expect(frame.x).toBeGreaterThanOrEqual(18);
      expect(frame.y).toBeGreaterThanOrEqual(18);
      expect(frame.x + frame.width).toBeLessThanOrEqual(900 - 18);
      expect(frame.y + frame.height).toBeLessThanOrEqual(600 - 18);
    }
    const framesByX = [...formationCompanionFrames].sort((left, right) => left.x - right.x);
    expect(framesByX[0]!.x + framesByX[0]!.width).toBeLessThan(framesByX[1]!.x);
    expect(framesByX[1]!.x + framesByX[1]!.width).toBeLessThan(framesByX[2]!.x);

    act(() => targetBody?.click());
    expect(getCompanionOperationId()).toBeNull();
    expect(getFormationView()).toBe(true);
    expect(document.querySelector(".operations-canvas")?.classList.contains("is-formation-view")).toBe(true);
  });

  it("restores Maximized on explicit Exit but force-drops it when the target is minimized", () => {
    renderOperationsCanvas();
    const targetBody = document.querySelector<HTMLElement>('[data-plugin-operation="operation"]');
    act(() => setMaximizedOperationId("operation"));
    act(() => targetBody?.click());
    expect(getCompanionOperationId()).toBe("operation");

    act(() => targetBody?.click());
    expect(getMaximizedOperationId()).toBe("operation");
    expect(document.querySelector(".operations-canvas")?.classList.contains("is-panel-maximized")).toBe(true);

    act(() => targetBody?.click());
    act(() => minimizeOperation("operation"));
    expect(getCompanionOperationId()).toBeNull();
    expect(getMaximizedOperationId()).toBeNull();
  });

  it("keeps the companion layout and frames during the missing-operation grace period", () => {
    vi.useFakeTimers();
    try {
      renderOperationsCanvas();
      const targetFrame = document.querySelector<HTMLElement>('[aria-label="Operation Minimap boundary"]');
      const targetBody = document.querySelector<HTMLElement>('[data-plugin-operation="operation"]');
      act(() => setMaximizedOperationId("operation"));
      act(() => targetBody?.click());

      renderOperationsCanvas({ ...CANVAS_STATE, operations: [PEER_OPERATION] });

      expect(getCompanionOperationId()).toBe("operation");
      expect(document.querySelector(".operations-canvas")?.classList.contains("is-companion-layout")).toBe(true);
      expect(document.querySelector('[aria-label="Operation Minimap boundary"]')).toBe(targetFrame);
      expect(document.querySelectorAll(".canvas-companion-frame")).toHaveLength(2);
      expect(getComputedStyle(document.querySelector<HTMLElement>('[aria-label="Operation Peer"]')!).visibility).toBe("hidden");

      act(() => vi.advanceTimersByTime(1_499));
      expect(document.querySelector(".operations-canvas")?.classList.contains("is-companion-layout")).toBe(true);
      expect(document.querySelectorAll(".canvas-companion-frame")).toHaveLength(2);

      act(() => vi.advanceTimersByTime(1));
      expect(getCompanionOperationId()).toBeNull();
      expect(getMaximizedOperationId()).toBeNull();
      expect(document.querySelector(".operations-canvas")?.classList.contains("is-companion-layout")).toBe(false);
      expect(document.querySelector('[aria-label="Operation Minimap boundary"]')).toBeNull();
      expect(document.querySelectorAll(".canvas-companion-frame")).toHaveLength(0);
      expect(getComputedStyle(document.querySelector<HTMLElement>('[aria-label="Operation Peer"]')!).visibility).not.toBe("hidden");
    } finally {
      vi.useRealTimers();
    }
  });

  it("transfers focus out of a hidden peer to the front frame", () => {
    renderOperationsCanvas();
    const peerControl = document.querySelector<HTMLButtonElement>('[aria-label="Open menu for operation Peer"]');
    expect(peerControl).not.toBeNull();
    peerControl!.focus();
    expect(document.activeElement).toBe(peerControl);

    act(() => setMaximizedOperationId("operation"));

    const focusedFrame = document.querySelector<HTMLElement>('[aria-label="Operation Minimap boundary"]');
    expect(document.activeElement).toBe(focusedFrame);
    expect(document.querySelector<HTMLElement>('[aria-label="Operation Peer"]')?.contains(document.activeElement)).toBe(false);
  });

  // Map <main>은 제스처·우클릭 판이지 키보드 정거장이 아니다. tabindex=-1이면 채팅 로그처럼
  // 포커스 불가한 본문을 누른 뒤 Enter가 :focus-visible brass 링을 바다 왼쪽에 남긴다.
  it("does not accept keyboard focus on the Map canvas", () => {
    renderOperationsCanvas();
    const canvas = document.querySelector<HTMLElement>("main.operations-canvas");
    expect(canvas).not.toBeNull();
    expect(canvas!.hasAttribute("tabindex")).toBe(false);
    canvas!.focus();
    expect(document.activeElement).not.toBe(canvas);
    const peer = document.querySelector<HTMLElement>('[aria-label="Operation Peer"]');
    expect(peer).not.toBeNull();
    peer!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.activeElement).not.toBe(canvas);
  });

  // 메뉴는 페이지가 소유하고 프레임은 자기가 숨는 것만 안다 — 숨는 순간 그 사실을 주인 id와 함께
  // 올려야, 보이지 않는 패널의 메뉴가 화면에 남아 조작 가능한 채로 버티지 않는다.
  it("reports its own id when a hidden peer's menu owner leaves the focus layer", () => {
    const dismissed: string[] = [];
    renderOperationsCanvas(CANVAS_STATE, { onDismissOperationMenu: (id) => dismissed.push(id) });

    act(() => setMaximizedOperationId("operation"));

    expect(dismissed).toContain("peer");
    expect(dismissed).not.toContain("operation");
  });

  it("moves the canvas viewport when the mounted minimap receives pointer navigation", () => {
    renderOperationsCanvas();
    const inner = document.querySelector<HTMLDivElement>(".canvas-minimap-inner");
    expect(inner).not.toBeNull();
    Object.defineProperty(inner!, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0 }),
    });
    const pointerDown = new MouseEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0 });
    Object.defineProperty(pointerDown, "pointerId", { value: 1 });

    act(() => inner!.dispatchEvent(pointerDown));

    expect(getSnapshot().viewport).toMatchObject({ zoom: 1 });
    expect(getSnapshot().viewport.x).toBeGreaterThan(0);
    expect(getSnapshot().viewport.y).toBeGreaterThan(0);
  });
});

const OPERATION: OperationNode = {
  id: "operation",
  theaterId: "minimap-boundary",
  type: "shell",
  pluginId: "test-plugin",
  title: "Minimap boundary",
  payload: {},
  geometry: { x: 0, y: 0, width: 320, height: 200, zIndex: 1 },
  ts: { createdAt: 0, updatedAt: 0 },
};

const PEER_OPERATION: OperationNode = {
  ...OPERATION,
  id: "peer",
  title: "Peer",
  geometry: { x: 360, y: 40, width: 320, height: 200, zIndex: 2 },
};

const CANVAS_STATE: ConsoleState = {
  connection: "connecting",
  connectionLostAt: null,
  controlHolder: null,
  controlCurtainDismissed: false,
  consoleName: "",
  channel: "unknown",
  activeTheme: "maritime",
  version: "test",
  updateAvailable: false,
  latestVersion: null,
  portMode: "dynamic",
  requestedPort: null,
  effectivePort: 0,
  portHonored: true,
  theaters: [],
  operations: [OPERATION, PEER_OPERATION],
  operationsHydrated: true,
  groups: [],
  activeTheaterId: "minimap-boundary",
  activeOperationId: null,
  activeOperationAcknowledged: true,
  operationRuntime: {},
  operationRuntimeHydration: "ready",
  operationRuntimeError: null,
  addingTheater: false,
  theaterError: null,
  operationsViewActive: true,
  operationSearchOpen: false,
  operationSearchSeed: null,
  quickLaunchOpen: false,
  quickLaunchPinned: false,
  quickLaunchFocusToggle: 0,
  quickLaunchExpandRequest: 0,
  quickLaunchMentionSeed: null,
  quickLaunchDockSuppressed: false,
  quickLaunchDraft: null,
  quickLaunchDraftAttachments: null,
  quickLaunchError: null,
  quickLaunchErrorShortenBy: null,
  pendingQuickLaunch: null,
  whatsNewOpen: false,
  releaseNotes: [],
  releaseNotesLocale: null,
  releaseNotesLoading: false,
  releaseNotesError: null,
  releaseNotesSourceRef: null,
  releaseNotesFetchedAt: null,
  releaseNotesStale: false,
  automaticWhatsNewVersion: null,
  selectedReleaseNoteKey: null,
  onboardingOpen: false,
  bootstrapped: true,
  pendingOperationFocus: null,
  keyboardFocusRequest: null,
  pendingSideBarAddTheater: false,
  pendingSideBarTheaterLaunch: null,
  launchMenuRequest: null,
  keyboardShortcutsOpen: false,
  operationNotifications: {},
  notificationPreferences: { globalMute: false, dnd: false, mutedTheaterIds: {} },
  codexReader: null,
  codexReaderExpanded: false,
};

function renderOperationsCanvas(
  state: ConsoleState = CANVAS_STATE,
  overrides: { readonly onDismissOperationMenu?: (operationId: string) => void } = {},
) {
  act(() => root!.render(createElement(OperationsCanvas, {
    state,
    catalog: [],
    canLaunch: false,
    renderKindIcon: () => null,
    onLaunchKind: () => {},
    onLaunchAtGeometry: () => {},
    onClose: () => {},
    onFocus: () => {},
    onOpenAll: () => {},
    onRename: () => {},
    onOpenOperationMenu: () => {},
    onDismissOperationMenu: () => {},
    ...overrides,
  })));
}

function readInlineFrameRect(element: HTMLElement) {
  return {
    x: Number.parseFloat(element.style.left),
    y: Number.parseFloat(element.style.top),
    width: Number.parseFloat(element.style.width),
    height: Number.parseFloat(element.style.height),
  };
}

function restoreProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
  } else {
    Reflect.deleteProperty(target, key);
  }
}
