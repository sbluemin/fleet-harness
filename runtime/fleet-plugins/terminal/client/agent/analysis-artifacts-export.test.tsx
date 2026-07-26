// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { initialAnalysisState, type AnalysisState } from "./analysis-state.js";

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
    vi.restoreAllMocks();
  });

  it("disables export without an active artifact", () => {
    const mounted = mountPanel();
    expect(mounted.container.querySelector<HTMLButtonElement>(".session-analyst__export")?.disabled).toBe(true);
    mounted.unmount();
  });

  it("opens the export menu with three menu items", () => {
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
    mounted.unmount();
  });

  it("downloads active HTML with a sanitized title", () => {
    storeState = withArtifact({ title: "  Résumé / Q&A  " });
    const createObjectURL = vi.fn(() => "blob:artifact");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const mounted = mountPanel();

    act(() => mounted.container.querySelector<HTMLButtonElement>(".session-analyst__export")!.click());
    act(() => [...mounted.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === "Download HTML")!.click());

    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledOnce();
    const anchor = click.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toBe("Résumé-Q-A.html");
    expect(anchor.href).toBe("blob:artifact");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:artifact");
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
  } as OperationRenderContext;
  act(() => root.render(createElement(AnalystArtifactsPanel, { context })));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}
