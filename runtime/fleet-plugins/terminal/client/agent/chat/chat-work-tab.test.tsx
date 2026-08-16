// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { AgentChatView } from "./chat-view.js";
import type { AgentChatJob, AgentChatLogState } from "./chat-events.js";

// 스트림 상태는 이 테스트가 직접 쥔다 — 재접속으로 원장이 되감기는 순간을 만들어야 하기 때문이다.
let logState: AgentChatLogState;

vi.mock("./chat-store.js", () => ({ useAgentChatStream: () => logState }));
vi.mock("@fleet-console/markdown/styles.css", () => ({}));
vi.mock("./chat.css", () => ({}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function job(overrides: Partial<AgentChatJob> = {}): AgentChatJob {
  return { id: "w1", kind: "workflow", title: "two-step", open: true, stages: [], ...overrides };
}

function stateWith(jobs: readonly AgentChatJob[]): AgentChatLogState {
  return {
    turns: [{ dispatch: { text: "go" }, items: [], state: "done", toolCount: 0, draft: "" }],
    replaying: false,
    replayedTurns: 0,
    errorCode: null,
    jobs,
  };
}

beforeEach(() => {
  logState = stateWith([]);
  vi.stubGlobal("ResizeObserver", class {
    observe() { /* noop */ }
    disconnect() { /* noop */ }
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function render(): void {
  const context = {
    operationId: "op-1",
    theaterId: "theater-1",
    pluginId: "terminal",
    type: "agent",
    language: "en",
    runtimeState: { lifecycle: "live", activity: "idle" },
  } as unknown as OperationRenderContext;
  act(() => root?.render(createElement(AgentChatView, {
    context,
    onOpenTerminal: async () => {},
    tourAnchors: false,
  })));
}

function mount(): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  render();
}

function tabs(): readonly string[] {
  return [...(container?.querySelectorAll(".agent-chat-tab") ?? [])].map((node) => node.textContent ?? "");
}

function clickTab(label: string): void {
  const target = [...(container?.querySelectorAll<HTMLButtonElement>(".agent-chat-tab") ?? [])]
    .find((node) => (node.textContent ?? "").includes(label));
  if (!target) throw new Error(`Missing tab: ${label}`);
  act(() => { target.click(); });
}

describe("chat Work tab", () => {
  it("stays out of the way until the session has background work", () => {
    mount();
    expect(tabs()).toEqual([]);
    expect(container?.querySelector(".agent-chat-log")?.hasAttribute("hidden")).toBe(false);
  });

  it("keeps a route back to the conversation when the job ledger resets underneath it", () => {
    // 재접속이 리듀서를 되감고 저널에 잡 이벤트가 남아 있지 않으면 원장이 비어 버린다. 그때 탭
    // 줄까지 거두면 로그는 숨은 채로 남고, 대화로 돌아갈 컨트롤이 화면에서 통째로 사라진다.
    logState = stateWith([job()]);
    mount();
    clickTab("Work");
    expect(container?.querySelector(".agent-chat-log")?.hasAttribute("hidden")).toBe(true);

    logState = stateWith([]);
    render();

    expect(tabs().some((label) => label.includes("Conversation"))).toBe(true);
    clickTab("Conversation");
    expect(container?.querySelector(".agent-chat-log")?.hasAttribute("hidden")).toBe(false);
  });

  it("drops the tab row again once the reader is back on the conversation", () => {
    logState = stateWith([job()]);
    mount();
    logState = stateWith([]);
    render();
    expect(tabs()).toEqual([]);
  });
});
