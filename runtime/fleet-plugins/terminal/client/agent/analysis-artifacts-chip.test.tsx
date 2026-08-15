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

import { AnalystChatPanel } from "./analysis-chat-panel.js";

describe("Session Analyst artifacts mode", () => {
  beforeEach(() => {
    storeState = initialAnalysisState;
    dispatch.mockClear();
  });

  it("clears artifacts together with the completion card", () => {
    expect(analysisReducer(withArtifacts(2), { type: "clear-artifacts" })).toMatchObject({
      artifacts: [],
      artifactPublished: null,
    });
  });

  it("keeps the artifacts segment disabled until an artifact exists, then shows the count badge", () => {
    const mounted = mountPanel(baseContext());
    const segment = artifactsSegment(mounted.container);
    expect(segment.disabled).toBe(true);
    expect(segment.getAttribute("aria-pressed")).toBe("false");
    expect(segment.title).toBe("Artifacts the analyst publishes appear here");
    expect(mounted.container.querySelector(".session-analyst__chip-count")).toBeNull();
    expect(mounted.container.querySelector(".session-analyst__artifacts")).toBeNull();

    storeState = withArtifacts(1);
    mounted.render(baseContext());
    const enabled = artifactsSegment(mounted.container);
    expect(enabled.disabled).toBe(false);
    expect(enabled.querySelector(".session-analyst__chip-count")?.textContent).toBe("1");
    mounted.unmount();
  });

  it("switches between the chat and artifacts modes inside the single drawer", () => {
    storeState = withArtifacts(1);
    const mounted = mountPanel(baseContext());
    expect(mounted.container.querySelector(".session-analyst__workspace")).not.toBeNull();

    act(() => artifactsSegment(mounted.container).click());
    expect(mounted.container.querySelector(".session-analyst__artifacts")).not.toBeNull();
    expect(mounted.container.querySelector(".session-analyst__workspace")).toBeNull();
    expect(artifactsSegment(mounted.container).getAttribute("aria-pressed")).toBe("true");

    const chatSegment = mounted.container.querySelector<HTMLButtonElement>('.session-analyst__modechip button')!;
    act(() => chatSegment.click());
    expect(mounted.container.querySelector(".session-analyst__workspace")).not.toBeNull();
    expect(mounted.container.querySelector(".session-analyst__artifacts")).toBeNull();
    mounted.unmount();
  });

  it("pulses the count badge for later artifacts while staying in the chat mode", () => {
    storeState = withArtifacts(1);
    const mounted = mountPanel(baseContext());
    storeState = withArtifacts(2);
    mounted.render(baseContext());
    const count = mounted.container.querySelector(".session-analyst__chip-count")!;
    expect(count.textContent).toBe("2");
    expect(count.classList.contains("is-pulsing")).toBe(true);
    expect(mounted.container.querySelector(".session-analyst__artifacts")).toBeNull();
    mounted.unmount();
  });

  it("returns to the chat mode and refocuses the segment when artifacts are cleared", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    storeState = withArtifacts(1);
    const mounted = mountPanel(baseContext());
    act(() => artifactsSegment(mounted.container).click());
    const inside = mounted.container.querySelector<HTMLButtonElement>(".session-analyst__artifacts button")!;
    act(() => inside.focus());

    storeState = initialAnalysisState;
    mounted.render(baseContext());
    expect(mounted.container.querySelector(".session-analyst__workspace")).not.toBeNull();
    expect(document.activeElement).toBe(mounted.container.querySelector(".session-analyst__modechip button"));
    mounted.unmount();
    vi.unstubAllGlobals();
  });
});

function artifactsSegment(container: HTMLElement): HTMLButtonElement {
  const buttons = container.querySelectorAll<HTMLButtonElement>(".session-analyst__modechip button");
  return buttons[buttons.length - 1]!;
}

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

function baseContext(): OperationRenderContext {
  return { operationId: "op-a", theme: "instrument" } as unknown as OperationRenderContext;
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
