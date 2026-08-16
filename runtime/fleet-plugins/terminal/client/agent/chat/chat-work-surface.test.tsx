// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { AgentChatView } from "./chat-view.js";
import type { AgentChatJob, AgentChatLogState } from "./chat-events.js";

// 스트림 상태는 이 테스트가 직접 쥔다 — 재접속으로 원장이 되감기는 순간을 만들어야 하기 때문이다.
let logState: AgentChatLogState;

const detailCalls: string[] = [];

vi.mock("./chat-store.js", () => ({ useAgentChatStream: () => logState }));
vi.mock("../api.js", () => ({
  answerAgentChatAsk: async () => {},
  stopAgentChatTurn: async () => {},
  readAgentChatJobDetail: async (_op: string, jobId: string) => {
    detailCalls.push(jobId);
    return null;
  },
}));
vi.mock("@fleet-console/markdown/styles.css", () => ({}));
vi.mock("./chat.css", () => ({}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function job(overrides: Partial<AgentChatJob> = {}): AgentChatJob {
  return { id: "w1", kind: "workflow", title: "two-step", open: true, stages: [], ends: 0, ...overrides };
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
  detailCalls.length = 0;
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

function strip(): HTMLButtonElement | null {
  return container?.querySelector<HTMLButtonElement>(".agent-chat-strip") ?? null;
}

function workPane(): HTMLElement | null {
  return container?.querySelector<HTMLElement>(".agent-chat-work") ?? null;
}

function logVisible(): boolean {
  const log = container?.querySelector(".agent-chat-log");
  return log !== null && log !== undefined && !log.hasAttribute("hidden");
}

describe("chat work surface", () => {
  it("stays out of the way until the session has background work", () => {
    mount();
    expect(strip()).toBeNull();
    expect(workPane()).toBeNull();
    expect(logVisible()).toBe(true);
  });

  it("opens the work pane beside the conversation, never instead of it", () => {
    // 이 표면의 요점 자체다. 탭은 대화를 통째로 숨겼는데, 백그라운드 작업은 대화를 대신하는 것이
    // 아니라 대화 옆에서 동시에 돈다 — 하나를 고르게 만들면 무엇이 도는지 보려고 무엇을 물었는지를 잃는다.
    logState = stateWith([job()]);
    mount();
    const door = strip();
    expect(door).not.toBeNull();
    act(() => { door?.click(); });

    expect(workPane()).not.toBeNull();
    expect(logVisible()).toBe(true);
  });

  it("keeps a door to the work surface after the last job settles", () => {
    // 스트립이 살아 있는 잡에만 서면, 마지막 잡이 끝나는 순간 지난 작업에 닿을 문이 사라진다.
    // 탭이 지던 몫이라 탭을 걷은 이상 쉬는 스트립이 그 자리를 이어받아야 한다.
    logState = stateWith([job({ open: false, status: "completed" })]);
    mount();
    const door = strip();
    expect(door).not.toBeNull();
    expect(door?.className).toContain("is-rest");
    act(() => { door?.click(); });
    expect(workPane()).not.toBeNull();
  });

  it("keeps the collapse door when the job ledger resets underneath the open pane", () => {
    // 재접속이 리듀서를 되감고 저널에 잡 이벤트가 남아 있지 않으면 원장이 비어 버린다. 그때
    // 접는 문까지 사라지면 작업 면이 열린 채 굳는다.
    logState = stateWith([job()]);
    mount();
    act(() => { strip()?.click(); });
    expect(workPane()).not.toBeNull();

    logState = stateWith([]);
    render();

    const cap = container?.querySelector<HTMLButtonElement>(".agent-chat-work-cap");
    expect(cap).not.toBeNull();
    act(() => { cap?.click(); });
    expect(workPane()).toBeNull();
    expect(logVisible()).toBe(true);
  });
});

describe("chat work surface — floating controls", () => {
  it("keeps the floating chip row inside the conversation pane", () => {
    // 패널 전체에 걸어 두면 작업 면이 열린 순간 그 오른쪽 위로 넘어가 접기 컨트롤을 덮는다.
    // 실측에서 elementFromPoint가 접기 꺾쇠 자리에서 칩을 집었다 — 눌러도 접히지 않는다.
    logState = stateWith([job()]);
    mount();
    act(() => { strip()?.click(); });
    const chips = container?.querySelector(".agent-view-chip-row");
    expect(chips).not.toBeNull();
    expect(chips?.closest(".agent-chat-pane")).not.toBeNull();
    expect(chips?.closest(".agent-chat-work")).toBeNull();
  });
});

describe("chat work surface — log padding", () => {
  it("reserves the strip's room whichever form the strip is in", () => {
    // 도는 잡이 있든 다 끝났든 스트립은 같은 자리에 같은 높이로 선다. 쉬는 형태에만 여백을 빼면
    // 마지막 줄이 그 알약 뒤에 갇혀 스크롤로도 빠져나오지 못한다.
    for (const settled of [false, true]) {
      logState = stateWith([job(settled ? { open: false, status: "completed" } : {})]);
      mount();
      expect(container?.querySelector(".agent-chat-log")?.className).toContain("has-strip");
      act(() => root?.unmount());
      container?.remove();
      root = null;
      container = null;
    }
  });
});

describe("chat work surface — job detail timing", () => {
  it("asks again when the outcome lands after the job already closed", async () => {
    // 백그라운드 셸은 task_updated(killed)가 먼저 닫고, 출력 파일의 좌표는 그 뒤 task_notification이
    // 들고 온다(실측 순서). 상세를 열어 둔 채 잡이 끝나면 첫 요청이 좌표보다 먼저 도착해 빈손으로
    // 돌아오는데, 다시 묻지 않으면 "기록 없음"이 영영 굳는다.
    //
    // 그 알림은 **status만** 실어 올 수 있다(매퍼가 허용하는 형태다). 그래서 여기서도 요약도
    // 소요 시간도 더하지 않고 도착 횟수만 올린다 — 내용으로 도착을 추론하는 구현은 여기서 죽는다.
    const closed = { id: "b1", kind: "shell" as const, title: "loop", open: false, status: "stopped" as const, stages: [], ends: 1 };
    logState = { ...stateWith([closed]), jobs: [closed] };
    mount();
    act(() => { strip()?.click(); });
    act(() => { container?.querySelector<HTMLButtonElement>(".agent-chat-work .agent-chat-job")?.click(); });
    await act(async () => { await Promise.resolve(); });
    const first = detailCalls.length;
    expect(first).toBeGreaterThan(0);

    // 결말 보고가 도착한다 — 잡은 이미 닫혀 있었고 id도 그대로다.
    const reported = { ...closed, ends: closed.ends + 1 };
    logState = { ...stateWith([reported]), jobs: [reported] };
    render();
    await act(async () => { await Promise.resolve(); });
    expect(detailCalls.length).toBeGreaterThan(first);
  });
});
