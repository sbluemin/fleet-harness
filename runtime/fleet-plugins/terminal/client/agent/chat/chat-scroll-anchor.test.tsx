// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";

import { AgentChatView } from "./chat-view.js";
import type { AgentChatLogState } from "./chat-events.js";

function makeLogState(): AgentChatLogState {
  return {
    turns: [{ dispatch: { text: "go" }, items: [{ type: "text", text: "answer" }], state: "done", toolCount: 0, draft: "" }],
    replaying: false,
    snapshotting: false,
    observedTurns: 0,
    errorCode: null,
    jobs: [],
    context: null,
  };
}

// 로그 상태는 이 테스트의 관심사가 아니다 — 스크롤 앵커와 Follow 칩만 본다.
let logState: AgentChatLogState = makeLogState();

vi.mock("./chat-store.js", () => ({ useAgentChatStream: () => logState }));
vi.mock("../api.js", () => ({
  discardLaunchAttachment: async () => {},
  messageAgentSession: async () => {},
  uploadLaunchAttachment: async () => ({ id: "attachment" }),
}));
vi.mock("@fleet-console/markdown/styles.css", () => ({}));
vi.mock("./chat.css", () => ({}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let resizeCallbacks: Array<() => void> = [];

beforeEach(() => {
  logState = makeLogState();
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

function viewProps() {
  const context = {
    operationId: "op-1",
    theaterId: "theater-1",
    pluginId: "terminal",
    type: "agent",
    language: "en",
    operation: { id: "op-1", theaterId: "theater-1", type: "agent", pluginId: "terminal", title: "op", payload: {}, geometry: null, ts: { createdAt: 0, updatedAt: 0 } },
    runtimeState: { lifecycle: "live", activity: "idle" },
  } as unknown as OperationRenderContext;
  return {
    context,
    tourAnchors: false,
  };
}

function mountView() {
  if (!container) {
    container = document.createElement("div");
    document.body.append(container);
  }
  if (!root) root = createRoot(container);
  act(() => root?.render(createElement(AgentChatView, viewProps())));
  const log = container.querySelector<HTMLElement>(".agent-chat-log");
  if (!log) throw new Error("Missing chat log element");
  return log;
}

function growDraft(draft: string) {
  const [turn] = logState.turns;
  if (!turn) throw new Error("Missing seeded turn");
  logState = { ...logState, turns: [{ ...turn, draft }] };
  return mountView();
}

describe("chat log scroll anchor", () => {
  // War Room 스테이지 승격은 패널 높이를 바꾼다. 그 순간 앵커를 지키지 않으면 로그는 바뀐 높이 위에서
  // 예전 scrollTop 을 들고 있게 되고, 접혀 있던 패널이 펼쳐지는 경우 그 값이 곧 맨 위다.
  it("returns to the bottom when the panel is resized while following", () => {
    const log = mountView();
    stubMetrics(log, { scrollHeight: 1000, clientHeight: 400 });
    log.scrollTop = 0;

    act(() => { resizeCallbacks.forEach((fire) => fire()); });

    expect(log.scrollTop).toBe(1000);
  });

  it("keeps the reader's place instead of snapping to the bottom", () => {
    const log = mountView();
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
    const log = mountView();
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
    const log = mountView();
    stubMetrics(log, { scrollHeight: 1000, clientHeight: 0 });
    log.scrollTop = 0;
    act(() => { log.dispatchEvent(new Event("scroll")); });

    stubMetrics(log, { scrollHeight: 1000, clientHeight: 400 });
    act(() => { resizeCallbacks.forEach((fire) => fire()); });

    expect(log.scrollTop).toBe(1000);
  });

  // 언핀 상태에서 스트림이 자라면 예전 restoreAnchor 는 바닥 거리를 고정해 scrollTop 을
  // 끌어올린다(120 → 920). 성장 경로는 scrollTop 을 그대로 둬야 읽던 줄이 남는다.
  it("keeps scrollTop when the stream grows while the reader is unpinned", () => {
    const log = mountView();
    stubMetrics(log, { scrollHeight: 1000, clientHeight: 400 });
    log.scrollTop = 200;
    act(() => { log.dispatchEvent(new Event("scroll")); });

    stubMetrics(log, { scrollHeight: 1800, clientHeight: 400 });
    growDraft("x".repeat(80));

    expect(log.scrollTop).toBe(200);
  });

  // 성장 뒤 바닥 거리가 남으면 War Room 승격처럼 패널이 커질 때 restorePlace 가
  // 성장 전 거리로 scrollTop 을 꼬리 쪽으로 끌어올린다(200 → 800).
  it("refreshes the resize distance after unpinned stream growth", () => {
    const log = mountView();
    stubMetrics(log, { scrollHeight: 1000, clientHeight: 400 });
    log.scrollTop = 200;
    act(() => { log.dispatchEvent(new Event("scroll")); });

    stubMetrics(log, { scrollHeight: 1800, clientHeight: 400 });
    growDraft("x".repeat(80));
    expect(log.scrollTop).toBe(200);

    stubMetrics(log, { scrollHeight: 1800, clientHeight: 600 });
    act(() => { resizeCallbacks.forEach((fire) => fire()); });

    expect(log.scrollTop).toBe(0);
    expect(log.scrollTop).not.toBe(800);
  });

  it("follows the bottom when the stream grows while pinned", () => {
    const log = mountView();
    stubMetrics(log, { scrollHeight: 1000, clientHeight: 400 });
    log.scrollTop = 0;

    stubMetrics(log, { scrollHeight: 1800, clientHeight: 400 });
    growDraft("x".repeat(80));

    expect(log.scrollTop).toBe(1800);
  });

  it("counts the first live turn after an empty replay while the reader is away", () => {
    logState = { ...makeLogState(), turns: [] };
    const log = mountView();
    stubMetrics(log, { scrollHeight: 1000, clientHeight: 400 });
    log.scrollTop = 200;
    act(() => { log.dispatchEvent(new Event("scroll")); });

    logState = {
      ...logState,
      turns: [{ dispatch: { text: "first" }, items: [], state: "working", toolCount: 0, draft: "" }],
    };
    mountView();

    const chip = container?.querySelector<HTMLButtonElement>(".agent-chat-follow");
    expect(chip?.textContent).toBe("1 new");
  });

  it("does not count replay history before replay-end", () => {
    logState = { ...makeLogState(), turns: [], replaying: true, snapshotting: true };
    const log = mountView();
    stubMetrics(log, { scrollHeight: 1000, clientHeight: 400 });
    log.scrollTop = 200;
    act(() => { log.dispatchEvent(new Event("scroll")); });

    logState = {
      ...logState,
      turns: [{ dispatch: { text: "history" }, items: [], state: "done", toolCount: 0, draft: "" }],
    };
    mountView();

    expect(container?.querySelector(".agent-chat-follow")?.textContent).toBe("Follow");
  });

  it("does not count an in-flight turn restored after replay-end as a new arrival", () => {
    logState = { ...makeLogState(), turns: [], replaying: true, snapshotting: true };
    const log = mountView();
    stubMetrics(log, { scrollHeight: 1000, clientHeight: 400 });
    log.scrollTop = 200;
    act(() => { log.dispatchEvent(new Event("scroll")); });

    // 서버는 working 문법을 지키려고 opener를 replay-end 뒤에 두지만, snapshot-end 전까지는
    // 이미 보던 턴의 복원이다. Follow 칩이 새 도착으로 세면 안 된다.
    logState = {
      ...logState,
      replaying: false,
      turns: [{ dispatch: { text: "in flight" }, items: [], state: "working", toolCount: 0, draft: "" }],
    };
    mountView();
    logState = { ...logState, snapshotting: false };
    mountView();

    expect(container?.querySelector(".agent-chat-follow")?.textContent).toBe("Follow");
  });

  it("clears a queued receipt when its turn starts during reconnect", async () => {
    logState = {
      ...makeLogState(),
      turns: [{ dispatch: { text: "running" }, items: [], state: "working", toolCount: 0, draft: "" }],
    };
    mountView();
    const field = container?.querySelector<HTMLTextAreaElement>(".agent-chat-composer-input");
    if (!field) throw new Error("Missing chat composer input");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(field, "queued instruction");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container?.querySelector<HTMLButtonElement>(".agent-chat-composer-send")?.click();
    });
    expect(container?.querySelector(".agent-chat-composer-queued")?.textContent).toContain("1");

    logState = { ...logState, snapshotting: true };
    mountView();
    logState = {
      ...logState,
      replaying: false,
      observedTurns: 2,
      turns: [
        ...logState.turns,
        { dispatch: { text: "queued instruction" }, items: [], state: "working", toolCount: 0, draft: "" },
      ],
    };
    mountView();
    logState = { ...logState, snapshotting: false };
    mountView();

    expect(container?.querySelector(".agent-chat-composer-queued")).toBeNull();
  });

  it("does not let restored history consume a receipt queued during snapshot delivery", async () => {
    logState = {
      ...makeLogState(),
      snapshotting: true,
      observedTurns: 10,
      turns: [{ dispatch: { text: "restored" }, items: [], state: "working", toolCount: 0, draft: "" }],
    };
    mountView();
    const field = container?.querySelector<HTMLTextAreaElement>(".agent-chat-composer-input");
    if (!field) throw new Error("Missing chat composer input");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(field, "queued during snapshot");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container?.querySelector<HTMLButtonElement>(".agent-chat-composer-send")?.click();
    });

    // 이 receipt보다 앞서 시작한 턴이 snapshot-end에서 드러나도 새 지시를 소비하지 않는다.
    logState = { ...logState, snapshotting: false, observedTurns: 11 };
    mountView();

    expect(container?.querySelector(".agent-chat-composer-queued")?.textContent).toContain("1");
  });

  it("clears a queued receipt from the monotonic coordinate when capped history shrinks", async () => {
    logState = {
      ...makeLogState(),
      observedTurns: 2_000,
      turns: [{ dispatch: { text: "running" }, items: [], state: "working", toolCount: 0, draft: "" }],
    };
    mountView();
    const field = container?.querySelector<HTMLTextAreaElement>(".agent-chat-composer-input");
    if (!field) throw new Error("Missing chat composer input");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(field, "queued over cap");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container?.querySelector<HTMLButtonElement>(".agent-chat-composer-send")?.click();
    });

    logState = { ...logState, snapshotting: true };
    mountView();
    // JOURNAL_CAP이 과거를 밀어 화면에는 한 턴만 남아도 서버 누적 좌표는 새 턴을 말한다.
    logState = {
      ...logState,
      snapshotting: false,
      observedTurns: 2_001,
      turns: [{ dispatch: { text: "queued over cap" }, items: [], state: "working", toolCount: 0, draft: "" }],
    };
    mountView();

    expect(container?.querySelector(".agent-chat-composer-queued")).toBeNull();
  });

  it("counts new turns while the reader is away and clears the count on follow", () => {
    const log = mountView();
    stubMetrics(log, { scrollHeight: 1000, clientHeight: 400 });
    expect(container?.querySelector(".agent-chat-follow")).toBeNull();

    log.scrollTop = 200;
    act(() => { log.dispatchEvent(new Event("scroll")); });

    let chip = container?.querySelector<HTMLButtonElement>(".agent-chat-follow");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe("Follow");

    const priorTurns = logState.turns;
    logState = {
      ...logState,
      turns: [...priorTurns, { dispatch: { text: "next" }, items: [], state: "working", toolCount: 0, draft: "" }],
    };
    mountView();
    chip = container?.querySelector<HTMLButtonElement>(".agent-chat-follow");
    expect(chip?.textContent).toBe("1 new");
    expect(chip?.getAttribute("aria-label")).toBe("Follow the live log past 1 new turns");

    act(() => { chip?.click(); });
    expect(log.scrollTop).toBe(1000);
    expect(container?.querySelector(".agent-chat-follow")).toBeNull();
  });
});
