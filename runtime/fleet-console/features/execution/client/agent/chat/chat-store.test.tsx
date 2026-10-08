// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectTerminalSettings } from "../../terminal/shared/terminal-preferences.js";
import { useAgentChatStream, type AgentChatViewState, type ChatWebSocketLike } from "./chat-store.js";
import { splitAgentChatTurn, type AgentChatStreamEvent, type AgentChatTurn } from "./chat-events.js";
import { AgentChatView } from "./chat-view.js";

class FakeWebSocket implements ChatWebSocketLike {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: string | ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: AgentChatViewState | null = null;
const ticketFetches: Array<{ readonly url: string; readonly body: unknown }> = [];

function Probe({ operationId, live }: { readonly operationId: string; readonly live: boolean }) {
  latest = useAgentChatStream(operationId, live);
  return null;
}

function mount(operationId: string, live: boolean): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(Probe, { operationId, live }));
  });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  ticketFetches.length = 0;
  latest = null;
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    ticketFetches.push({ url, body });
    return {
      ok: true,
      json: async () => ({ ticket: `ticket-for-${body?.operationId ?? "unknown"}`, ttlMs: 10_000, role: "control" }),
    } as Response;
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  latest = null;
  vi.unstubAllGlobals();
});

describe("useAgentChatStream", () => {
  it("requests a chat ticket and opens one WebSocket while the body is live", async () => {
    mount("op-live", true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(ticketFetches).toHaveLength(1);
    expect(ticketFetches[0]?.url).toBe("/api/v1/agent/ticket");
    expect(ticketFetches[0]?.body).toEqual({ operationId: "op-live", channel: "chat" });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toContain("/api/v1/terminal/ws?ticket=ticket-for-op-live");
    expect(FakeWebSocket.instances[0]?.closed).toBe(false);
    expect(latest?.connection).toBe("connecting");
  });

  it("does not open a WebSocket while the body is parked", () => {
    mount("op-parked", false);
    expect(ticketFetches).toHaveLength(0);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(latest?.connection).toBe("idle");
  });

  it("closes the WebSocket when the body leaves the live surface", async () => {
    mount("op-toggle", true);
    await act(async () => {
      await Promise.resolve();
    });
    const source = FakeWebSocket.instances[0];
    expect(source?.closed).toBe(false);
    act(() => {
      root!.render(createElement(Probe, { operationId: "op-toggle", live: false }));
    });
    expect(source?.closed).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(latest?.connection).toBe("idle");
  });

  it("opens a new WebSocket when a parked body becomes live", async () => {
    mount("op-return", false);
    expect(FakeWebSocket.instances).toHaveLength(0);
    act(() => {
      root!.render(createElement(Probe, { operationId: "op-return", live: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toContain("/api/v1/terminal/ws?ticket=ticket-for-op-return");
    expect(latest?.connection).toBe("connecting");
  });

  it("resets the journal when a socket reconnects so replay does not duplicate turns", async () => {
    mount("op-replay", true);
    await act(async () => {
      await Promise.resolve();
    });
    const first = FakeWebSocket.instances[0];
    expect(first).toBeTruthy();
    // 다른 세션의 수신은 도구 사이·최종 답변 직후·정비 명령 도중에 독립적으로 끼어든다.
    // 재접속도 같은 저널을 읽으므로 턴 경계와 답변·명령의 순서를 바꾸면 안 된다.
    const events: AgentChatStreamEvent[] = [
      // 답하기 전에 종료된 과거 지시는 turn-end가 없다. 재접속이 내부 replay 경계를 빼도 수신은 별도 머리다.
      { kind: "replay-start" },
      { kind: "dispatch", text: "unfinished history" },
      { kind: "replay-end", turns: 1 },
      { kind: "received", id: "after-history", from: "commander", text: "Resume work.", inTurn: false },
      { kind: "dispatch", text: "hello" },
      { kind: "turn-start" },
      { kind: "tool", id: "tool-1", name: "Read", detail: "file", toolDetail: { sections: [{ kind: "command", text: "requested input" }] } },
      { kind: "tool-result", id: "tool-1", ok: true, summary: "", toolDetail: { sections: [{ kind: "read", text: "actual read content" }] } },
      { kind: "received", id: "mid", from: "commander", text: "Check this too.", inTurn: true },
      { kind: "text", text: "FINAL" },
      { kind: "received", id: "late", from: "commander", text: "Next task.", inTurn: true },
      { kind: "turn-end", ok: true, answer: "FINAL" },
      { kind: "command", name: "compact" },
      { kind: "received", id: "command", from: "commander", text: "After compact.", inTurn: false },
      { kind: "command-progress", phase: "compacting" },
    ];
    const journal = events.map((event, index) => ({ seq: index + 1, event }));
    act(() => {
      first!.open();
      for (const frame of journal) first!.onmessage?.({ data: JSON.stringify(frame) });
    });
    expect(latest?.turns).toHaveLength(6);
    expect(latest?.turns[0]?.items).toHaveLength(0);
    expect(latest?.turns[1]?.items[0]?.id).toBe("after-history");
    expect(latest?.turns[2]?.dispatch?.text).toBe("hello");
    expect(latest?.turns[2]?.items.map((item) => item.type)).toEqual(["tool", "received", "text"]);
    const view = splitAgentChatTurn(latest!.turns[2]!);
    expect(view.answer).toBe("FINAL");
    expect(view.ledger.map((item) => item.type)).toEqual(["tool", "received"]);
    expect(view.ledger[0]?.toolDetail?.sections.map((section) => section.text)).toEqual(["requested input", "actual read content"]);
    expect(latest?.turns[3]?.items[0]?.id).toBe("late");
    expect(latest?.turns[4]).toMatchObject({ state: "working", command: { name: "compact", phase: "compacting" } });
    expect(latest?.turns[5]?.items[0]?.id).toBe("command");
    const end = { seq: journal.length + 1, event: { kind: "command-end" as const, ok: true, summary: "compacted" } };
    journal.push(end);
    act(() => first!.onmessage?.({ data: JSON.stringify(end) }));
    expect(latest?.turns[4]).toMatchObject({ state: "done", command: { summary: "compacted" } });
    const liveTurns = latest!.turns;

    act(() => {
      first!.close();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    const second = FakeWebSocket.instances[1];
    expect(second).toBeTruthy();
    act(() => {
      second!.open();
      second!.onmessage?.({ data: JSON.stringify({ seq: 0, event: { kind: "replay-start" } }) });
      for (const frame of journal) {
        if (frame.event.kind !== "replay-start" && frame.event.kind !== "replay-end") second!.onmessage?.({ data: JSON.stringify(frame) });
      }
      second!.onmessage?.({ data: JSON.stringify({ seq: journal.length + 1, event: { kind: "replay-end", turns: 1 } }) });
    });
    // settledAt은 라이브 애니메이션 전용 시각이므로 재생 계약에 포함되지 않는다.
    const durableTurns = (turns: readonly AgentChatTurn[] | undefined) => turns?.map((turn) => ({
      ...turn,
      items: turn.items.map(({ settledAt: _settledAt, ...item }) => item),
    }));
    expect(durableTurns(latest?.turns)).toEqual(durableTurns(liveTurns));
    expect(latest?.connection).toBe("open");
  });
});

describe("AgentChatView history auto-fold", () => {
  it("folds earlier turns on a new turn by default and keeps them open once the persisted setting is off", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const context = { operationId: "op-fold", language: "en", bodyLive: true, operation: { id: "op-fold", payload: {} }, runtimeState: null } as never;
    act(() => {
      root!.render(createElement(AgentChatView, { context, tourAnchors: false }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    const socket = FakeWebSocket.instances[0]!;
    let seq = 0;
    const emit = (...events: AgentChatStreamEvent[]) => act(() => {
      for (const event of events) socket.onmessage?.({ data: JSON.stringify({ seq: ++seq, event }) });
    });
    const newTurn = (text: string) => emit({ kind: "dispatch", text }, { kind: "turn-start" });
    const history = () => container!.querySelector<HTMLElement>(".agent-chat-history")!;
    act(() => socket.open());
    emit(
      { kind: "replay-start" },
      { kind: "dispatch", text: "first" },
      { kind: "turn-start" },
      { kind: "turn-end", ok: true, answer: "done" },
      { kind: "replay-end", turns: 1 },
      { kind: "snapshot-end", turns: 1 },
    );
    newTurn("second");

    // 기본(켜짐)은 현행 그대로다 — 손으로 펼친 이전 대화도 새 턴이 서면 다시 접힌다.
    expect(history().hidden).toBe(true);
    act(() => container!.querySelector<HTMLElement>(".fc-history-band")!.click());
    expect(history().hidden).toBe(false);
    newTurn("third");
    expect(history().hidden).toBe(true);

    // 서버 설정에 저장된 꺼짐이 하이드레이트로 돌아오면 열린 패널이 곧바로 펼치고, 새 턴에도 접지 않는다.
    let stored: Record<string, unknown> = { chatReadingWidth: "wide", chatHistoryAutoFold: false };
    connectTerminalSettings({
      read: async () => stored,
      write: async (_pluginId, value) => { stored = value; },
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(history().hidden).toBe(false);
    newTurn("fourth");
    expect(history().hidden).toBe(false);

    // 글리프로 다시 켜면 접히고, 값은 같은 설정 레코드에 다른 키를 지우지 않고 병합된다.
    const toggle = container!.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      toggle.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(history().hidden).toBe(true);
    expect(stored).toEqual({ chatReadingWidth: "wide", chatHistoryAutoFold: true });
  });
});
