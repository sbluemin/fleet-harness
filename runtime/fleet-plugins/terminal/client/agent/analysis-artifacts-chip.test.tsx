// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { analysisReducer, initialAnalysisState, type AnalysisAction, type AnalysisState } from "./analysis-state.js";

vi.mock("@fleet-console/markdown/core", () => ({ renderMarkdown: (text: string) => ({ html: text }) }));
vi.mock("@fleet-console/markdown/mermaid", () => ({ installDiagramHydrator: vi.fn() }));

let storeState: AnalysisState;
const dispatch = vi.fn((action: AnalysisAction) => {
  storeState = analysisReducer(storeState, action);
});
vi.mock("./analysis-store.js", () => ({
  useAnalysisStore: () => ({
    state: storeState,
    dispatch: (action: AnalysisAction) => dispatch(action),
    send: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
  }),
}));

import { ANALYST_ARTIFACTS_COMPANION_ID, AnalystChatPanel } from "./analysis-chat-panel.js";

describe("Session Analyst Artifacts chip", () => {
  beforeEach(() => {
    storeState = initialAnalysisState;
    dispatch.mockClear();
  });

  it("re-arms the analysis store when artifacts are cleared or the session resets", () => {
    const disarmed = { ...withArtifacts(1), artifactsAutoOpenArmed: false };
    expect(analysisReducer(disarmed, { type: "clear-artifacts" })).toMatchObject({
      artifacts: [],
      artifactsAutoOpenArmed: true,
    });
    expect(analysisReducer(disarmed, { type: "reset" }).artifactsAutoOpenArmed).toBe(true);
  });

  it("stays absent on older hosts and renders the waiting contract on supporting hosts", () => {
    const legacy = mountPanel({ operationId: "op-a" } as OperationRenderContext);
    expect(legacy.container.querySelector('[aria-label="Open Artifacts"]')).toBeNull();
    legacy.unmount();

    const setVisible = vi.fn();
    const supported = mountPanel(contextWithVisibility([ANALYST_ARTIFACTS_COMPANION_ID], setVisible));
    const chip = supported.container.querySelector<HTMLButtonElement>('[aria-label="Open Artifacts"]')!;
    expect(chip.disabled).toBe(false);
    expect(chip.classList.contains("is-waiting")).toBe(true);
    expect(chip.title).toBe("Artifacts the analyst publishes appear here");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    expect(chip.tabIndex).toBe(-1);
    expect(chip.querySelector(".session-analyst__chip-chev")?.textContent).toBe("»");
    expect(chip.querySelector(".session-analyst__chip-count")).toBeNull();
    expect(setVisible).not.toHaveBeenCalled();
    supported.unmount();
  });

  it("auto-opens on the first artifact, then disarms after a user hide and pulses later counts", () => {
    const setVisible = vi.fn();
    const mounted = mountPanel(contextWithVisibility([ANALYST_ARTIFACTS_COMPANION_ID], setVisible));

    storeState = withArtifacts(1);
    mounted.render(contextWithVisibility([ANALYST_ARTIFACTS_COMPANION_ID], setVisible));
    expect(setVisible).toHaveBeenLastCalledWith(ANALYST_ARTIFACTS_COMPANION_ID, true);

    mounted.render(contextWithVisibility([], setVisible));
    const visibleChip = mounted.container.querySelector<HTMLButtonElement>('[aria-label="Hide Artifacts"]')!;
    expect(visibleChip.getAttribute("aria-pressed")).toBe("true");
    expect(visibleChip.querySelector(".session-analyst__chip-chev")?.textContent).toBe("«");
    act(() => visibleChip.click());
    expect(setVisible).toHaveBeenLastCalledWith(ANALYST_ARTIFACTS_COMPANION_ID, false);
    expect(storeState.artifactsAutoOpenArmed).toBe(false);

    setVisible.mockClear();
    mounted.render(contextWithVisibility([ANALYST_ARTIFACTS_COMPANION_ID], setVisible));
    storeState = withArtifacts(2);
    mounted.render(contextWithVisibility([ANALYST_ARTIFACTS_COMPANION_ID], setVisible));
    expect(setVisible).not.toHaveBeenCalled();
    const count = mounted.container.querySelector(".session-analyst__chip-count")!;
    expect(count.textContent).toBe("2");
    expect(count.classList.contains("is-pulsing")).toBe(true);
    mounted.unmount();
  });

  it("preserves a user disarm across a chat-panel remount", () => {
    const setVisible = vi.fn();
    storeState = withArtifacts(1);
    const mounted = mountPanel(contextWithVisibility([], setVisible));
    const visibleChip = mounted.container.querySelector<HTMLButtonElement>('[aria-label="Hide Artifacts"]')!;
    act(() => visibleChip.click());
    expect(storeState.artifactsAutoOpenArmed).toBe(false);
    mounted.unmount();

    setVisible.mockClear();
    const returned = mountPanel(contextWithVisibility([ANALYST_ARTIFACTS_COMPANION_ID], setVisible));
    expect(setVisible).not.toHaveBeenCalled();
    expect(returned.container.querySelector(".session-analyst__chip-count")?.textContent).toBe("1");
    returned.unmount();
  });

  it("closes and re-arms at zero, and opens immediately when remounted with stored artifacts", () => {
    const setVisible = vi.fn();
    storeState = { ...withArtifacts(1), artifactsAutoOpenArmed: false };
    const mounted = mountPanel(contextWithVisibility([], setVisible));

    storeState = { ...initialAnalysisState, artifactsAutoOpenArmed: false };
    mounted.render(contextWithVisibility([], setVisible));
    expect(setVisible).toHaveBeenLastCalledWith(ANALYST_ARTIFACTS_COMPANION_ID, false);
    expect(storeState.artifactsAutoOpenArmed).toBe(true);

    setVisible.mockClear();
    mounted.render(contextWithVisibility([ANALYST_ARTIFACTS_COMPANION_ID], setVisible));
    storeState = withArtifacts(1);
    mounted.render(contextWithVisibility([ANALYST_ARTIFACTS_COMPANION_ID], setVisible));
    expect(setVisible).toHaveBeenLastCalledWith(ANALYST_ARTIFACTS_COMPANION_ID, true);
    mounted.unmount();

    setVisible.mockClear();
    const reopened = mountPanel(contextWithVisibility([ANALYST_ARTIFACTS_COMPANION_ID], setVisible));
    expect(setVisible).toHaveBeenLastCalledWith(ANALYST_ARTIFACTS_COMPANION_ID, true);
    reopened.unmount();
  });

  it("returns focus from a cleared Artifacts pane to the waiting chip", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const setVisible = vi.fn();
    storeState = withArtifacts(1);
    const mounted = mountPanel(contextWithVisibility([], setVisible));
    const artifactsPane = document.createElement("section");
    artifactsPane.className = "session-analyst__artifacts";
    const focusedControl = document.createElement("button");
    artifactsPane.append(focusedControl);
    document.body.append(artifactsPane);
    focusedControl.focus();

    storeState = initialAnalysisState;
    mounted.render(contextWithVisibility([], setVisible));

    expect(setVisible).toHaveBeenLastCalledWith(ANALYST_ARTIFACTS_COMPANION_ID, false);
    expect(document.activeElement).toBe(mounted.container.querySelector('[aria-label="Open Artifacts"]'));
    artifactsPane.remove();
    mounted.unmount();
    vi.unstubAllGlobals();
  });
});

function withArtifacts(count: number): AnalysisState {
  return {
    ...initialAnalysisState,
    artifacts: Array.from({ length: count }, (_, index) => ({
      id: `artifact-${index}`,
      title: `Artifact ${index}`,
      html: `<p>${index}</p>`,
      createdAt: index,
    })),
  };
}

function contextWithVisibility(hiddenCompanionPanelIds: readonly string[], onSetCompanionPanelVisible: (companionPanelId: string, visible: boolean) => void): OperationRenderContext {
  return { operationId: "op-a", hiddenCompanionPanelIds, onSetCompanionPanelVisible } as OperationRenderContext;
}

function mountPanel(initialContext: OperationRenderContext): {
  readonly container: HTMLDivElement;
  readonly render: (context: OperationRenderContext) => void;
  readonly unmount: () => void;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  const render = (context: OperationRenderContext) => {
    act(() => root.render(createElement(AnalystChatPanel, { context })));
  };
  render(initialContext);
  return {
    container,
    render,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}
