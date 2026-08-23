// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { AgentChatView } from "./chat-view.js";
import type { AgentChatTurn } from "./chat-events.js";

let turns: readonly AgentChatTurn[] = [];
let replaying = false;

vi.mock("./chat-store.js", () => ({
  useAgentChatStream: () => ({
    turns,
    replaying,
    errorCode: null,
    jobs: [],
    context: null,
    queue: [],
    connection: "open",
    stopTurn: async () => {},
    cancelQueued: async () => {},
    answerAsk: async () => {},
  }),
}));
vi.mock("../api.js", () => ({ readAgentChatJobDetail: async () => null }));
vi.mock("@fleet-console/markdown/styles.css", () => ({}));
vi.mock("./chat.css", () => ({}));

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
  replaying = false;
  vi.unstubAllGlobals();
});

function viewProps(language: "en" | "ko" = "en") {
  const context = {
    operationId: "op-1",
    theaterId: "theater-1",
    pluginId: "terminal",
    type: "agent",
    language,
    runtimeState: { lifecycle: "live", activity: "idle" },
    operation: {
      id: "op-1",
      theaterId: "theater-1",
      type: "agent",
      pluginId: "terminal",
      title: "op",
      payload: { session: { harness: "claude-code", model: "opus[1m]", effort: "ultra" } },
      geometry: null,
      ts: { createdAt: 0, updatedAt: 0 },
    },
  } as unknown as OperationRenderContext;
  return { context, tourAnchors: false };
}

function mount(language: "en" | "ko" = "en"): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(AgentChatView, viewProps(language))));
}

/** 첫 턴이 오간 뒤의 최소 상태 — 이 뷰가 읽는 필드를 모두 갖춘 한 턴. */
function doneTurn(): AgentChatTurn {
  return { dispatch: { text: "hello" }, items: [], state: "done", toolCount: 0, draft: "" };
}

const hero = () => container?.querySelector(".agent-chat-hero");
const settle = () => container?.querySelector(".agent-chat-settle");
const log = () => container?.querySelector(".agent-chat-log");

describe("chat first-turn surface", () => {
  // 빈 로그를 그대로 두면 96%가 빈 면이라 "아직 아무것도 없는 제품"으로 읽힌다.
  it("stands an invitation before the first turn and takes it down after", () => {
    mount();
    expect(hero()).not.toBeNull();
    expect(hero()?.textContent).toContain("What should this session take on?");
    expect(container?.querySelector(".agent-chat-log")?.getAttribute("role")).toBe("log");
    expect(container?.querySelector(".agent-chat-log")?.getAttribute("aria-live")).toBe("off");
    // 초대는 빈 로그의 유일한 내용이다 — 좌표를 다시 적는 줄은 컴포저 배지로 갈음한다.
    expect(log()?.firstElementChild?.classList.contains("agent-chat-hero")).toBe(true);

    act(() => root?.unmount());
    container?.remove();
    turns = [doneTurn()];
    mount();
    expect(hero()).toBeNull();
  });

  it("announces the first live answer after an empty replay completes", () => {
    replaying = true;
    mount();
    const announcer = container?.querySelector('[role="status"]');
    expect(announcer?.textContent).toBe("");

    replaying = false;
    act(() => root?.render(createElement(AgentChatView, viewProps())));
    expect(announcer?.textContent).toBe("");

    turns = [{ ...doneTurn(), answer: "live" }];
    act(() => root?.render(createElement(AgentChatView, viewProps())));
    expect(announcer?.textContent).toBe("Answer ready");
  });

  // 첫 턴 전에는 받침이 컴포저를 가운데로 올리고, 첫 턴이 오면 비율이 0으로 줄며 컴포저가
  // 하단으로 내려앉는다 — 움직이는 것은 컴포저 하나이고, 자리는 언제나 in-flow다.
  it("settles the composer from the middle to the bottom on the first turn", () => {
    mount();
    expect(settle()?.classList.contains("is-inviting")).toBe(true);
    expect(log()?.classList.contains("is-inviting")).toBe(true);
    // 받침은 대화가 읽을 것이 아니다.
    expect(settle()?.getAttribute("aria-hidden")).toBe("true");

    act(() => root?.unmount());
    container?.remove();
    turns = [doneTurn()];
    mount();
    expect(settle()?.classList.contains("is-inviting")).toBe(false);
    expect(log()?.classList.contains("is-inviting")).toBe(false);
    // 컴포저는 사라지지 않는다 — 자리만 옮겼다.
    expect(container?.querySelector(".agent-chat-composer-input")).not.toBeNull();
  });
});
