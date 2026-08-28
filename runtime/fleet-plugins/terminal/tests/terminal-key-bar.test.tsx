// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ESC = String.fromCharCode(0x1b);

const terminalMocks = vi.hoisted(() => ({
  blur: vi.fn(),
  focus: vi.fn(),
  /** What the connection would put on the wire — the only place a double-applied modifier shows. */
  sent: vi.fn<(data: string) => void>(),
  emitData: null as ((data: string) => void) | null,
  applicationCursorKeysMode: false,
  /** Swapped for a deferred promise to hold the terminal in its pre-mount state. */
  symbolsReady: Promise.resolve(),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class Terminal {
    readonly buffer = { active: { baseY: 0, viewportY: 0 } };
    readonly cols = 80;
    readonly rows = 24;
    readonly unicode = { activeVersion: "" };
    readonly parser = { registerOscHandler: () => ({ dispose() {} }) };
    readonly options: Record<string, unknown> = {};
    readonly modes = {
      get applicationCursorKeysMode() { return terminalMocks.applicationCursorKeysMode; },
    };
    readonly blur = terminalMocks.blur;
    readonly focus = terminalMocks.focus;
    #listeners: Array<(data: string) => void> = [];
    attachCustomKeyEventHandler() {}
    dispose() {}
    getSelection() { return ""; }
    /** Real xterm routes input() back through onData, so the mock must too — that round trip is
        exactly where a latch cleared too late would apply a modifier a second time. */
    input(data: string) {
      for (const listener of this.#listeners) listener(data);
    }
    loadAddon() {}
    onData(listener: (data: string) => void) {
      this.#listeners.push(listener);
      terminalMocks.emitData = (data: string) => {
        for (const registered of this.#listeners) registered(data);
      };
      return { dispose: () => { this.#listeners = []; } };
    }
    open() {}
    refresh() {}
    scrollToBottom() {}
    scrollToLine() {}
    write(_data: Uint8Array, callback?: () => void) { callback?.(); }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class FitAddon { fit() {} } }));
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
vi.mock("../client/shared/terminal-fallback-fonts.js", () => ({ waitForTerminalFallbackFonts: () => terminalMocks.symbolsReady }));
vi.mock("../client/shared/terminal-connection.js", () => ({
  createTerminalConnection: (options: { terminal: { onData: (listener: (data: string) => void) => unknown } }) => {
    options.terminal.onData((data) => terminalMocks.sent(data));
    return { dispose() {}, resize() {}, start() {} };
  },
}));
vi.mock("../client/shared/terminal-copy-on-select.js", () => ({
  createTerminalCopyOnSelect: () => ({ dispose() {} }),
}));
vi.mock("../client/shared/terminal-osc52-clipboard.js", () => ({
  createTerminalOsc52Clipboard: () => ({ dispose() {} }),
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
    resumeFollowing() {},
  }),
}));
vi.mock("../client/shared/windows-selection-copy.js", () => ({
  createWindowsSelectionCopyHandler: () => ({ handleKeyEvent: () => true }),
}));

import { TerminalSurface } from "../client/shared/terminal-surface.js";

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let fontsDescriptor: PropertyDescriptor | undefined;
let matchMediaDescriptor: PropertyDescriptor | undefined;
let resizeObserverDescriptor: PropertyDescriptor | undefined;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function useCoarsePointer(coarse: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: coarse && query.includes("coarse"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
}

beforeEach(() => {
  terminalMocks.blur.mockClear();
  terminalMocks.focus.mockClear();
  terminalMocks.sent.mockClear();
  terminalMocks.emitData = null;
  terminalMocks.applicationCursorKeysMode = false;
  terminalMocks.symbolsReady = Promise.resolve();
  fontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
  matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");
  useCoarsePointer(true);
  resizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class ResizeObserver {
      disconnect() {}
      observe() {}
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  restore(document, "fonts", fontsDescriptor);
  restore(window, "matchMedia", matchMediaDescriptor);
  restore(globalThis, "ResizeObserver", resizeObserverDescriptor);
  container?.remove();
  container = null;
  root = null;
});

describe("TerminalKeyBar on a touch terminal", () => {
  it("carries the keys a soft keyboard has no room for", async () => {
    await renderSurface();

    expect(keyLabels()).toEqual(["Esc", "Tab", "Ctrl", "Alt", "←", "↑", "↓", "→", "⋯"]);
  });

  it("stays away from a pointer that has a real keyboard behind it", async () => {
    useCoarsePointer(false);

    await renderSurface();

    expect(container?.querySelector(".terminal-key-bar")).toBeNull();
  });

  it("sends a key's own bytes, and follows DECCKM for the cursor keys", async () => {
    await renderSurface();

    await press("Esc");
    expect(terminalMocks.sent).toHaveBeenLastCalledWith(ESC);

    await press("↑");
    expect(terminalMocks.sent).toHaveBeenLastCalledWith(`${ESC}[A`);

    terminalMocks.applicationCursorKeysMode = true;
    await press("↑");
    expect(terminalMocks.sent).toHaveBeenLastCalledWith(`${ESC}OA`);
  });

  it("applies a latched Ctrl to the letter the soft keyboard sends next", async () => {
    await renderSurface();

    await press("Ctrl");
    expect(button("Ctrl")?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => { terminalMocks.emitData?.("c"); });

    expect(terminalMocks.sent).toHaveBeenLastCalledWith(String.fromCharCode(0x03));
    // The latch is spent on that one key, so the next letter is itself again.
    expect(button("Ctrl")?.getAttribute("aria-pressed")).toBe("false");
    await act(async () => { terminalMocks.emitData?.("c"); });
    expect(terminalMocks.sent).toHaveBeenLastCalledWith("c");
  });

  it("applies a latched modifier to a bar key exactly once", async () => {
    await renderSurface();

    await press("Ctrl");
    await press("←");

    // input() re-enters the same data listener, so a latch cleared too late would encode twice.
    expect(terminalMocks.sent).toHaveBeenCalledTimes(1);
    expect(terminalMocks.sent).toHaveBeenLastCalledWith(`${ESC}[1;5D`);
  });

  it("opens the extra keys in the keyboard's place rather than above it", async () => {
    await renderSurface();

    await press("⋯");

    expect(terminalMocks.blur).toHaveBeenCalledTimes(1);
    expect(keyLabels()).toContain("PgUp");
    expect(keyLabels()).toContain("F12");
    expect(keyLabels()).toContain("|");

    const focusCallsWhileOpen = terminalMocks.focus.mock.calls.length;
    await press("⋯");

    expect(keyLabels()).not.toContain("PgUp");
    expect(terminalMocks.focus.mock.calls.length).toBe(focusCallsWhileOpen + 1);
  });

  it("does not refocus the terminal while the panel stands in for the keyboard", async () => {
    await renderSurface();
    await press("⋯");
    const focusCallsWhileOpen = terminalMocks.focus.mock.calls.length;

    // A focus request — reselecting the operation, the session becoming active again — must not
    // reopen the soft keyboard underneath the open panel.
    await renderSurface({ keyboardFocusRequestId: 2 });

    expect(terminalMocks.focus.mock.calls.length).toBe(focusCallsWhileOpen);
  });

  it("does not let a terminal that mounts later steal focus back", async () => {
    // The bar renders before xterm finishes mounting, so the panel can open while terminalRef is
    // still null — the blur lands nowhere, and the mount's own focus would undo the replacement.
    let releaseSymbols!: () => void;
    terminalMocks.symbolsReady = new Promise<void>((resolve) => { releaseSymbols = () => resolve(); });

    await renderSurface();
    await press("⋯");
    expect(terminalMocks.focus).not.toHaveBeenCalled();

    await act(async () => {
      releaseSymbols();
      await terminalMocks.symbolsReady;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(terminalMocks.focus).not.toHaveBeenCalled();
  });

  it("sends a symbol as itself", async () => {
    await renderSurface();
    await press("⋯");

    await press("|");

    expect(terminalMocks.sent).toHaveBeenLastCalledWith("|");
  });

  it("keeps focus on the terminal when a key is pressed", async () => {
    await renderSurface();
    const escape = button("Esc");
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });

    escape?.dispatchEvent(event);

    // A press that moved focus would close the soft keyboard mid-session.
    expect(event.defaultPrevented).toBe(true);
  });
});

async function renderSurface(overrides: { readonly keyboardFocusRequestId?: number } = {}): Promise<void> {
  await act(async () => {
    root!.render(createElement(TerminalSurface, {
      operationId: "operation-a",
      ticketPath: "/ticket",
      wsPath: "/terminal",
      active: true,
      ...overrides,
    }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function keyButtons(): readonly HTMLButtonElement[] {
  return Array.from(container?.querySelectorAll<HTMLButtonElement>(".terminal-key") ?? []);
}

function keyLabels(): readonly string[] {
  return keyButtons().map((element) => element.textContent ?? "");
}

function button(label: string): HTMLButtonElement | undefined {
  return keyButtons().find((element) => element.textContent === label);
}

async function press(label: string): Promise<void> {
  const target = button(label);
  if (!target) throw new Error(`No key labelled ${label}`);
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

function restore(target: object, property: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, property, descriptor);
  else Reflect.deleteProperty(target, property);
}
