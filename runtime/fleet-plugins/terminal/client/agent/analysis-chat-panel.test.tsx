// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
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
vi.mock("./analysis-store.js", () => ({
  useAnalysisStore: () => ({ state: storeState, dispatch, send, stop, reset }),
}));

import { ANALYST_ARTIFACTS_COMPANION_ID, AnalystChatPanel } from "./analysis-chat-panel.js";

const catalog = { clis: [{ cliId: "codex", label: "Codex", available: true, defaultModel: "gpt", models: [{ id: "gpt", label: "GPT", effortLevels: ["medium"], defaultEffort: "medium" }] }] };

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

  it("renders the initial settings beside and outside the prompt surface", () => {
    storeState = {
      ...initialAnalysisState,
      catalog,
      cliId: "codex",
      model: "gpt",
      effort: "medium",
    };
    const { container, root } = renderPanel();
    const composer = container.querySelector(".session-analyst__composer")!;
    const surface = composer.querySelector(".session-analyst__composer-surface")!;
    const selectorStrip = composer.querySelector(".session-analyst__selector-strip")!;

    expect(container.querySelector(".session-analyst__chat-pane")?.classList.contains("is-initial")).toBe(true);
    expect(composer.classList.contains("is-initial")).toBe(true);
    expect(selectorStrip.parentElement).toBe(composer);
    expect(selectorStrip.nextElementSibling).toBe(surface);
    expect(surface.querySelector(".session-analyst__selector-strip")).toBeNull();
    expect(selectorStrip.querySelectorAll("select")).toHaveLength(3);
    expect(surface.querySelector("textarea")?.rows).toBe(1);
    expect(surface.querySelector(".session-analyst__send")?.getAttribute("aria-label")).toBe("Send");
    expect(container.querySelector(".session-analyst__composer-meta")).toBeNull();
    expect((container.querySelector('[aria-label="Reset Session Analyst"]') as HTMLButtonElement).disabled).toBe(true);

    act(() => root.unmount());
    container.remove();
  });

  it("keeps the transcript fully visible with one Stop and event-truthful tool activity", () => {
    storeState = {
      ...initialAnalysisState,
      catalog,
      cliId: "codex",
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

    expect(container.querySelector(".session-analyst__panel-state")?.textContent).toBe("Analyzing");
    expect(container.querySelector(".session-analyst__pulse")?.textContent).toContain("Using wiki_read");
    expect(container.querySelector(".session-analyst__pulse")?.textContent).toContain("Tool status: running");
    expect(container.querySelector(".session-analyst__chat ol")?.classList.contains("is-dimmed")).toBe(false);
    expect(container.querySelector("textarea")?.disabled).toBe(false);
    expect(container.querySelectorAll("select")).toHaveLength(0);
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
    const setCompanionPanelVisible = vi.fn();
    const context = {
      operationId: "chat-test",
      hiddenCompanionPanelIds: [ANALYST_ARTIFACTS_COMPANION_ID],
      onSetCompanionPanelVisible: setCompanionPanelVisible,
    } as OperationRenderContext;
    storeState = analysisReducer(initialAnalysisState, { type: "sending", started: true, text: "Publish this", now: Date.now() });
    const { container, root } = renderPanel(context);

    emit({ type: "tool", title: "mcp__session_analyst__publish_artifact", status: "pending" });
    const authoring = container.querySelector<HTMLElement>(".session-analyst__author-card.is-authoring")!;
    expect(authoring.hasAttribute("aria-live")).toBe(false);
    expect(authoring.textContent).toContain("Publishing an artifact");
    expect(authoring.textContent).toContain("The analyst is authoring artifact content. It opens in Artifacts when it lands.");
    expect(authoring.previousElementSibling?.classList.contains("session-analyst__transcript")).toBe(true);
    expect(authoring.nextElementSibling?.classList.contains("session-analyst__pulse")).toBe(true);
    const handle = container.querySelector<HTMLButtonElement>(".session-analyst-handle--artifacts")!;
    expect(handle.classList.contains("is-authoring")).toBe(true);
    expect(handle.querySelector(".session-analyst-handle__count")?.textContent).toBe("…");
    expect(handle.title).toBe("The analyst is authoring an artifact…");

    act(() => vi.advanceTimersByTime(2_100));
    expect(authoring.querySelector(".session-analyst__author-time")?.textContent).toBe("2s");

    emit({ type: "artifact", artifact: { id: "artifact", title: "Session brief", html: "<p>brief</p>", createdAt: Date.now() } });
    const done = container.querySelector<HTMLElement>(".session-analyst__author-card.is-done")!;
    expect(done.textContent).toContain("Artifact published — Session brief");
    expect(done.querySelector(".session-analyst__author-time")?.textContent).toBe("2s");
    expect(done.querySelector(".session-analyst__author-sub")).toBeNull();
    expect(done.querySelector(".session-analyst__author-track")).toBeNull();

    setCompanionPanelVisible.mockClear();
    act(() => (done.querySelector(".session-analyst__author-open") as HTMLButtonElement).click());
    expect(setCompanionPanelVisible).toHaveBeenCalledWith(ANALYST_ARTIFACTS_COMPANION_ID, true);

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
    const user = container.querySelector<HTMLElement>(".session-analyst__message--user")!;
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
      act(() => root.render(createElement(AnalystChatPanel, { context: { operationId: "chat-test" } as never })));
    }
    expect(responseRenderCount()).toBe(1);
    act(() => vi.advanceTimersByTime(32));
    expect(responseRenderCount()).toBe(2);
    expect(container.querySelector(".session-analyst__response")?.textContent).toContain("chunk-19");

    for (let index = 20; index < 28; index += 1) {
      storeState = { ...storeState, entries: [storeState.entries[0]!, { role: "analyst", text: `Rapid start chunk-${index}` }] };
      act(() => root.render(createElement(AnalystChatPanel, { context: { operationId: "chat-test" } as never })));
    }
    const finalText = "Rapid start chunk-27\n\n**Final output**";
    storeState = { ...storeState, busy: false, phase: "complete", entries: [storeState.entries[0]!, { role: "analyst", text: finalText }] };
    act(() => root.render(createElement(AnalystChatPanel, { context: { operationId: "chat-test" } as never })));
    expect(responseRenderCount()).toBe(3);
    expect(container.querySelector(".session-analyst__response strong")?.textContent).toBe("Final output");

    act(() => vi.advanceTimersByTime(100));
    storeState = { ...storeState, latestActivity: { kind: "reasoning" }, runEndedAt: 123 };
    act(() => root.render(createElement(AnalystChatPanel, { context: { operationId: "chat-test" } as never })));
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

    expect(installDiagramHydratorSpy).toHaveBeenCalledWith(chat);
    expect(diagram.dataset.diagramState).toBe("rendered");

    act(() => root.unmount());
    container.remove();
  });

  it("resets the shared analyst session from the panel header", async () => {
    storeState = {
      ...initialAnalysisState,
      catalog,
      cliId: "codex",
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
      cliId: "codex",
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
    act(() => root.render(createElement(AnalystChatPanel, { context: { operationId: "chat-test" } as never })));

    expect(chat.scrollTop).toBe(640);

    act(() => root.unmount());
    container.remove();
  });

  it("omits completion receipts while keeping truthful stopped receipts", () => {
    storeState = {
      ...initialAnalysisState,
      phase: "complete",
      started: true,
      latestActivity: { kind: "writing" },
      runStartedAt: 1_000,
      runEndedAt: 19_000,
      entries: [{ role: "analyst", text: "Answer" }],
      tools: [{ title: "wiki_read", status: "complete" }],
    };
    const { container, root } = renderPanel();
    const composer = container.querySelector(".session-analyst__composer")!;
    expect(container.querySelector(".session-analyst__receipt")).toBeNull();
    expect(container.querySelector(".session-analyst__panel-state")?.textContent).toBe("Complete");
    expect(composer.classList.contains("is-docked")).toBe(true);
    expect(container.querySelectorAll("select")).toHaveLength(0);

    storeState = { ...storeState, phase: "stopped", started: false, latestActivity: { kind: "tool", title: "wiki_read", status: "running" }, runEndedAt: 13_000 };
    act(() => root.render(createElement(AnalystChatPanel, { context: { operationId: "chat-test" } as never })));
    expect(container.querySelector(".session-analyst__receipt")?.textContent).toBe("Stopped · last confirmed: Using wiki_read (running) · 12s");
    expect(container.querySelector(".session-analyst__panel-state")?.textContent).toBe("Stopped");
    expect(container.querySelector(".session-analyst__composer")).toBe(composer);
    expect(container.querySelector(".session-analyst__composer")?.classList.contains("is-docked")).toBe(true);
    expect(container.querySelectorAll("select")).toHaveLength(0);

    act(() => root.unmount());
    container.remove();
  });

  it("moves the same composer to the bottom and removes settings after the first interaction", () => {
    storeState = {
      ...initialAnalysisState,
      catalog,
      cliId: "codex",
      model: "gpt",
      effort: "medium",
    };
    const { container, root } = renderPanel();
    const composer = container.querySelector(".session-analyst__composer")!;
    expect(container.querySelectorAll("select")).toHaveLength(3);

    storeState = {
      ...storeState,
      phase: "stopped",
      started: false,
      entries: [{ role: "user", text: "Review this" }],
      latestActivity: { kind: "starting", connected: true },
      runStartedAt: 1_000,
      runEndedAt: 2_000,
    };
    act(() => root.render(createElement(AnalystChatPanel, { context: { operationId: "chat-test" } as never })));

    expect(container.querySelector(".session-analyst__composer")).toBe(composer);
    expect(composer.classList.contains("is-docked")).toBe(true);
    expect(composer.classList.contains("is-docking")).toBe(true);
    expect(container.querySelectorAll("select")).toHaveLength(0);
    expect(container.querySelector("textarea")?.rows).toBe(1);
    expect(container.querySelector(".session-analyst__send")?.getAttribute("aria-label")).toBe("Send");

    storeState = { ...storeState, phase: "reasoning", busy: true, started: true, latestActivity: { kind: "reasoning" } };
    act(() => root.render(createElement(AnalystChatPanel, { context: { operationId: "chat-test" } as never })));
    expect(composer.classList.contains("is-docking")).toBe(true);

    act(() => root.unmount());
    container.remove();
  });
});

function renderPanel(context: OperationRenderContext = { operationId: "chat-test" } as OperationRenderContext) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  rerenderStore = () => root.render(createElement(AnalystChatPanel, { context }));
  act(() => rerenderStore());
  return { container, root };
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
