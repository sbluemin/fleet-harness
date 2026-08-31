// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { initialAnalysisState, type AnalysisState } from "./analysis-state.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let storeState: AnalysisState;
vi.mock("./analysis-store.js", () => ({
  useAnalysisStore: () => ({
    state: storeState,
    dispatch: vi.fn(),
  }),
}));

import { AnalystArtifactsPanel } from "./analysis-artifacts-panel.js";

describe("Session Analyst artifact export", () => {
  beforeEach(() => {
    storeState = initialAnalysisState;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("disables export without an active artifact", () => {
    const mounted = mountPanel();
    expect(mounted.container.querySelector<HTMLButtonElement>(".session-analyst__export")?.disabled).toBe(true);
    mounted.unmount();
  });

  it("focuses the first item and cycles menu keyboard navigation", () => {
    storeState = withArtifact();
    const mounted = mountPanel();
    const exportButton = mounted.container.querySelector<HTMLButtonElement>(".session-analyst__export")!;

    act(() => exportButton.click());

    expect(exportButton.getAttribute("aria-expanded")).toBe("true");
    const menu = mounted.container.querySelector('[role="menu"]')!;
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual([
      "Download HTML",
      "Copy source",
      "Open in new tab",
    ]);
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(document.activeElement).toBe(items[0]);
    act(() => items[0]!.dispatchEvent(keydown("ArrowDown")));
    expect(document.activeElement).toBe(items[1]);
    act(() => items[1]!.dispatchEvent(keydown("ArrowDown")));
    expect(document.activeElement).toBe(items[2]);
    act(() => items[2]!.dispatchEvent(keydown("ArrowDown")));
    expect(document.activeElement).toBe(items[0]);
    act(() => items[0]!.dispatchEvent(keydown("ArrowUp")));
    expect(document.activeElement).toBe(items[2]);
    act(() => items[2]!.dispatchEvent(keydown("Home")));
    expect(document.activeElement).toBe(items[0]);
    act(() => items[0]!.dispatchEvent(keydown("End")));
    expect(document.activeElement).toBe(items[2]);
    act(() => items[2]!.dispatchEvent(keydown("Escape")));
    expect(mounted.container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(exportButton);
    mounted.unmount();
  });

  it("closes on Tab without cancelling natural focus progression", () => {
    storeState = withArtifact();
    const mounted = mountPanel();
    act(() => mounted.container.querySelector<HTMLButtonElement>(".session-analyst__export")!.click());
    const firstItem = mounted.container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;

    let proceeds = false;
    act(() => {
      proceeds = firstItem.dispatchEvent(keydown("Tab"));
    });

    expect(proceeds).toBe(true);
    expect(mounted.container.querySelector('[role="menu"]')).toBeNull();
    mounted.unmount();
  });

  it("downloads the host-wrapped document with a sanitized title", async () => {
    storeState = withArtifact({ title: "  Résumé / Q&A  ", html: "<main>author source</main>" });
    const { createObjectURL, revokeObjectURL, click, fetchDocument } = stubDownload();
    const mounted = mountPanel();
    const exportButton = mounted.container.querySelector<HTMLButtonElement>(".session-analyst__export")!;

    act(() => exportButton.click());
    await clickMenuItem(mounted.container, "Download HTML");

    // 내려받은 파일은 자립해야 한다 — 테마 토큰과 바닥 스타일을 실은 호스트 문서를 저장한다.
    expect(fetchDocument).toHaveBeenCalledWith(expect.stringContaining("/plugins/terminal/analysis/artifacts/artifact-active"));
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    await expect(downloadedText(createObjectURL)).resolves.toBe(HOST_DOCUMENT);
    expect(click).toHaveBeenCalledOnce();
    const anchor = click.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toBe("Résumé-Q-A.html");
    expect(anchor.href).toBe("blob:artifact");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:artifact");
    expect(document.activeElement).toBe(exportButton);
    mounted.unmount();
  });

  it("refuses to export the author source when the host document cannot be fetched", async () => {
    storeState = withArtifact({ title: "Offline", html: "<main>author source</main>" });
    const { createObjectURL, click } = stubDownload(async () => { throw new Error("offline"); });
    const mounted = mountPanel();

    act(() => mounted.container.querySelector<HTMLButtonElement>(".session-analyst__export")!.click());
    await clickMenuItem(mounted.container, "Download HTML");

    // 보호되지 않은 원본을 대신 저장하면 내려받은 사본이 오프라인 계약 밖으로 나간다.
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    // 조용히 실패하지 않는다 — 메뉴는 열린 채 그 자리에서 사실을 말한다.
    expect(mounted.container.querySelector('[role="menu"]')?.textContent).toContain("Download unavailable");
    mounted.unmount();
  });

  it("clears the download failure notice when the menu is reopened", async () => {
    storeState = withArtifact({ title: "Offline" });
    stubDownload(async () => ({ ok: false, text: async () => "" }));
    const mounted = mountPanel();
    const exportButton = mounted.container.querySelector<HTMLButtonElement>(".session-analyst__export")!;

    act(() => exportButton.click());
    await clickMenuItem(mounted.container, "Download HTML");
    expect(mounted.container.querySelector('[role="menu"]')?.textContent).toContain("Download unavailable");

    act(() => exportButton.click());
    act(() => exportButton.click());

    expect(mounted.container.querySelector('[role="menu"]')?.textContent).toContain("Download HTML");
    mounted.unmount();
  });

  it("falls back to artifact.html for a punctuation-only title", async () => {
    storeState = withArtifact({ title: "..." });
    const { click } = stubDownload();
    const mounted = mountPanel();

    act(() => mounted.container.querySelector<HTMLButtonElement>(".session-analyst__export")!.click());
    await clickMenuItem(mounted.container, "Download HTML");

    expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe("artifact.html");
    mounted.unmount();
  });

  it("copies the active artifact HTML", async () => {
    storeState = withArtifact({ html: "<main>active source</main>" });
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const mounted = mountPanel();

    act(() => mounted.container.querySelector<HTMLButtonElement>(".session-analyst__export")!.click());
    await act(async () => {
      [...mounted.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === "Copy source")!.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("<main>active source</main>");
    expect(mounted.container.querySelector('[role="menu"]')?.textContent).toContain("Copied");
    const exportButton = mounted.container.querySelector<HTMLButtonElement>(".session-analyst__export")!;
    act(() => exportButton.click());
    act(() => exportButton.click());
    expect(mounted.container.querySelector('[role="menu"]')?.textContent).toContain("Copy source");
    mounted.unmount();
  });

  it("closes quietly when clipboard writing rejects", async () => {
    storeState = withArtifact();
    const writeText = vi.fn(async () => { throw new Error("denied"); });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const mounted = mountPanel();
    const exportButton = mounted.container.querySelector<HTMLButtonElement>(".session-analyst__export")!;

    act(() => exportButton.click());
    await act(async () => {
      [...mounted.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === "Copy source")!.click();
      await Promise.resolve();
    });

    expect(mounted.container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(exportButton);
    mounted.unmount();
  });

  it("opens the active artifact in a noopener tab", () => {
    storeState = withArtifact();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const mounted = mountPanel();
    const exportButton = mounted.container.querySelector<HTMLButtonElement>(".session-analyst__export")!;

    act(() => exportButton.click());
    act(() => [...mounted.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === "Open in new tab")!.click());

    expect(open).toHaveBeenCalledWith(
      "/plugins/terminal/analysis/artifacts/artifact-active?theme=dark&canvas=Canvas&foreground=CanvasText",
      "_blank",
      "noopener",
    );
    expect(document.activeElement).toBe(exportButton);
    mounted.unmount();
  });

  it("clears Copied and its timer when the active artifact changes", async () => {
    vi.useFakeTimers();
    storeState = withArtifact();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const mounted = mountPanel();

    act(() => mounted.container.querySelector<HTMLButtonElement>(".session-analyst__export")!.click());
    const baselineTimerCount = vi.getTimerCount();
    await act(async () => {
      [...mounted.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === "Copy source")!.click();
      await Promise.resolve();
    });
    expect(mounted.container.querySelector('[role="menu"]')?.textContent).toContain("Copied");
    const copiedTimerCount = vi.getTimerCount();
    expect(copiedTimerCount).toBeGreaterThan(baselineTimerCount);

    storeState = withArtifact({ id: "artifact-next", title: "Next artifact" });
    mounted.render();

    expect(mounted.container.querySelector('[role="menu"]')?.textContent).toContain("Copy source");
    expect(vi.getTimerCount()).toBeLessThan(copiedTimerCount);
    mounted.unmount();
  });

  it("does not create copy feedback after unmount", async () => {
    vi.useFakeTimers();
    storeState = withArtifact();
    let resolveWrite: (() => void) | undefined;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { resolveWrite = resolve; }));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const mounted = mountPanel();

    act(() => mounted.container.querySelector<HTMLButtonElement>(".session-analyst__export")!.click());
    act(() => {
      [...mounted.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === "Copy source")!.click();
    });
    mounted.unmount();
    const timerCountAfterUnmount = vi.getTimerCount();

    await act(async () => {
      resolveWrite?.();
      await Promise.resolve();
    });

    expect(vi.getTimerCount()).toBe(timerCountAfterUnmount);
  });

  it("ignores clipboard completion that started in an earlier menu instance", async () => {
    storeState = withArtifact();
    let resolveWrite: (() => void) | undefined;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { resolveWrite = resolve; }));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const mounted = mountPanel();
    const exportButton = mounted.container.querySelector<HTMLButtonElement>(".session-analyst__export")!;

    act(() => exportButton.click());
    act(() => {
      [...mounted.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === "Copy source")!.click();
    });
    act(() => exportButton.click());
    act(() => exportButton.click());

    await act(async () => {
      resolveWrite?.();
      await Promise.resolve();
    });

    const menu = mounted.container.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain("Copy source");
    expect(menu?.textContent).not.toContain("Copied");
    mounted.unmount();
  });

  it("ignores clipboard completion targeting a previously active artifact", async () => {
    storeState = withArtifact();
    let resolveWrite: (() => void) | undefined;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { resolveWrite = resolve; }));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const mounted = mountPanel();

    act(() => mounted.container.querySelector<HTMLButtonElement>(".session-analyst__export")!.click());
    act(() => {
      [...mounted.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === "Copy source")!.click();
    });

    storeState = withArtifact({ id: "artifact-next", title: "Next artifact" });
    mounted.render();

    await act(async () => {
      resolveWrite?.();
      await Promise.resolve();
    });

    const menu = mounted.container.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain("Copy source");
    expect(menu?.textContent).not.toContain("Copied");
    mounted.unmount();
  });

  it("ignores clipboard rejection that started in an earlier menu instance", async () => {
    storeState = withArtifact();
    let rejectWrite: ((reason: Error) => void) | undefined;
    const writeText = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectWrite = reject; }));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const mounted = mountPanel();
    const exportButton = mounted.container.querySelector<HTMLButtonElement>(".session-analyst__export")!;

    act(() => exportButton.click());
    act(() => {
      [...mounted.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === "Copy source")!.click();
    });
    act(() => exportButton.click());
    act(() => exportButton.click());

    await act(async () => {
      rejectWrite?.(new Error("denied"));
      await Promise.resolve();
    });

    expect(mounted.container.querySelector('[role="menu"]')).not.toBeNull();
    mounted.unmount();
  });
});

