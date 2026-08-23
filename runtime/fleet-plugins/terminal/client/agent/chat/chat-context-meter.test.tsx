// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { AgentChatView } from "./chat-view.js";
import type { AgentChatContext, AgentChatLogState, AgentChatTurn } from "./chat-events.js";

let logState: AgentChatLogState;

vi.mock("./chat-store.js", () => ({ useAgentChatStream: () => logState }));
vi.mock("../api.js", () => ({
  answerAgentChatAsk: async () => {},
  stopAgentChatTurn: async () => {},
  readAgentChatJobDetail: async () => null,
}));
vi.mock("@fleet-console/markdown/styles.css", () => ({}));
vi.mock("./chat.css", () => ({}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function turn(state: AgentChatTurn["state"]): AgentChatTurn {
  return {
    dispatch: { text: "go" },
    items: [{ type: "text", text: "답" }],
    state,
    toolCount: 0,
    draft: "",
    startedAt: 1,
  };
}

function stateWith(context: AgentChatContext | null, turnState: AgentChatTurn["state"] = "done"): AgentChatLogState {
  return {
    turns: [turn(turnState)],
    replaying: false,
    snapshotting: false,
    observedTurns: 0,
    errorCode: null,
    jobs: [],
    context,
    queue: [],
  };
}

/** 실측 좌표 하나 — Grok 4.6(실창 500k)에서 자식의 200k 칸을 되돌린 값이다. */
function measured(overrides: Partial<AgentChatContext> = {}): AgentChatContext {
  return {
    total: 42_670,
    max: 500_000,
    reserved: 16_000,
    compactAt: 484_000,
    slices: [{ name: "Messages", tokens: 42_670 }],
    memoryFiles: [],
    mcpTools: [],
    ...overrides,
  };
}

beforeEach(() => {
  logState = stateWith(measured());
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

function mount(): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const context = {
    operationId: "op-1",
    theaterId: "theater-1",
    pluginId: "terminal",
    type: "agent",
    language: "ko",
    operation: { id: "op-1", theaterId: "theater-1", type: "agent", pluginId: "terminal", title: "op", payload: {}, geometry: null, ts: { createdAt: 0, updatedAt: 0 } },
    runtimeState: { lifecycle: "live", activity: "running" },
  } as unknown as OperationRenderContext;
  act(() => root?.render(createElement(AgentChatView, {
    context,
    tourAnchors: false,
  })));
}

function chip(): HTMLElement | null {
  return container?.querySelector<HTMLElement>(".agent-chat-ctx-chip") ?? null;
}

function openPopover(): HTMLElement | null {
  act(() => chip()?.click());
  return container?.querySelector<HTMLElement>(".agent-chat-ctx-pop") ?? null;
}

describe("chat context meter", () => {
  it("states the model's real window, not Claude Code's coordinate", () => {
    // 이 결함의 원형: 실창 500k 모델이 200k로 보였다. 분모와 백분율이 함께 실창을 말해야 한다 —
    // 분모만 바꾸면 점유율이 실제의 1/3로 보이는 더 나쁜 거짓이 된다.
    mount();
    expect(chip()?.getAttribute("aria-label")).toBe("컨텍스트 창 9% 사용, 43k / 500k");
    expect(openPopover()?.textContent).toContain("43k / 500k · 9%");
  });

  it("writes a million as 1M rather than 1000k", () => {
    // 같은 값을 설정 화면은 이미 M으로 적는다. 한 제품이 같은 수를 두 단위로 적으면 사용자가
    // 두 번 읽어야 한다.
    logState = stateWith(measured({ total: 500_000, max: 1_000_000, slices: [{ name: "Messages", tokens: 500_000 }] }));
    mount();
    expect(chip()?.getAttribute("aria-label")).toContain("500k / 1M");
  });

  it("follows the live total while the turn runs", () => {
    // 총량은 모델 호출마다 갱신된다. 내역은 마지막 측정이라 그보다 뒤에 있고, 그 차이는 감추지
    // 않는다 — 감추면 방금 붙인 큰 파일이 공짜로 읽힌다.
    logState = stateWith(measured({ liveTotal: 120_000 }), "working");
    mount();
    expect(chip()?.getAttribute("aria-label")).toBe("컨텍스트 창 24% 사용, 120k / 500k");
    const pop = openPopover();
    expect(pop?.textContent).toContain("120k / 500k · 24%");
    // 아직 분해를 모르는 몫이 한 행으로 선다: 120,000 − 42,670.
    expect(pop?.textContent).toContain("이 턴");
    expect(pop?.textContent).toContain("77k");
    // 남은 자리는 라이브 총량과 예약분을 뺀 나머지다.
    expect(pop?.textContent).toContain("364k");
  });

  it("marks the number stale only while a turn has yet to report", () => {
    // 낡음을 주장할 수 있는 구간은 하나뿐이다 — 턴이 시작됐고 첫 delta가 아직 오지 않은 사이.
    logState = stateWith(measured(), "working");
    mount();
    expect(chip()?.className).toContain("is-stale");

    act(() => root?.unmount());
    container?.remove();
    // 라이브 값이 있으면 그 값은 실시간이므로 흐리게 그리면 사실이 아니다.
    logState = stateWith(measured({ liveTotal: 50_000 }), "working");
    mount();
    expect(chip()?.className).not.toContain("is-stale");

    act(() => root?.unmount());
    container?.remove();
    // 턴이 끝났으면 낡은 것이 아니라 마지막 측정이다.
    logState = stateWith(measured(), "done");
    mount();
    expect(chip()?.className).not.toContain("is-stale");
  });

  // 계기는 지시를 쓰는 손 옆에 산다 — 첨부와 발사 사이, 발사 버튼 바로 왼쪽이다.
  it("rides the composer control row, one step left of the send control", () => {
    mount();
    const actions = container?.querySelector(".agent-chat-composer-actions");
    expect(actions).not.toBeNull();
    const order = Array.from(actions?.children ?? [])
      .map((child) => child.className || child.tagName)
      .filter((name) => name !== "INPUT");
    expect(order).toEqual([
      "agent-chat-composer-attach",
      "agent-chat-ctx",
      "agent-chat-composer-send",
    ]);
    // 떠 있던 칩 줄의 잔재를 물려받지 않는다 — 이 행에서는 컴포저의 컨트롤 문법을 쓴다.
    expect(chip()?.className).not.toContain("agent-chat-mode-chip");
  });

  it("says nothing at all before the first number arrives", () => {
    // 0%짜리 미터는 빈 사실이 아니라 틀린 사실이다.
    logState = stateWith(null, "working");
    mount();
    expect(chip()).toBeNull();
  });
});
