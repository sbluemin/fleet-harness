// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { AgentChatView } from "./chat-view.js";
import type { AgentChatTurn } from "./chat-events.js";

let replayedTurns = 0;

vi.mock("./chat-store.js", () => ({
  useAgentChatStream: () => ({
    turns,
    replaying: false,
    replayedTurns,
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
  replayedTurns = 0;
  vi.unstubAllGlobals();
});

/** 재생 뒤의 최소 상태 — 되쓴 완료 턴 하나. */
function doneTurn(): AgentChatTurn {
  return { dispatch: { text: "hello" }, items: [], state: "done", toolCount: 0, draft: "" };
}

function mount(payload: Record<string, unknown>): void {
  const context = {
    operationId: "op-1",
    theaterId: "theater-1",
    pluginId: "terminal",
    type: "agent",
    language: "en",
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

describe("chat replay banner", () => {
  // 터미널에서 Chat으로 전환한 세션의 재생 턴은 실제로 CLI 표면에서 먼저 오갔으므로 배너가 선다.
  it("announces replayed turns for a terminal-adopted session", () => {
    turns = [doneTurn()];
    replayedTurns = 1;
    mount({ ...session, chatMode: true });
    expect(container?.textContent).toContain("earlier turns replayed");
  });

  // 채팅으로 태어난 세션의 재생 턴은 이 채팅에서 방금 오간 자기 턴이다 — 없던 이전 세션을
  // 가리키는 오독을 부르므로 배너를 억제한다.
  it("suppresses the replay banner for a chat-born session", () => {
    turns = [doneTurn()];
    replayedTurns = 1;
    mount({ ...session, chatMode: true, chatBorn: true });
    expect(container?.textContent).not.toContain("earlier turns replayed");
  });
});
