// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalMocks = vi.hoisted(() => ({
  fit: vi.fn(),
  focus: vi.fn(),
  refresh: vi.fn(),
  resize: vi.fn(),
  resumeFollowing: vi.fn(),
  setActive: vi.fn(),
  start: vi.fn(),
  waitForSymbols: vi.fn<() => Promise<void>>(),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class Terminal {
    readonly buffer = { active: { baseY: 0, viewportY: 0 } };
    readonly cols = 80;
    readonly rows = 24;
    readonly unicode = { activeVersion: "" };
    readonly parser = { registerOscHandler: () => ({ dispose() {} }) };
    readonly options: Record<string, unknown> = {};
    readonly focus = terminalMocks.focus;
    attachCustomKeyEventHandler() {}
    dispose() {}
    getSelection() { return ""; }
    input() {}
    loadAddon() {}
    onData() { return { dispose() {} }; }
    open() {}
    refresh = terminalMocks.refresh;
    scrollToBottom() {}
    scrollToLine() {}
    write(_data: Uint8Array, callback?: () => void) { callback?.(); }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class FitAddon { readonly fit = terminalMocks.fit; } }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class Unicode11Addon {} }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class WebglAddon {
    dispose() {}
    onContextLoss() {}
  },
}));
vi.mock("../client/shared/ime-shift-enter.js", () => ({
  createImeShiftEnterHandler: () => ({
    dispose() {},
    handleKeyEvent: () => true,
    onCompositionCancel() {},
    onCompositionEnd() {},
    onCompositionStart() {},
  }),
}));
vi.mock("../client/shared/terminal-fallback-fonts.js", () => ({ waitForTerminalFallbackFonts: terminalMocks.waitForSymbols }));
vi.mock("../client/shared/terminal-connection.js", () => ({
  createTerminalConnection: () => ({ dispose() {}, resize: terminalMocks.resize, start: terminalMocks.start }),
}));
vi.mock("../client/shared/terminal-copy-on-select.js", () => ({
  createTerminalCopyOnSelect: () => ({ dispose() {} }),
}));
vi.mock("../client/shared/terminal-preferences.js", () => ({
  useTerminalPrefs: () => ({ renderer: "dom", inactiveFlush: "balanced", font: { family: "monospace", size: 14 } }),
  terminalInactiveFlushMs: () => 250,
}));
vi.mock("../client/shared/terminal-scroll-follow.js", () => ({
  createTerminalScrollFollow: () => ({
    dispose() {},
    preserveAfterGeometryChange: (action: () => void) => action(),
    recordUserViewportChange() {},
    restoreAfterOutputParsing() {},
    resumeFollowing: terminalMocks.resumeFollowing,
  }),
}));
vi.mock("../client/shared/windows-selection-copy.js", () => ({
  createWindowsSelectionCopyHandler: () => ({ handleKeyEvent: () => true }),
}));

import { TerminalSurface } from "../client/shared/terminal-surface.js";

let container: HTMLDivElement | null = null;
let fontsDescriptor: PropertyDescriptor | undefined;
let resizeObserverDescriptor: PropertyDescriptor | undefined;
let resizeObserverCallback: (() => void) | null = null;
let root: Root | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  terminalMocks.fit.mockClear();
  terminalMocks.focus.mockClear();
  terminalMocks.refresh.mockClear();
  terminalMocks.resize.mockClear();
  terminalMocks.resumeFollowing.mockClear();
  terminalMocks.setActive.mockClear();
  terminalMocks.start.mockClear();
  terminalMocks.waitForSymbols.mockReset();
  terminalMocks.waitForSymbols.mockResolvedValue();
  fontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  resizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class ResizeObserver {
      constructor(callback: () => void) {
        resizeObserverCallback = callback;
      }
      disconnect() {
        resizeObserverCallback = null;
      }
      observe() {}
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  if (fontsDescriptor) {
    Object.defineProperty(document, "fonts", fontsDescriptor);
  } else {
    Reflect.deleteProperty(document, "fonts");
  }
  if (resizeObserverDescriptor) {
    Object.defineProperty(globalThis, "ResizeObserver", resizeObserverDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
  container?.remove();
  container = null;
  resizeObserverCallback = null;
  root = null;
});

describe("TerminalSurface keyboard focus requests", () => {
  it("defers a pre-mount focus request until the terminal input transport is ready", async () => {
    const symbolsReady = deferred<void>();
    const documentFontsReady = deferred<void>();
    const callOrder: string[] = [];
    terminalMocks.waitForSymbols.mockReturnValueOnce(symbolsReady.promise);
    terminalMocks.start.mockImplementation(() => callOrder.push("start"));
    terminalMocks.focus.mockImplementation(() => callOrder.push("focus"));
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: documentFontsReady.promise },
    });

    await renderSurface(true, 1);
    await renderSurface(true, 2);
    expect(terminalMocks.focus).not.toHaveBeenCalled();

    await resolveAndFlush(symbolsReady);

    expect(terminalMocks.start).not.toHaveBeenCalled();
    expect(terminalMocks.focus).not.toHaveBeenCalled();

    await resolveAndFlush(documentFontsReady);

    expect(callOrder[0]).toBe("start");
    // One call is the mount fallback and one proves the queued request survived via inputReadyEpoch.
    expect(terminalMocks.focus).toHaveBeenCalledTimes(2);
  });

  it("refocuses when only keyboardFocusRequestId changes while active stays true", async () => {
    await renderSurface(true, 1);
    const focusCallsAfterMount = terminalMocks.focus.mock.calls.length;

    await renderSurface(true, 2);

    expect(terminalMocks.focus).toHaveBeenCalledTimes(focusCallsAfterMount + 1);
    expect(terminalMocks.resumeFollowing).toHaveBeenCalled();
  });

  it("does not focus when keyboardFocusRequestId changes while inactive", async () => {
    await renderSurface(false, 1);
    expect(terminalMocks.focus).not.toHaveBeenCalled();

    await renderSurface(false, 2);

    expect(terminalMocks.focus).not.toHaveBeenCalled();
  });

  it("coalesces zoom correction with the final resize settle", async () => {
    vi.useFakeTimers();
    try {
      await renderSurface(true, 1, 0.75);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      terminalMocks.fit.mockClear();
      terminalMocks.resize.mockClear();
      terminalMocks.refresh.mockClear();

      await renderSurface(true, 1, 1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120);
      });
      await act(async () => {
        resizeObserverCallback?.();
        await vi.advanceTimersByTimeAsync(80);
      });

      expect(terminalMocks.fit).toHaveBeenCalledTimes(1);
      expect(terminalMocks.resize).toHaveBeenCalledTimes(1);
      expect(terminalMocks.refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

async function renderSurface(active: boolean, keyboardFocusRequestId: number, zoom = 1): Promise<void> {
  await act(async () => {
    root!.render(createElement(TerminalSurface, {
      operationId: "operation-a",
      ticketPath: "/ticket",
      wsPath: "/terminal",
      active,
      keyboardFocusRequestId,
      zoom,
    }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function resolveAndFlush(gate: Deferred<void>): Promise<void> {
  await act(async () => {
    gate.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}
