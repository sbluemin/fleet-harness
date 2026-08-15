// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { AgentChatView } from "./chat-view.js";
import type { AgentChatLogState } from "./chat-events.js";

// 로그 상태는 이 테스트의 관심사가 아니다 — 스크롤 앵커만 본다.
const logState: AgentChatLogState = {
  turns: [{ dispatch: { text: "go" }, items: [{ type: "text", text: "answer" }], state: "done", toolCount: 0, draft: "" }],
  replaying: false,
  replayedTurns: 1,
  errorCode: null,
};

vi.mock("./chat-store.js", () => ({ useAgentChatStream: () => logState }));
vi.mock("@fleet-console/markdown/styles.css", () => ({}));
vi.mock("./chat.css", () => ({}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let resizeCallbacks: Array<() => void> = [];

beforeEach(() => {
  resizeCallbacks = [];
  // jsdom 에는 ResizeObserver 가 없다. 발화 시점을 이 테스트가 직접 쥔다.
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly cb: () => void) { resizeCallbacks.push(() => this.cb()); }
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

/** jsdom 은 레이아웃이 없으므로 스크롤 메트릭을 직접 세운다. */
function stubMetrics(log: HTMLElement, { scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(log, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(log, "clientHeight", { value: clientHeight, configurable: true });
}

function renderView() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
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
  const log = container.querySelector<HTMLElement>(".agent-chat-log");
  if (!log) throw new Error("Missing chat log element");
  return log;
}

describe("chat log scroll anchor", () => {
  // War Room 스테이지 승격은 패널 높이를 바꾼다. 그 순간 앵커를 지키지 않으면 로그는 바뀐 높이 위에서
  // 예전 scrollTop 을 들고 있게 되고, 접혀 있던 패널이 펼쳐지는 경우 그 값이 곧 맨 위다.
  it("returns to the bottom when the panel is resized while following", () => {
    const log = renderView();
    stubMetrics(log, { scrollHeight: 1000, clientHeight: 400 });
    log.scrollTop = 0;

    act(() => { resizeCallbacks.forEach((fire) => fire()); });

    expect(log.scrollTop).toBe(1000);
  });

  it("keeps the reader's place instead of snapping to the bottom", () => {
    const log = renderView();
    stubMetrics(log, { scrollHeight: 1000, clientHeight: 400 });

    // 사용자가 위로 올려 읽는 중 — 바닥까지 400px 남았다.
    log.scrollTop = 200;
    act(() => { log.dispatchEvent(new Event("scroll")); });

    // 패널이 커져 보이는 높이가 늘어도 같은 내용이 보여야 한다.
    stubMetrics(log, { scrollHeight: 1000, clientHeight: 600 });
    act(() => { resizeCallbacks.forEach((fire) => fire()); });

    expect(log.scrollTop).toBe(0);
    expect(log.scrollTop).not.toBe(1000);
  });

  // 복원 자체가 낳은 scroll 이벤트를 사용자 의도로 읽으면, 한 번 튄 스크롤이 영영 바닥으로 못 돌아온다.
  it("does not let its own restore turn following off", () => {
    const log = renderView();
    stubMetrics(log, { scrollHeight: 1000, clientHeight: 400 });
    log.scrollTop = 0;

    act(() => {
      resizeCallbacks.forEach((fire) => fire());
      log.dispatchEvent(new Event("scroll"));
    });
    // 두 번째 리사이즈에서도 여전히 바닥을 따라가야 한다.
    stubMetrics(log, { scrollHeight: 1400, clientHeight: 400 });
    act(() => { resizeCallbacks.forEach((fire) => fire()); });

    expect(log.scrollTop).toBe(1400);
  });

  // 접힌 패널(높이 0)의 값으로는 의도를 읽을 수 없다.
  it("ignores a scroll event measured while the panel has no height", () => {
    const log = renderView();
    stubMetrics(log, { scrollHeight: 1000, clientHeight: 0 });
    log.scrollTop = 0;
    act(() => { log.dispatchEvent(new Event("scroll")); });

    stubMetrics(log, { scrollHeight: 1000, clientHeight: 400 });
    act(() => { resizeCallbacks.forEach((fire) => fire()); });

    expect(log.scrollTop).toBe(1000);
  });
});
