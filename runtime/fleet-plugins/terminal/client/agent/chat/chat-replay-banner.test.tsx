// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { AgentChatView } from "./chat-view.js";
import type { AgentChatTurn } from "./chat-events.js";

vi.mock("./chat-store.js", () => ({
  useAgentChatStream: () => ({
    turns,
    replaying: false,
    errorCode: null,
    jobs: [],
    context: null,
    connection: "open",
    stopTurn: async () => {},
    answerAsk: async () => {},
  }),
}));
vi.mock("../api.js", () => ({ readAgentChatJobDetail: async () => null }));
vi.mock("@fleet-console/markdown/styles.css", () => ({}));
vi.mock("./chat.css", () => ({}));

let turns: readonly AgentChatTurn[] = [];
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
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
  turns = [];
  vi.unstubAllGlobals();
});

/** 재생 뒤의 최소 상태 — 되쓴 완료 턴 하나. */
function doneTurn(): AgentChatTurn {
  return { dispatch: { text: "hello" }, answer: "hi", items: [], state: "done", toolCount: 0, draft: "" };
}

function mount(payload: Record<string, unknown>): void {
  const context = {
    operationId: "op-1",
    theaterId: "theater-1",
    pluginId: "terminal",
    type: "agent",
    language: "ko",
    runtimeState: { lifecycle: "live", activity: "idle" },
    operation: {
      id: "op-1",
      theaterId: "theater-1",
      type: "agent",
      pluginId: "terminal",
      title: "op",
      payload,
      geometry: null,
      ts: { createdAt: 0, updatedAt: 0 },
    },
  } as unknown as OperationRenderContext;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(AgentChatView, { context, tourAnchors: false })));
}

const session = { session: { harness: "claude-code", model: "opus[1m]", effort: "ultra" } };

// 같은 세션의 지난 턴은 CLI/Chat 표면을 오가도 사용자 자기 대화다 — 재생은 콘텐츠만 소리 없이
// 되쓰고, "이전 턴 재생됨" 배너는 표면 출신과 무관하게 어디에도 뜨지 않는다.
describe("chat replay renders content without a replay banner", () => {
  it("shows the restored turn but no replay banner for a chat-born session", () => {
    turns = [doneTurn()];
    mount({ ...session, chatMode: true, chatBorn: true });
    expect(container?.querySelectorAll(".agent-chat-turn").length).toBe(1);
    expect(container?.textContent).not.toContain("재생됨");
    expect(container?.textContent).not.toContain("replayed");
  });

  it("shows the restored turn but no replay banner for a terminal-adopted session", () => {
    turns = [doneTurn()];
    mount({ ...session, chatMode: true });
    expect(container?.querySelectorAll(".agent-chat-turn").length).toBe(1);
    expect(container?.textContent).not.toContain("재생됨");
    expect(container?.textContent).not.toContain("replayed");
  });
});
