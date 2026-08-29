// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { AgentChatView } from "./chat-view.js";
import type { AgentChatLogState, AgentChatTurn } from "./chat-events.js";

const NOTE = "한 프로토콜로 통일한 뒤 **최신 로스터**를 읽고 `Fable`은 제외합니다.";

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

function turn(overrides: Partial<AgentChatTurn> = {}): AgentChatTurn {
  return {
    dispatch: { text: "go" },
    items: [
      { type: "text", text: NOTE },
      { type: "tool", name: "mcp__fleet__gateway_models", detail: "한 번", state: "ok" },
    ],
    state: "working",
    toolCount: 1,
    draft: "",
    startedAt: 1,
    ...overrides,
  };
}

function stateWith(turns: readonly AgentChatTurn[]): AgentChatLogState {
  return {
    turns,
    replaying: false,
    snapshotting: false,
    observedTurns: 0,
    errorCode: null,
    jobs: [],
    context: null,
    queue: [],
    catalogEpoch: 0,
  };
}

beforeEach(() => {
  logState = stateWith([turn()]);
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

function note(): HTMLElement | null {
  return container?.querySelector<HTMLElement>(".agent-chat-ledger-note") ?? null;
}

describe("chat ledger commentary", () => {
  it("renders a step note as markdown, not as forced italics wrapping raw marks", () => {
    // 구간 문장은 답변과 같은 마크다운 경로다. italic 일반 텍스트로 그리면 `**굵게**`와
    // `` `코드` ``가 문법 그대로 남고 문장만 기울어진다 — 스크린샷의 그 결함이다.
    mount();
    const el = note();
    expect(el).not.toBeNull();
    expect(el?.className).toContain("markdown-body");
    expect(el?.querySelector("strong")?.textContent).toBe("최신 로스터");
    expect(el?.querySelector("code")?.textContent).toBe("Fable");
    expect(el?.textContent ?? "").not.toContain("**");
    expect(el?.textContent ?? "").not.toContain("`Fable`");
  });

  it("keeps markdown inside the completion seam that hands work to the answer", () => {
    // 끝난 턴은 과정을 접는다. 접힘 안에서도 같은 렌더 경로를 타야 한다 — 라이브에서만
    // 마크다운이고 접힘 안에서는 다시 italic 원문이 되면 같은 문장이 두 얼굴이 된다.
    // jsdom 의 details 는 닫혀도 자식을 돔에 남긴다. 여기서 묻는 것은 가시성이 아니라 경로다.
    logState = stateWith([turn({
      state: "done",
      durationMs: 74_000,
      answer: "다모델 판정을 돌리는 중입니다.",
    })]);
    mount();
    const fold = container?.querySelector("details.agent-chat-fold");
    expect(fold).not.toBeNull();
    expect(fold?.classList.contains("leads-to-answer")).toBe(true);
    expect(fold?.querySelector(".agent-chat-completion-node")).not.toBeNull();
    const summary = fold?.querySelector("summary");
    expect(summary?.querySelector(".agent-chat-completion-answer")?.textContent).toBe("응답");
    // 이름을 고정 문구로 덮지 않는다. 소요·결말·백그라운드 작업 수·문맥 증가량이 summary의
    // 실제 텍스트로 함께 읽혀야 한다.
    expect(summary?.hasAttribute("aria-label")).toBe(false);
    expect(summary?.textContent).toContain("74.0s 동안 작업함");
    expect(container?.querySelector(".agent-chat-answer")?.classList.contains("has-seam")).toBe(true);
    // 이음새가 Answer를 시각적으로 이미 부르므로 별도 kicker는 다시 세우지 않되, 본문 랜드마크의
    // 접근성 이름은 숨은 텍스트로 보존한다.
    expect(container?.querySelector(".agent-chat-answer-kicker")).toBeNull();
    expect(container?.querySelector(".agent-chat-answer > .agent-chat-sr-only")?.textContent).toBe("응답");
    const el = fold?.querySelector<HTMLElement>(".agent-chat-ledger-note") ?? null;
    expect(el).not.toBeNull();
    expect(el?.className).toContain("markdown-body");
    expect(el?.querySelector("strong")?.textContent).toBe("최신 로스터");
    expect(el?.querySelector("code")?.textContent).toBe("Fable");
  });

  it("keeps the standalone Answer kicker when a turn has no process to fold", () => {
    logState = stateWith([turn({
      items: [],
      state: "done",
      durationMs: 2_000,
      answer: "바로 답합니다.",
    })]);
    mount();
    expect(container?.querySelector(".agent-chat-fold")).toBeNull();
    expect(container?.querySelector(".agent-chat-answer")?.classList.contains("has-seam")).toBe(false);
    expect(container?.querySelector(".agent-chat-answer-kicker")?.textContent).toBe("응답");
  });
});
