// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import type { AnalysisEvent } from "./analysis-types.js";
import { analysisReducer, initialAnalysisState, type AnalysisAction, type AnalysisState } from "./analysis-state.js";

const { installDiagramHydratorSpy, renderMarkdownSpy } = vi.hoisted(() => ({
  installDiagramHydratorSpy: vi.fn(),
  renderMarkdownSpy: vi.fn(),
}));

vi.mock("@fleet-console/markdown/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fleet-console/markdown/core")>();
  return {
    ...actual,
    renderMarkdown: (...args: Parameters<typeof actual.renderMarkdown>) => {
      renderMarkdownSpy(...args);
      return actual.renderMarkdown(...args);
    },
  };
});
vi.mock("@fleet-console/markdown/mermaid", () => ({ installDiagramHydrator: installDiagramHydratorSpy }));

let storeState: AnalysisState;
let rerenderStore = () => {};
const send = vi.fn(async () => undefined);
const stop = vi.fn(async () => undefined);
const reset = vi.fn(async () => undefined);
const dispatch = vi.fn((action: AnalysisAction) => {
  storeState = analysisReducer(storeState, action);
  rerenderStore();
});
// 패널이 열릴 때 카탈로그를 다시 읽으므로 목도 같은 자리를 제공한다. 함수 정체성은 고정한다 —
// 매 렌더 새 함수를 주면 그 효과가 매 렌더 다시 돈다.
const refreshCatalog = vi.fn();
vi.mock("./analysis-store.js", () => ({
  useAnalysisStore: () => ({ state: storeState, dispatch, send, stop, reset, refreshCatalog }),
}));

import { AnalystCaption, AnalystChatPanel } from "./analysis-chat-panel.js";
import {
  ANALYST_CHAT_COMPANION_ID,
} from "./analysis-visibility.js";

const catalog = { clis: [{ cliId: "claude", label: "Claude", available: true, defaultModel: "gpt", models: [{ id: "gpt", label: "GPT", effortLevels: ["medium"], defaultEffort: "medium" }] }] };

