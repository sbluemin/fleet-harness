// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const panelMocks = vi.hoisted(() => ({
  historyState: { canGoBack: false, canGoForward: false },
  closeCodexReader: vi.fn(),
  mountNavigatorInto: vi.fn(),
  mountReaderInto: vi.fn(),
  refreshCodexHealth: vi.fn(),
  saveReaderScroll: vi.fn(),
  setNavigatorTheater: vi.fn(),
  teardownCodex: vi.fn(),
  consoleState: {
    activeTheaterId: "theater-a",
    codexReader: null as null | { kind: "drydock"; patchId: string },
    codexReaderExpanded: false,
    theaters: [
      { id: "theater-a", label: "Theater A" },
      { id: "theater-b", label: "Theater B" },
    ],
  },
}));

vi.mock("../core/client/src/codex-host.js", () => ({
  getCodexReaderHistoryState: () => panelMocks.historyState,
  mountNavigatorInto: panelMocks.mountNavigatorInto,
  mountReaderInto: panelMocks.mountReaderInto,
  navigateCodexReaderHistory: vi.fn(),
  refreshCodexHealth: panelMocks.refreshCodexHealth,
  refreshCodexLocale: vi.fn(),
  restoreCodexReaderSession: vi.fn(() => null),
  saveReaderScroll: panelMocks.saveReaderScroll,
  setNavigatorTheater: panelMocks.setNavigatorTheater,
  setOnRequestOpenReader: vi.fn(),
  subscribeCodexReaderHistory: vi.fn(() => () => undefined),
  teardownCodex: panelMocks.teardownCodex,
  teardownReaderNodes: vi.fn(),
}));

vi.mock("../core/client/src/hooks/use-store.js", () => ({
  useConsoleState: () => panelMocks.consoleState,
}));

vi.mock("../core/client/src/i18n/index.js", () => ({
  getT: () => (key: string) => key,
  useConsoleLocale: () => "en",
  useT: () => (key: string) => key,
}));

vi.mock("../core/client/src/store.js", () => ({
  closeCodexReader: panelMocks.closeCodexReader,
  expandCodexReader: vi.fn(),
  openCodexReader: vi.fn(),
}));

vi.mock("../core/client/src/codex/state.js", () => ({
  loadInitialData: vi.fn(),
}));

import { CodexReadingSheet } from "../core/client/src/components/codex-reading-sheet.js";
import { codexPanel } from "../core/client/src/rail/codex-panel.js";

let container: HTMLDivElement;
let root: Root;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.clearAllMocks();
  panelMocks.consoleState.activeTheaterId = "theater-a";
  panelMocks.consoleState.codexReader = null;
  panelMocks.consoleState.codexReaderExpanded = false;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const theaterId = String(input).includes("theater-b") ? "b" : "a";
    return new Response(JSON.stringify({ hasWiki: true, id: `00000000000${theaterId}` }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  }));
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("Codex rail panel in-memory state", () => {
  it("refreshes navigator health after a split-reader drydock decision", async () => {
    panelMocks.consoleState.codexReader = { kind: "drydock", patchId: "patch-a" };
    await renderPanel("theater-a");

    const readerOptions = panelMocks.mountReaderInto.mock.calls.at(-1)?.[3] as { onDecided?: () => void } | undefined;
    expect(readerOptions?.onDecided).toBeTypeOf("function");
    readerOptions?.onDecided?.();

    expect(panelMocks.refreshCodexHealth).toHaveBeenCalledOnce();
  });

  it("refreshes navigator health after an expanded-reader drydock decision", async () => {
    panelMocks.consoleState.codexReader = { kind: "drydock", patchId: "patch-a" };
    panelMocks.consoleState.codexReaderExpanded = true;
    await act(async () => {
      root.render(createElement(CodexReadingSheet));
      await Promise.resolve();
    });

    const readerOptions = panelMocks.mountReaderInto.mock.calls.at(-1)?.[3] as { onDecided?: () => void } | undefined;
    expect(readerOptions?.onDecided).toBeTypeOf("function");
    readerOptions?.onDecided?.();

    expect(panelMocks.refreshCodexHealth).toHaveBeenCalledOnce();
  });

  it("preserves same-Theater remount state and closes the reader only after a Theater change", async () => {
    await renderPanel("theater-a");
    expect(panelMocks.closeCodexReader).not.toHaveBeenCalled();
    expect(container.querySelector(".codex-rail-host")).not.toBeNull();

    act(() => root.unmount());
    expect(panelMocks.saveReaderScroll).toHaveBeenCalledOnce();
    expect(panelMocks.teardownCodex).not.toHaveBeenCalled();

    root = createRoot(container);
    act(() => {
      root.render(codexPanel.render({ theaterId: "theater-a" } as never));
    });

    // 동일 Theater는 비동기 workspace 재해석 전에도 캐시된 navigator를 즉시 복원한다.
    expect(container.querySelector(".codex-rail-host")).not.toBeNull();
    await flushEffects();
    expect(panelMocks.closeCodexReader).not.toHaveBeenCalled();

    act(() => {
      root.render(codexPanel.render({ theaterId: "theater-b" } as never));
    });
    await flushEffects();

    expect(panelMocks.closeCodexReader).toHaveBeenCalledOnce();
    expect(panelMocks.setNavigatorTheater).toHaveBeenLastCalledWith("00000000000b");
  });
});

async function renderPanel(theaterId: string): Promise<void> {
  await act(async () => {
    root.render(codexPanel.render({ theaterId } as never));
    await Promise.resolve();
  });
  await flushEffects();
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