function withArtifact(overrides: Partial<AnalysisState["artifacts"][number]> = {}): AnalysisState {
  return {
    ...initialAnalysisState,
    artifacts: [{
      id: "artifact-active",
      title: "Artifact",
      html: "<p>artifact</p>",
      createdAt: 1,
      ...overrides,
    }],
  };
}

function mountPanel(): {
  readonly container: HTMLDivElement;
  readonly render: () => void;
  readonly unmount: () => void;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  const context = {
    operationId: "artifact-export-test",
    language: "en",
    theme: "dark",
    api: {},
  } as unknown as OperationRenderContext;
  const render = () => {
    act(() => root.render(createElement(AnalystArtifactsPanel, { context })));
  };
  render();
  return {
    container,
    render,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function keydown(key: string): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
}

// 반환 타입은 추론에 맡긴다 — `vi.spyOn`의 인스턴스화 표현식은 접근자 오버로드를 먼저 집어
// 메서드 키인 "click"을 제약 위반으로 판정한다.
const HOST_DOCUMENT = "<!doctype html><html><head><style>:root{--fleet-ink:#efefef}</style></head><body><main>hosted</main></body></html>";

function stubDownload(fetchImpl?: () => Promise<unknown>) {
  const createObjectURL = vi.fn(() => "blob:artifact");
  const revokeObjectURL = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const fetchDocument = vi.fn(fetchImpl ?? (async () => ({ ok: true, text: async () => HOST_DOCUMENT })));
  vi.stubGlobal("fetch", fetchDocument);
  return { createObjectURL, revokeObjectURL, click, fetchDocument };
}

async function clickMenuItem(container: HTMLElement, label: string): Promise<void> {
  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === label)!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function downloadedText(createObjectURL: ReturnType<typeof vi.fn>): Promise<string> {
  return await (createObjectURL.mock.calls[0]![0] as Blob).text();
}