describe("Session Analyst Evidence Pulse", () => {
  beforeEach(() => {
    send.mockClear();
    stop.mockClear();
    reset.mockClear();
    dispatch.mockClear();
    renderMarkdownSpy.mockClear();
    installDiagramHydratorSpy.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps the initial settings inside the one prompt surface", () => {
    storeState = {
      ...initialAnalysisState,
      catalog,
      cliId: "claude",
      model: "gpt",
      effort: "medium",
    };
    const { container, root } = renderPanel();
    const composer = container.querySelector(".session-analyst__composer")!;
    const surface = composer.querySelector(".session-analyst__composer-surface")!;
    const tools = surface.querySelector(".session-analyst__composer-tools")!;

    expect(container.querySelector(".session-analyst__chat-pane")?.classList.contains("is-initial")).toBe(true);
    expect(composer.classList.contains("is-initial")).toBe(true);
    // 컴포저는 한 장이다 — 선택 줄이 자기 테두리 상자로 떨어져 나오면 창이 두 장으로 읽힌다.
    expect(container.querySelector(".session-analyst__selector-strip")).toBeNull();
    expect(tools.parentElement).toBe(surface);
    // 공급자 축은 고를 것이 하나뿐이면 컨트롤이 되지 않는다.
    expect(tools.querySelectorAll(".fc-select__trigger")).toHaveLength(0);
    expect(tools.querySelector('[aria-label="Analysis CLI"]')).toBeNull();
    expect(tools.querySelector('[aria-label="Analysis model"]')).not.toBeNull();
    expect(tools.querySelector('[aria-label="Analysis effort"]')).not.toBeNull();
    expect(tools.querySelector(".session-analyst__model-chip")).not.toBeNull();
    expect(tools.querySelector(".effort-track")).not.toBeNull();
    expect(tools.querySelector(".session-analyst__slash-hint")).not.toBeNull();
    expect(surface.querySelector("textarea")?.rows).toBe(1);
    expect(tools.querySelector(".session-analyst__send")?.getAttribute("aria-label")).toBe("Send");
    expect(container.querySelector(".session-analyst__composer-meta")).toBeNull();
    expect((container.querySelector('[aria-label="Reset Session Analyst"]') as HTMLButtonElement).disabled).toBe(true);

    act(() => root.unmount());
    container.remove();
  });

  it("shows the provider control only when more than one CLI is offered", () => {
    const twoClis = { clis: [catalog.clis[0]!, { ...catalog.clis[0]!, cliId: "other", label: "Other" }] };
    storeState = { ...initialAnalysisState, catalog: twoClis, cliId: "claude", model: "gpt", effort: "medium" };
    const { container, root } = renderPanel();
    const tools = container.querySelector(".session-analyst__composer-tools")!;

    expect(tools.querySelectorAll(".fc-select__trigger")).toHaveLength(1);
    expect(tools.querySelector('[aria-label="Analysis CLI"]')).not.toBeNull();
    expect(tools.querySelector(".session-analyst__model-chip")).not.toBeNull();
    expect(tools.querySelector(".effort-track")).not.toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it("switches panel copy live with context language and shows a fixed-slot save confirmation", async () => {
    storeState = {
      ...initialAnalysisState,
      catalog,
      cliId: "claude",
      model: "gpt",
      effort: "medium",
      selectionSaved: true,
    };
    const koreanContext = { operationId: "chat-test", language: "ko" } as OperationRenderContext;
    const { container, root } = renderPanel(koreanContext);
    const saved = container.querySelector<HTMLElement>('[aria-live="polite"][aria-atomic="true"]')!;

    expect(container.querySelector('[aria-label="Session Analyst 채팅"]')).not.toBeNull();
    expect(container.querySelector(".session-analyst__hero h2")?.textContent).toBe("이 세션에 대해 물어보세요");
    expect(container.querySelector('[aria-label="분석 모델"]')).not.toBeNull();
    expect(container.querySelector("textarea")?.placeholder).toBe("세션에 대해 질문하기… (/ 명령)");
    expect(container.querySelector(".session-analyst__send")?.getAttribute("aria-label")).toBe("보내기");
    expect(saved.textContent).toBe("저장됨");
    expect(saved.classList.contains("session-analyst__saved")).toBe(true);
    expect(saved.style.opacity).toBe("1");
    expect(saved.style.transition).toBe("opacity var(--duration-base) var(--ease-glide)");

    const suggestion = [...container.querySelectorAll<HTMLButtonElement>(".session-analyst__suggestions button")]
      .find((button) => button.textContent?.includes("에이전트가 지금 무엇을 하고 있어?"))!;
    await act(async () => suggestion.click());
    expect(send).toHaveBeenCalledWith("에이전트가 지금 무엇을 하고 있어?");

    act(() => renderSlots(root, { operationId: "chat-test", language: "en" } as OperationRenderContext));
    expect(container.querySelector('[aria-label="Session Analyst chat"]')).not.toBeNull();
    expect(container.querySelector(".session-analyst__hero h2")?.textContent).toBe("Ask about this session");

    act(() => root.unmount());
    container.remove();
  });

  it("disables every selection control while reset holds the selection lock and re-enables it after release", () => {
    storeState = {
      ...initialAnalysisState,
      catalog,
      cliId: "claude",
      model: "gpt",
      effort: "medium",
      selectionLocked: true,
    };
    const { container, root } = renderPanel();
    const modelChip = () => container.querySelector<HTMLButtonElement>(".session-analyst__model-chip")!;
    const effort = () => container.querySelector<HTMLElement>(".session-analyst__effort")!;

    expect(modelChip().disabled).toBe(true);
    expect(effort().hasAttribute("inert")).toBe(true);

    storeState = { ...storeState, selectionLocked: false };
    act(() => rerenderStore());
    expect(modelChip().disabled).toBe(false);
    expect(effort().hasAttribute("inert")).toBe(false);

    act(() => root.unmount());
    container.remove();
  });

  it("keeps the transcript fully visible with one Stop and event-truthful tool activity", () => {
    storeState = {
      ...initialAnalysisState,
      catalog,
      cliId: "claude",
      model: "gpt",
      effort: "medium",
      started: true,
      busy: true,
      phase: "tool",
      latestActivity: { kind: "tool", title: "wiki_read", status: "running" },
      runStartedAt: Date.now() - 3_000,
      entries: [{ role: "user", text: "Review this" }],
      tools: [{ title: "wiki_read", status: "running" }],
    };
    const { container, root } = renderPanel();

    expect(container.querySelector(".session-analyst__chip-state")?.textContent).toContain("Analyzing");
    expect(container.querySelector(".session-analyst__pulse")?.textContent).toContain("Using wiki_read");
    expect(container.querySelector(".session-analyst__pulse")?.textContent).toContain("Tool status: running");
    // 도는 동안의 시계와 펄스 문구는 채팅 원장과 같은 명도 물결을 진다 — 두 면이 같은 사실을
    // 말하므로 어휘가 갈리면 안 된다. 오류일 때는 물결을 걷는다(진행이 아니라 결말이다).
    expect(container.querySelector(".session-analyst__turn-head .session-analyst__live-text")).not.toBeNull();
    expect(container.querySelector(".session-analyst__pulse-copy strong")?.classList.contains("session-analyst__live-text")).toBe(true);
    expect(container.querySelector(".session-analyst__chat ol")?.classList.contains("is-dimmed")).toBe(false);
    expect(container.querySelector("textarea")?.disabled).toBe(false);
    expect(container.querySelectorAll("select")).toHaveLength(0);
    expect(container.querySelectorAll(".session-analyst__composer-tools .fc-select__trigger")).toHaveLength(0);
    expect(container.querySelectorAll(".session-analyst__stop")).toHaveLength(1);
    expect(container.querySelectorAll(".session-analyst__send")).toHaveLength(2);
    expect(container.querySelector(".session-analyst__stop")?.getAttribute("aria-label")).toBe("Stop");
    expect(container.querySelector(".session-analyst__stop")?.textContent).toBe("");
    expect((container.querySelector('[aria-label="Reset Session Analyst"]') as HTMLButtonElement).disabled).toBe(false);
    expect(container.textContent).not.toContain("private chain of thought");

    act(() => root.unmount());
    container.remove();
  });

  it("shows live artifact authoring, publishes the completion card, and opens Artifacts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const context = { operationId: "chat-test", theme: "instrument" } as unknown as OperationRenderContext;
    storeState = analysisReducer(initialAnalysisState, { type: "sending", started: true, text: "Publish this", now: Date.now() });
    const { container, root } = renderPanel(context);

    emit({ type: "tool", title: "mcp__session_analyst__publish_artifact", status: "pending" });
    const authoring = container.querySelector<HTMLElement>(".session-analyst__author-card.is-authoring")!;
    expect(authoring.hasAttribute("aria-live")).toBe(false);
    expect(authoring.textContent).toContain("Publishing an artifact");
    expect(authoring.textContent).toContain("The analyst is authoring artifact content. It opens in Artifacts when it lands.");
    expect(authoring.previousElementSibling?.classList.contains("session-analyst__transcript")).toBe(true);
    expect(container.querySelector(".session-analyst__transcript .session-analyst__pulse")).not.toBeNull();
    const segments = container.querySelectorAll<HTMLButtonElement>(".session-analyst__modechip button");
    const artifactsSegment = segments[segments.length - 1]!;
    expect(artifactsSegment.classList.contains("is-authoring")).toBe(true);
    expect(artifactsSegment.querySelector(".session-analyst__chip-count")?.textContent).toBe("…");
    expect(artifactsSegment.title).toBe("The analyst is authoring an artifact…");

    act(() => vi.advanceTimersByTime(2_100));
    expect(authoring.querySelector(".session-analyst__author-time")?.textContent).toBe("2s");

    emit({ type: "artifact", artifact: { id: "artifact", title: "Session brief", html: "<p>brief</p>", createdAt: Date.now() } });
    const done = container.querySelector<HTMLElement>(".session-analyst__author-card.is-done")!;
    expect(done.textContent).toContain("Artifact published — Session brief");
    expect(done.querySelector(".session-analyst__author-time")?.textContent).toBe("2s");
    expect(done.querySelector(".session-analyst__author-sub")).toBeNull();
    expect(done.querySelector(".session-analyst__author-track")).toBeNull();

    act(() => (done.querySelector(".session-analyst__author-open") as HTMLButtonElement).click());
    expect(container.querySelector(".session-analyst__artifacts")).not.toBeNull();
    expect(container.querySelector(".session-analyst__workspace")).toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it("renders only analyst responses as sanitized compact Markdown and reports code copy truthfully", async () => {
    let resolveCopy!: () => void;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { resolveCopy = resolve; }));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    storeState = {
      ...initialAnalysisState,
      started: true,
      phase: "complete",
      entries: [
        { role: "user", text: "Keep **this prompt** <em>verbatim</em>" },
        { role: "analyst", text: "**Visible answer** <img src=x onerror=alert(1)>\n\n```ts\nconst answer = 42;\n```\n\n```js\nconst missing = true;\n```\n\n```sh\nfalse\n```" },
      ],
    };
    const { container, root } = renderPanel();
    const user = container.querySelector<HTMLElement>(".session-analyst__ask-bubble")!;
    const response = container.querySelector<HTMLElement>(".session-analyst__response.markdown-body")!;

    expect(user.textContent).toBe("Keep **this prompt** <em>verbatim</em>");
    expect(user.querySelector("strong, em")).toBeNull();
    expect(response.querySelector("strong")?.textContent).toBe("Visible answer");
    expect(response.querySelector("img")?.getAttribute("src")).toBe("x");
    expect(response.querySelector("img")?.hasAttribute("onerror")).toBe(false);

    const [copy, missing, rejecting] = [...response.querySelectorAll<HTMLButtonElement>('[data-action="copy-code"]')];
    const code = copy!.closest("pre")?.getAttribute("data-code");
    act(() => copy!.click());
    expect(writeText).toHaveBeenCalledWith(code);
    expect(copy!.textContent).toBe("Copy");
    await act(async () => { resolveCopy(); await Promise.resolve(); });
    expect(copy!.textContent).toBe("Copied");

    vi.stubGlobal("navigator", {});
    act(() => missing!.click());
    expect(missing!.textContent).toBe("Copy");

    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(() => Promise.reject(new Error("denied"))) } });
    act(() => rejecting!.click());
    await act(async () => { await Promise.resolve(); });
    expect(rejecting!.textContent).toBe("Copy");

    act(() => root.unmount());
    container.remove();
  });

  it("keeps ordered and nested Markdown lists semantic inside the transcript root", () => {
    storeState = {
      ...initialAnalysisState,
      started: true,
      phase: "complete",
      entries: [{ role: "analyst", text: "1. First\n2. Second\n\n   - Nested detail" }],
    };
    const { container, root } = renderPanel();
    const transcript = container.querySelector<HTMLOListElement>(".session-analyst__chat > ol.session-analyst__transcript")!;
    const response = transcript.querySelector<HTMLElement>(".session-analyst__response")!;
    const ordered = response.querySelector<HTMLOListElement>("ol")!;

    expect(transcript).not.toBe(ordered);
    expect(ordered.children).toHaveLength(2);
    expect(ordered.querySelector("ul li")?.textContent).toBe("Nested detail");

    act(() => root.unmount());
    container.remove();
  });

  it("coalesces rapid Markdown chunks, commits the latest final output, and memoizes completion", () => {
    vi.useFakeTimers();
    storeState = {
      ...initialAnalysisState,
      started: true,
      busy: true,
      phase: "writing",
      latestActivity: { kind: "writing" },
      entries: [
        { role: "user", text: "Stream this" },
        { role: "analyst", text: "Rapid start" },
      ],
    };
    const { container, root } = renderPanel();
    const responseRenderCount = () => renderMarkdownSpy.mock.calls.filter(([text]) => String(text).startsWith("Rapid start")).length;
    expect(responseRenderCount()).toBe(1);

    for (let index = 0; index < 20; index += 1) {
      storeState = { ...storeState, entries: [storeState.entries[0]!, { role: "analyst", text: `Rapid start chunk-${index}` }] };
      act(() => renderSlots(root, { operationId: "chat-test" } as never));
    }
    expect(responseRenderCount()).toBe(1);
    act(() => vi.advanceTimersByTime(32));
    expect(responseRenderCount()).toBe(2);
    expect(container.querySelector(".session-analyst__response")?.textContent).toContain("chunk-19");

    for (let index = 20; index < 28; index += 1) {
      storeState = { ...storeState, entries: [storeState.entries[0]!, { role: "analyst", text: `Rapid start chunk-${index}` }] };
      act(() => renderSlots(root, { operationId: "chat-test" } as never));
    }
    const finalText = "Rapid start chunk-27\n\n**Final output**";
    storeState = { ...storeState, busy: false, phase: "complete", entries: [storeState.entries[0]!, { role: "analyst", text: finalText }] };
    act(() => renderSlots(root, { operationId: "chat-test" } as never));
    expect(responseRenderCount()).toBe(3);
    expect(container.querySelector(".session-analyst__response strong")?.textContent).toBe("Final output");

    act(() => vi.advanceTimersByTime(100));
    storeState = { ...storeState, latestActivity: { kind: "reasoning" }, runEndedAt: 123 };
    act(() => renderSlots(root, { operationId: "chat-test" } as never));
    expect(responseRenderCount()).toBe(3);

    act(() => root.unmount());
    container.remove();
  });

  it("installs the public diagram hydrator on the transcript root", () => {
    installDiagramHydratorSpy.mockImplementation((root: ParentNode) => {
      for (const block of root.querySelectorAll<HTMLElement>('[data-diagram-state="pending"]')) block.dataset.diagramState = "rendered";
    });
    storeState = {
      ...initialAnalysisState,
      started: true,
      phase: "complete",
      entries: [{ role: "analyst", text: "```mermaid\ngraph TD\n  A --> B\n```" }],
    };
    const { container, root } = renderPanel();
    const chat = container.querySelector<HTMLElement>(".session-analyst__chat")!;
    const diagram = chat.querySelector<HTMLElement>(".diagram-block")!;

    expect(installDiagramHydratorSpy).toHaveBeenCalledWith(chat, expect.objectContaining({
      openExpandedAria: "Open diagram in expanded view",
      lightboxTitle: "MANIFEST · DIAGRAM",
      close: "Close",
    }));
    expect(diagram.dataset.diagramState).toBe("rendered");

    act(() => root.unmount());
    container.remove();
  });

  it("resets the shared analyst session from the panel header", async () => {
    storeState = {
      ...initialAnalysisState,
      catalog,
      cliId: "claude",
      model: "gpt",
      effort: "medium",
      started: true,
      phase: "complete",
      entries: [{ role: "analyst", text: "Answer" }],
      artifacts: [{ id: "artifact", title: "Artifact", html: "<p>artifact</p>", createdAt: 1 }],
    };
    const { container, root } = renderPanel();
    const button = container.querySelector('[aria-label="Reset Session Analyst"]') as HTMLButtonElement;

    await act(async () => button.click());
    expect(reset).toHaveBeenCalledOnce();

    act(() => root.unmount());
    container.remove();
  });

  it("sends with Enter while preserving Shift+Enter and IME composition", async () => {
    storeState = {
      ...initialAnalysisState,
      catalog,
      cliId: "claude",
      model: "gpt",
      effort: "medium",
    };
    const { container, root } = renderPanel();
    const textarea = container.querySelector("textarea")!;

    setTextareaValue(textarea, "Summarize the session");
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("Summarize the session");
    expect(textarea.value).toBe("");

    setTextareaValue(textarea, "Keep this line");
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true })));
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
    expect(send).toHaveBeenCalledOnce();
    expect(textarea.value).toBe("Keep this line");

    act(() => root.unmount());
    container.remove();
  });

  it("renders follow-up chips after completion and sends their exact prompts", async () => {
    storeState = {
      ...initialAnalysisState,
      started: true,
      phase: "complete",
      entries: [{ role: "analyst", text: "Answer" }],
    };
    const { container, root } = renderPanel();
    const followups = container.querySelector(".session-analyst__followups")!;
    expect(followups.textContent).toContain("FOLLOW UP");
    expect(followups.querySelectorAll("button")).toHaveLength(4);

    const deeper = [...followups.querySelectorAll("button")].find((button) => button.textContent?.includes("Go deeper"))!;
    await act(async () => deeper.click());
    expect(send).toHaveBeenCalledWith("Go deeper on your previous answer with more evidence citations.");

    act(() => root.unmount());
    container.remove();
  });

  it("renders cancellable queued questions and keeps the composer enabled while busy", () => {
    storeState = {
      ...initialAnalysisState,
      started: true,
      busy: true,
      phase: "reasoning",
      entries: [{ role: "user", text: "Initial" }],
      queue: ["First queued", "Second queued"],
    };
    const { container, root } = renderPanel();
    expect(container.querySelector(".session-analyst__queue")?.getAttribute("aria-live")).toBe("polite");
    expect(container.querySelectorAll(".session-analyst__queue-item")).toHaveLength(2);
    expect(container.textContent).toContain("Enter queues the question — it fires when the analyst is ready");
    expect(container.querySelector("textarea")?.disabled).toBe(false);

    const textarea = container.querySelector("textarea")!;
    setTextareaValue(textarea, "Queued from composer");
    act(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(storeState.queue).toEqual(["First queued", "Second queued", "Queued from composer"]);
    expect(storeState.draft).toBe("");
    expect(send).not.toHaveBeenCalled();

    act(() => (container.querySelector('[aria-label="Cancel queued question 1"]') as HTMLButtonElement).click());
    expect(storeState.queue).toEqual(["Second queued", "Queued from composer"]);
    expect(container.querySelectorAll(".session-analyst__queue-item")).toHaveLength(2);

    act(() => root.unmount());
    container.remove();
  });

  it("filters slash commands and replaces the draft on keyboard and mouse selection", () => {
    storeState = { ...initialAnalysisState, draft: "/dr" };
    const { container, root } = renderPanel();
    const textarea = container.querySelector("textarea")!;
    const palette = container.querySelector('[role="listbox"]')!;
    expect(palette.parentElement).toBe(container.querySelector(".session-analyst__composer"));
    expect(textarea.getAttribute("role")).toBe("combobox");
    expect(textarea.getAttribute("aria-expanded")).toBe("true");
    expect(textarea.getAttribute("aria-controls")).toBe(palette.id);
    expect(palette.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(palette.textContent).toContain("/drift");
    expect(textarea.getAttribute("aria-activedescendant")).toBe("analysis-chat-test-slash-drift");
    expect(palette.querySelector('[role="option"]')?.id).toBe("analysis-chat-test-slash-drift");

    act(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(storeState.draft).toBe("Review this session for intent drift against my stated goals.");
    expect(send).not.toHaveBeenCalled();
    expect(container.querySelector('[role="listbox"]')).toBeNull();

    setTextareaValue(textarea, "/");
    const timeline = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.includes("/timeline"))!;
    act(() => timeline.click());
    expect(storeState.draft).toBe("Walk me through how this session unfolded.");
    expect(send).not.toHaveBeenCalled();

    act(() => root.unmount());
    container.remove();
  });

  it("dismisses the slash listbox when focus enters the composer tools", () => {
    storeState = {
      ...initialAnalysisState,
      catalog,
      cliId: "claude",
      model: "gpt",
      effort: "medium",
      draft: "/",
    };
    const { container, root } = renderPanel();
    const textarea = container.querySelector("textarea")!;
    const trigger = container.querySelector<HTMLButtonElement>(".session-analyst__composer-tools .session-analyst__model-chip")!;

    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    act(() => trigger.focus());
    expect(document.activeElement).toBe(trigger);
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(textarea.getAttribute("aria-expanded")).toBe("false");
    expect(storeState.draft).toBe("/");

    act(() => root.unmount());
    container.remove();
  });

  it("dismisses only the slash listbox on the first Escape", () => {
    storeState = { ...initialAnalysisState, draft: "/" };
    const { container, root } = renderPanel();
    const textarea = container.querySelector("textarea")!;

    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    act(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(storeState.draft).toBe("/");
    expect(textarea.value).toBe("/");

    act(() => root.unmount());
    container.remove();
  });

  it("clears a non-empty draft on Escape when the slash listbox is closed", () => {
    const onRequestCompanions = vi.fn();
    const onSetCompanionPanelVisible = vi.fn();
    storeState = { ...initialAnalysisState, draft: "Keep this draft" };
    const { container, root } = renderPanel({
      operationId: "chat-test",
      companionsOpen: true,
      hiddenCompanionPanelIds: [],
      onRequestCompanions,
      onSetCompanionPanelVisible,
    } as unknown as OperationRenderContext);
    const textarea = container.querySelector("textarea")!;

    act(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(storeState.draft).toBe("");
    expect(textarea.value).toBe("");
    expect(onSetCompanionPanelVisible).not.toHaveBeenCalled();
    expect(onRequestCompanions).not.toHaveBeenCalled();

    act(() => root.unmount());
    container.remove();
  });

  it("closes the Analyst companion and the companion layer on Escape", () => {
    const onRequestCompanions = vi.fn();
    const onSetCompanionPanelVisible = vi.fn();
    storeState = {
      ...initialAnalysisState,
      artifacts: [{ id: "artifact", title: "Artifact", html: "<p>artifact</p>", createdAt: 1 }],
    };
    const { container, root } = renderPanel({
      operationId: "chat-test",
      companionsOpen: true,
      hiddenCompanionPanelIds: [],
      onRequestCompanions,
      onSetCompanionPanelVisible,
    } as unknown as OperationRenderContext);
    const textarea = container.querySelector("textarea")!;

    act(() => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(onSetCompanionPanelVisible.mock.calls).toEqual([
      [ANALYST_CHAT_COMPANION_ID, false],
    ]);
    expect(onRequestCompanions).toHaveBeenCalledOnce();
    expect(onRequestCompanions).toHaveBeenCalledWith(false);

    act(() => root.unmount());
    container.remove();
  });

  it("localizes every slash command draft while preserving the English templates", () => {
    const expected = {
      en: {
        "/now": "What is the agent doing right now?",
        "/drift": "Review this session for intent drift against my stated goals.",
        "/brief": "Draft a handoff brief and publish it as an artifact.",
        "/risks": "Flag anything I should review before this work continues.",
        "/timeline": "Walk me through how this session unfolded.",
      },
      ko: {
        "/now": "에이전트가 지금 무엇을 하고 있어?",
        "/drift": "내가 정한 목표와 비교해 이 세션의 의도 드리프트를 검토해 줘.",
        "/brief": "인수인계 브리프 초안을 작성하고 아티팩트로 발행해 줘.",
        "/risks": "이 작업을 계속하기 전에 내가 검토해야 할 항목을 짚어 줘.",
        "/timeline": "이 세션이 어떻게 진행됐는지 정리해 줘",
      },
    } as const;

    for (const language of ["en", "ko"] as const) {
      storeState = { ...initialAnalysisState };
      const { container, root } = renderPanel({ operationId: `chat-test-${language}`, language } as OperationRenderContext);
      const textarea = container.querySelector("textarea")!;
      for (const [command, draft] of Object.entries(expected[language])) {
        setTextareaValue(textarea, command);
        const option = container.querySelector<HTMLElement>('[role="option"]')!;
        expect(option.textContent).toContain(command);
        act(() => option.click());
        expect(storeState.draft).toBe(draft);
      }
      act(() => root.unmount());
      container.remove();
    }
  });

  it("leaves slash navigation and the draft unchanged during IME composition", () => {
    storeState = { ...initialAnalysisState, draft: "/" };
    const { container, root } = renderPanel();
    const textarea = container.querySelector("textarea")!;
    const initialActiveOption = textarea.getAttribute("aria-activedescendant");

    for (const key of ["ArrowDown", "ArrowUp", "Enter", "Escape"]) {
      act(() => textarea.dispatchEvent(new KeyboardEvent("keydown", {
        key,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      })));
      expect(storeState.draft).toBe("/");
      expect(textarea.getAttribute("aria-activedescendant")).toBe(initialActiveOption);
      expect(textarea.getAttribute("aria-expanded")).toBe("true");
    }
    expect(send).not.toHaveBeenCalled();

    act(() => root.unmount());
    container.remove();
  });

  it("recalculates composer height when its textarea is resized", () => {
    let triggerResize = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) {
        triggerResize = () => callback([], this as unknown as ResizeObserver);
      }
      observe() {}
      unobserve() {}
      disconnect() { disconnect(); }
    });
    storeState = { ...initialAnalysisState, draft: "A durable draft that wraps after the panel narrows" };
    const { container, root } = renderPanel();
    const textarea = container.querySelector("textarea")!;
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 166 });

    act(() => triggerResize());
    expect(Number.parseFloat(textarea.style.height)).toBe(112.5);
    expect(textarea.style.overflowY).toBe("auto");

    act(() => root.unmount());
    expect(disconnect).toHaveBeenCalledOnce();
    container.remove();
  });

  it("follows the latest streamed analyst content when chat overflows", () => {
    storeState = {
      ...initialAnalysisState,
      started: true,
      busy: true,
      phase: "writing",
      latestActivity: { kind: "writing" },
      entries: [
        { role: "user", text: "Summarize this" },
        { role: "analyst", text: "First chunk" },
      ],
    };
    const { container, root } = renderPanel();
    const chat = container.querySelector<HTMLElement>(".session-analyst__chat")!;
    Object.defineProperties(chat, {
      scrollHeight: { configurable: true, value: 640 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });

    storeState = {
      ...storeState,
      entries: [
        storeState.entries[0]!,
        { role: "analyst", text: "First chunk and a streamed follow-up" },
      ],
    };
    act(() => renderSlots(root, { operationId: "chat-test" } as never));

    expect(chat.scrollTop).toBe(640);

    act(() => root.unmount());
    container.remove();
  });

  it("renders a collapsible completion receipt and truthful stopped receipts", () => {
    storeState = {
      ...initialAnalysisState,
      phase: "complete",
      started: true,
      latestActivity: { kind: "writing" },
      runStartedAt: 1_000,
      runEndedAt: 19_000,
      entries: [{ role: "analyst", text: "Answer", receipt: { outcome: "complete", durationMs: 18_000, tools: [{ title: "wiki_read", status: "complete" }] } }],
      tools: [{ title: "wiki_read", status: "complete" }],
    };
    const { container, root } = renderPanel();
    const composer = container.querySelector(".session-analyst__composer")!;
    const receipt = container.querySelector(".session-analyst__receipt")!;
    // 끝난 턴은 채팅 원장과 같은 문법으로 한 문장에 접힌다 — 결말과 소요와 스텝 수가 한 줄이다.
    expect(receipt.querySelector("summary")?.textContent).toContain("Answered in 18s · 1 step");
    expect(receipt.querySelector(".session-analyst__receipt-step")?.textContent).toContain("wiki_read");
    expect(container.querySelector(".session-analyst__stopped")).toBeNull();
    // 같은 시간을 두 번 말하지 않는다: 완료 머리는 접힘 줄에 흡수됐다(예전에는 머리의
    // "Answered in 18s"와 알약의 "✓ 18s · 1 step"이 나란히 섰다).
    expect(container.querySelector(".session-analyst__turn-head")).toBeNull();
    expect(receipt.querySelector(".session-analyst__receipt-mark")).toBeNull();
    expect(container.querySelector(".session-analyst__chip-state")?.textContent).toContain("Complete");
    expect(composer.classList.contains("is-docked")).toBe(true);
    expect(container.querySelectorAll("select")).toHaveLength(0);
    expect(container.querySelectorAll(".session-analyst__composer-tools .fc-select__trigger")).toHaveLength(0);

    storeState = { ...storeState, phase: "stopped", started: false, latestActivity: { kind: "tool", title: "wiki_read", status: "running" }, runEndedAt: 13_000, entries: [{ role: "analyst", text: "Answer", receipt: { outcome: "stopped", durationMs: 12_000, tools: [{ title: "wiki_read", status: "running" }] } }] };
    act(() => renderSlots(root, { operationId: "chat-test" } as never));
    expect(container.querySelector(".session-analyst__stopped")?.textContent).toBe("Stopped · last confirmed: Using wiki_read (running) · 12s");
    expect(container.querySelector(".session-analyst__receipt")).toBeNull();
    expect(container.querySelector(".session-analyst__chip-state")?.textContent).toContain("Stopped");
    expect(container.querySelector(".session-analyst__composer")).toBe(composer);
    expect(container.querySelector(".session-analyst__composer")?.classList.contains("is-docked")).toBe(true);
    expect(container.querySelectorAll("select")).toHaveLength(0);
    expect(container.querySelectorAll(".session-analyst__composer-tools .fc-select__trigger")).toHaveLength(0);

    act(() => root.unmount());
    container.remove();
  });

  it("groups the model menu by provider, keeps it on screen, and selects without launching", () => {
    const mixed = {
      clis: [{
        cliId: "claude",
        label: "AI Gateway",
        available: true,
        defaultModel: "sonnet",
        models: [
          { id: "sonnet", label: "Claude Sonnet", effortLevels: ["low", "medium", "high"], defaultEffort: "low" },
          { id: "opus[1m]", label: "Claude Opus [1M]", effortLevels: ["low"] },
          { id: "claude-gateway--codex--gpt-5.6-sol", label: "Codex-GPT-5.6-Sol", effortLevels: ["low"] },
          { id: "claude-gateway--kimi--k3-1m", label: "Moonshot-Kimi-K3-1M", effortLevels: [] },
        ],
      }],
    };
    storeState = {
      ...initialAnalysisState,
      catalog: mixed,
      cliId: "claude",
      model: "sonnet",
      effort: "low",
    };
    const { container, root } = renderPanel();
    const chip = container.querySelector<HTMLButtonElement>(".session-analyst__model-chip")!;
    Object.defineProperty(chip, "getBoundingClientRect", {
      value: () => ({
        x: 24,
        y: 700,
        top: 700,
        bottom: 728,
        left: 24,
        right: 140,
        width: 116,
        height: 28,
        toJSON() { return {}; },
      }),
    });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });

    act(() => chip.click());
    const menu = document.querySelector<HTMLElement>(".session-analyst__model-menu")!;
    const captions = [...menu.querySelectorAll(".operation-launch-variant-caption")].map((node) => node.textContent?.trim());
    const rows = [...menu.querySelectorAll('[role="menuitemradio"]')].map((node) => node.textContent?.replace("✓", "").trim());
    expect(captions).toEqual(["Claude", "Codex", "Moonshot-Kimi"]);
    expect(menu.querySelectorAll(".operation-launch-provider-glyph")).toHaveLength(3);
    expect(chip.querySelector(".operation-launch-provider-glyph")).not.toBeNull();
    expect(menu.querySelectorAll(".operation-launch-variant-row")).toHaveLength(4);
    expect(menu.querySelector(".session-analyst__model-row")).toBeNull();
    expect(rows).toEqual(["Sonnet", "Opus [1M]", "GPT-5.6-Sol", "K3-1M"]);
    expect(menu.style.overflowY).toBe("auto");
    expect(Number.parseFloat(menu.style.maxHeight)).toBeLessThanOrEqual(520);
    expect(Number.parseFloat(menu.style.top) + Number.parseFloat(menu.style.maxHeight)).toBeLessThanOrEqual(800);

    const kimi = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((row) => row.textContent?.includes("K3-1M"))!;
    act(() => kimi.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "select-model", model: "claude-gateway--kimi--k3-1m" });
    expect(document.querySelector(".session-analyst__model-menu")).toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it("moves the same composer to the bottom and removes settings after the first interaction", () => {
    storeState = {
      ...initialAnalysisState,
      catalog,
      cliId: "claude",
      model: "gpt",
      effort: "medium",
    };
    const { container, root } = renderPanel();
    const composer = container.querySelector(".session-analyst__composer")!;
    expect(container.querySelector(".session-analyst__model-chip")).not.toBeNull();
    expect(container.querySelector(".effort-track")).not.toBeNull();

    storeState = {
      ...storeState,
      phase: "stopped",
      started: false,
      entries: [{ role: "user", text: "Review this" }],
      latestActivity: { kind: "starting", connected: true },
      runStartedAt: 1_000,
      runEndedAt: 2_000,
    };
    act(() => renderSlots(root, { operationId: "chat-test" } as never));

    expect(container.querySelector(".session-analyst__composer")).toBe(composer);
    expect(composer.classList.contains("is-docked")).toBe(true);
    expect(composer.classList.contains("is-docking")).toBe(true);
    expect(container.querySelectorAll("select")).toHaveLength(0);
    expect(container.querySelectorAll(".session-analyst__composer-tools .fc-select__trigger")).toHaveLength(0);
    expect(container.querySelector("textarea")?.rows).toBe(1);
    expect(container.querySelector(".session-analyst__send")?.getAttribute("aria-label")).toBe("Send");

    storeState = { ...storeState, phase: "reasoning", busy: true, started: true, latestActivity: { kind: "reasoning" } };
    act(() => renderSlots(root, { operationId: "chat-test" } as never));
    expect(composer.classList.contains("is-docking")).toBe(true);

    act(() => root.unmount());
    container.remove();
  });
});

function renderPanel(context: OperationRenderContext = { operationId: "chat-test" } as OperationRenderContext) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  rerenderStore = () => renderSlots(root, context);
  act(() => rerenderStore());
  return { container, root };
}

// CompanionFrame과 같은 배치 — 캡션 슬롯과 본문 슬롯이 한 프레임 안에 함께 선다.
function renderSlots(root: Root, context: OperationRenderContext): void {
  root.render(createElement(
    "div",
    null,
    createElement(AnalystCaption, { context, key: "caption" }),
    createElement(AnalystChatPanel, { context, key: "body" }),
  ));
}

function emit(event: AnalysisEvent): void {
  act(() => dispatch({ type: "event", event, now: Date.now() }));
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
