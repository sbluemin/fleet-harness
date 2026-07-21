// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OperationsCanvas } from "../core/client/src/canvas/canvas.js";
import { CanvasMinimap } from "../core/client/src/canvas/canvas-minimap.js";
import { clearCompanionOperationId, clearFormationView, clearMaximizedOperationId, getCompanionOperationId, getFormationView, getMaximizedOperationId, getSnapshot, loadForTheater, minimizeOperation, setMaximizedOperationId, setState, toggleFormationView } from "../core/client/src/canvas/canvas-store.js";
import type { ConsoleState, OperationNode } from "../core/client/src/types.js";

vi.mock("../core/client/src/plugin-registry.js", () => ({
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
    const targetBody = document.querySelector<HTMLElement>('[data-plugin-operation="operation"]');
    act(() => toggleFormationView());
    expect(document.querySelector(".operations-canvas")?.classList.contains("is-formation-view")).toBe(true);

    act(() => targetBody?.click());
    expect(getCompanionOperationId()).toBe("operation");
    expect(getFormationView()).toBe(true);
    expect(document.querySelector(".operations-canvas")?.classList.contains("is-companion-layout")).toBe(true);

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

  it("closes a hidden peer's portaled accent menu and transfers its menu focus", () => {
    renderOperationsCanvas();
    const peerAccent = document.querySelector<HTMLButtonElement>('[aria-label="Set accent for operation Peer"]');
    expect(peerAccent).not.toBeNull();

    act(() => peerAccent!.click());

    const menuItem = document.querySelector<HTMLButtonElement>('[role="menuitem"]');
    expect(menuItem).not.toBeNull();
    menuItem?.focus();
    expect(document.activeElement).toBe(menuItem);

    act(() => setMaximizedOperationId("operation"));

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector(".accent-popover-overlay")).toBeNull();
    const focusedFrame = document.querySelector<HTMLElement>('[aria-label="Operation Minimap boundary"]');
    expect(document.activeElement).toBe(focusedFrame);
    expect(document.querySelector<HTMLElement>('[aria-label="Operation Peer"]')?.contains(document.activeElement)).toBe(false);
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
  connectionError: null,
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
  operationStatus: {},
  addingTheater: false,
  theaterError: null,
  operationsViewActive: true,
  operationSearchOpen: false,
  whatsNewOpen: false,
  releaseNotes: [],
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
  operationNotifications: {},
  notificationPreferences: { globalMute: false, dnd: false, mutedTheaterIds: {} },
  codexReader: null,
  codexReaderExpanded: false,
};

function renderOperationsCanvas(state: ConsoleState = CANVAS_STATE) {
  act(() => root!.render(createElement(OperationsCanvas, {
    state,
    catalog: [],
    canLaunch: false,
    renderKindIcon: () => null,
    onLaunchKind: () => {},
    onLaunchAtGeometry: () => {},
    onClose: () => {},
    onFocus: () => {},
    onRename: () => {},
    onSetAccent: () => {},
  })));
}

function restoreProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
  } else {
    Reflect.deleteProperty(target, key);
  }
}
