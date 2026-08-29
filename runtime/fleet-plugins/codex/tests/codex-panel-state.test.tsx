// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const panelMocks = vi.hoisted(() => ({
  historyState: { canGoBack: false, canGoForward: false },
  documentState: { entryId: null as string | null, title: "" },
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

vi.mock("../client/codex-host.js", () => ({
  consumeRestoredReaderExpanded: vi.fn(() => false),
  getCodexReaderDocumentState: () => panelMocks.documentState,
  getCodexReaderHistoryState: () => panelMocks.historyState,
  getCodexReaderMarkdown: vi.fn(() => ""),
  setCodexReaderExpandedForSession: vi.fn(),
  setNavigatorTagFilter: vi.fn(),
  subscribeCodexReaderDocument: vi.fn(() => () => undefined),
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

vi.mock("../client/reader-store.js", () => ({
  useReaderState: () => panelMocks.consoleState,
  useConsoleLocale: () => "en",
  closeCodexReader: panelMocks.closeCodexReader,
  collapseCodexReader: vi.fn(),
  expandCodexReader: vi.fn(),
  openCodexReader: vi.fn(),
}));

vi.mock("../client/i18n/index.js", () => ({
  getT: () => (key: string) => key,
  useConsoleLocale: () => "en",
  useT: () => (key: string) => key,
}));

vi.mock("../client/codex/state.js", () => ({
  loadInitialData: vi.fn(),
  // 패널은 복귀 재검증을 위해 스토어를 읽는다 — 워크스페이스가 없으면 아무 요청도 나가지 않는다.
  getState: vi.fn(() => ({ currentWorkspaceId: null })),
  revalidateAll: vi.fn(async () => undefined),
  revalidateScopes: vi.fn(async () => undefined),
  setLiveState: vi.fn(),
  subscribeState: vi.fn(() => () => undefined),
}));

import { CodexReadingSheet } from "../client/codex-reading-sheet.js";
import { codexPanel } from "../client/codex-panel.js";

let container: HTMLDivElement;
let root: Root;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.clearAllMocks();
  panelMocks.consoleState.activeTheaterId = "theater-a";
  panelMocks.consoleState.codexReader = null;
  panelMocks.consoleState.codexReaderExpanded = false;
  // Theater는 경로가 아니라 본문이 싣는다 — 플러그인 라우트는 코어 소유 경로 밑에
  // 끼어들 수 없다. URL로 Theater를 가려내던 예전 스텁은 두 Theater를 구별하지 못한다.
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const requested = readRequestedTheaterId(init);
    const theaterId = requested === "theater-b" ? "b" : "a";
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

function readRequestedTheaterId(init?: RequestInit): string | null {
  if (typeof init?.body !== "string") return null;
  try {
    const parsed = JSON.parse(init.body) as { readonly theaterId?: unknown };
    return typeof parsed.theaterId === "string" ? parsed.theaterId : null;
  } catch {
    return null;
  }
}

describe("Codex rail panel workspace request", () => {
  // Codex가 플러그인이 되며 서버 라우트는 이름공간으로 옮겼는데 클라이언트가 따라오지
  // 않아, 모든 Theater에서 패널이 "Fleet Wiki data could not be loaded"만 띄웠다.
  // 서버 라우트만 검사하면 이 갈라짐이 보이지 않는다 — 부르는 쪽을 못 박는다.
  it("asks the plugin's own route and carries the Theater in the body", async () => {
    await act(async () => {
      root.render(codexPanel.render?.({ theaterId: "theater-a" } as never) ?? null);
    });

    const calls = vi.mocked(globalThis.fetch).mock.calls;
    const workspaceCall = calls.find(([input]) => String(input).includes("workspace"));
    expect(workspaceCall, "the panel never requested a Codex workspace").toBeDefined();

    const [url, init] = workspaceCall!;
    expect(String(url)).toBe("/api/v1/plugins/codex/workspace");
    expect(String(url)).not.toMatch(/^\/api\/v1\/theaters\//);
    expect(init?.method).toBe("POST");
    expect(readRequestedTheaterId(init)).toBe("theater-a");
  });
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
      root.render(codexPanel.render?.({ theaterId: "theater-a" } as never) ?? null);
    });

    // 동일 Theater는 비동기 workspace 재해석 전에도 캐시된 navigator를 즉시 복원한다.
    expect(container.querySelector(".codex-rail-host")).not.toBeNull();
    await flushEffects();
    expect(panelMocks.closeCodexReader).not.toHaveBeenCalled();

    act(() => {
      root.render(codexPanel.render?.({ theaterId: "theater-b" } as never));
    });
    await flushEffects();

    expect(panelMocks.closeCodexReader).toHaveBeenCalledOnce();
    expect(panelMocks.setNavigatorTheater).toHaveBeenLastCalledWith("00000000000b");
  });

  it("resynchronizes the collapsed outline spine from the relocated TOC after expanded view", async () => {
    // 실제 relocate처럼 mountReaderInto가 TOC 슬롯을 현재 활성 표식으로 채운다.
    let activeHeading = "Goals";
    panelMocks.mountReaderInto.mockImplementation((...args: unknown[]) => {
      const toc = args[1] as HTMLElement;
      toc.innerHTML = `<a class="ti active" aria-current="location">${activeHeading}</a>`;
    });
    panelMocks.consoleState.codexReader = { kind: "entry", entryId: "entry-a" } as never;
    await renderPanel("theater-a");
    expect(container.querySelector(".codex-doc-outline-current")?.textContent).toBe("Goals");

    // 덱(확대) 동안 다른 섹션/엔트리로 이동해 TOC 활성 표식이 바뀌었다.
    panelMocks.consoleState.codexReaderExpanded = true;
    await renderPanel("theater-a");
    expect(container.querySelector(".codex-doc-outline-current")).toBeNull();
    activeHeading = "Problem";

    // 접기 복귀 시 리스너 재부착만으로는 낡은 "Goals"가 남는다 — 재배치된 TOC에서 재동기화되어야 한다.
    panelMocks.consoleState.codexReaderExpanded = false;
    await renderPanel("theater-a");
    expect(container.querySelector(".codex-doc-outline-current")?.textContent).toBe("Problem");
  });
});

async function renderPanel(theaterId: string): Promise<void> {
  await act(async () => {
    root.render(codexPanel.render?.({ theaterId } as never));
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
