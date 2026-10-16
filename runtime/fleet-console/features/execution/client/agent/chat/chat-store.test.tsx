// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectTerminalSettings } from "../../terminal/shared/terminal-preferences.js";
import { createChatSocketSession, useAgentChatStream, type AgentChatViewState, type ChatWebSocketLike } from "./chat-store.js";
import type { HostSocket, HostTransport, HostSurfaceContext } from "@fleet-console/sdk/host-context";
import { HostMessageComposer } from "@fleet-console/sdk/composer";
import { HostAgentConversation } from "./host-conversation.js";
import { EMPTY_CONVERSATION_JOURNAL, reduceConversationJournal, type ConversationSnapshot } from "../../../conversation-journal.js";
import { splitAgentChatTurn, type AgentChatStreamEvent, type AgentChatTurn } from "./chat-events.js";
import { AgentChatView } from "./chat-view.js";
import { DEFAULT_EXPERIMENT_SETTINGS } from "@fleet-console/sdk/settings";
import type { GroupTimelineSnapshot } from "@fleet-console/sdk/conversation";
import type { OperationClusterSource } from "@fleet-console/sdk/plugin";
import { clearOperationRuntime, getState, setOperationRuntime, setState } from "../../../../../core/client/src/integration/store.js";
import { getAgentState, setAgentState } from "../store.js";
import { GroupClusterProvider, installGroupTimeline, useGroupTimeline } from "./group-timeline-store.js";
import { setFoldTurns } from "./group/fold-turns.js";
import { disposeOperationViewState, getComposerDraft, installOperationViewState, readTerminalViewPosition, saveTerminalViewPosition } from "../../operation-view-state.js";
import type { ClientConsoleStateCapability } from "@fleet-console/sdk/plugin";

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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

it("keeps HTTP history through capped replay and catches up without duplication across reconnect, clear, and session replacement", async () => {
  const generationA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const generationB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const row = (seq: number, text: string) => ({ seq, event: { kind: "text" as const, text } });
  const initial = [row(1, "Old answer"), row(2, "Recent answer")];
  let current: ConversationSnapshot = { generation: generationA, cursor: 2100,
    journal: [row(10, "Old answer"), row(2088, "Recent answer")].reduce((state, entry) => reduceConversationJournal(state, entry, "agent"), EMPTY_CONVERSATION_JOURNAL) };
  let resolveSnapshot: ((value: Response) => void) | null = null;
  let requests = 0;
  const abort = new AbortController();
  const context = {
    selection: { hostKey: "remote-A", theaterId: "theater", role: "commander", operationId: "agent" }, language: "en", hostLabel: "A", canWrite: () => true,
    transport: { scope: { hostKey: "remote-A", epoch: 1, signal: abort.signal },
      request: async (path: string) => path.endsWith("/chat-history") ? ++requests === 1 ? Response.json({ entries: initial }) : new Promise<Response>((resolve) => { resolveSnapshot = resolve; }) : Response.json({ sessions: [{ sessionId: "agent", chatActive: true, generation: "session-A", cwdLabel: "Fixture", status: "running", createdAt: 1 }] }),
      socket: () => new FakeWebSocket("remote-A"),
    },
    events: { subscribe: () => () => {}, onReconnect: () => () => {} },
    state: { read: (_key: string, fallback: unknown) => fallback, write: () => {} },
    chat: { Conversation: ({ entries }: { entries: GroupTimelineSnapshot["entries"] }) => createElement("div", null, ...entries.map((entry) => createElement("span", { key: entry.id }, "text" in entry ? entry.text : ""))) },
  } as unknown as HostSurfaceContext;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(createElement(HostAgentConversation, { context, title: "Agent", readOnlyLabel: "Read only", uploadUnsupported: "No upload" })); });
  expect(container.textContent).toBe("Old answerRecent answer");
  const emit = (socket: FakeWebSocket, seq: number, event: AgentChatStreamEvent, generation = current.generation) => socket.onmessage?.({ data: JSON.stringify({ seq, generation, event }) });
  const first = FakeWebSocket.instances[0]!;
  await act(async () => {
    first.open();
    emit(first, 2080, { kind: "replay-start" });
    emit(first, 2088, { kind: "text", text: "Recent answer" });
    emit(first, 2100.5, { kind: "snapshot-end", turns: 2 });
    emit(first, 2101, { kind: "text", text: "During HTTP" });
    resolveSnapshot!(Response.json({ conversation: current }));
  });
  expect(container.textContent).toBe("Old answerRecent answerDuring HTTP");
  current = { ...current, cursor: 2101, journal: reduceConversationJournal(current.journal, row(2101, "During HTTP"), "agent") };
  act(() => first.close());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  const second = FakeWebSocket.instances.at(-1)!;
  expect(second).not.toBe(first);
  await act(async () => {
    second.open(); emit(second, 2101, { kind: "text", text: "During HTTP" });
    resolveSnapshot!(Response.json({ conversation: current }));
  });
  expect(container.textContent).toBe("Old answerRecent answerDuring HTTP");
  act(() => { emit(second, 2102, { kind: "cleared" }); emit(second, 2101, { kind: "text", text: "Duplicate" }); });
  expect(container.textContent).toBe("");
  current = { generation: generationB, cursor: 1, journal: reduceConversationJournal(EMPTY_CONVERSATION_JOURNAL, row(1, "New session"), "agent") };
  act(() => second.close());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  const third = FakeWebSocket.instances.at(-1)!;
  await act(async () => { third.open(); emit(third, 1, { kind: "text", text: "New session" }); resolveSnapshot!(Response.json({ conversation: current })); });
  expect(container.textContent).toBe("New session");
  act(() => abort.abort());
  expect(ticketFetches).toEqual([]);
});

describe("Operation composer lifetime", () => {
  it("restores a host draft and does not clear it or another host after an old send finishes", async () => {
    const a = { text: "draft A" }, b = { text: "draft B" };
    const abortA = new AbortController();
    const context = (hostKey: string, saved: { text: string }, signal: AbortSignal) => ({
      selection: { hostKey, theaterId: "same-theater", role: "commander", operationId: "same-operation" },
      transport: { scope: { hostKey, epoch: 1, signal } }, canWrite: () => true,
      state: { read: () => saved.text, write: (_key: string, text: string) => { saved.text = text; } },
    } as unknown as HostSurfaceContext);
    let finish: () => void = () => undefined;
    const send = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const render = (key: string, ctx: HostSurfaceContext) => createElement(HostMessageComposer, { key, context: ctx, send, label: "Message", placeholder: "Message", sendLabel: "Send", readOnlyLabel: "Read only", uploadUnsupported: "No upload" });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    act(() => { root!.render(render("a", context("a", a, abortA.signal))); });
    act(() => { container!.querySelector<HTMLButtonElement>("button")!.click(); });
    expect(send).toHaveBeenCalledWith("draft A");
    abortA.abort();
    act(() => { root!.render(render("b", context("b", b, new AbortController().signal))); });
    await act(async () => { finish(); await Promise.resolve(); });
    expect(container.querySelector("textarea")?.value).toBe("draft B");
    expect(a.text).toBe("draft A");
    act(() => { root!.render(render("a-return", context("a", a, new AbortController().signal))); });
    expect(container.querySelector("textarea")?.value).toBe("draft A");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps a send alive without a view and does not resend or erase a newer draft", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const draft = getComposerDraft("op-send-lifetime");
    const unsubscribe = draft.subscribe(() => {});
    draft.setText("send once");
    const sending = draft.send(draft.read().text);
    unsubscribe(); // HTTP 응답을 기다리는 동안 표시 본문만 레이아웃에서 내려간다.
    const returned = getComposerDraft("op-send-lifetime");
    expect(returned.read()).toMatchObject({ text: "send once", sending: true });
    expect(await returned.send("send once")).toBe(false);
    returned.setText("next instruction");
    finish({ ok: true } as Response);
    expect(await sending).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(returned.read()).toMatchObject({ text: "next instruction", sending: false, failed: false });
    disposeOperationViewState("op-send-lifetime");
  });

  it("releases deleted Operation drafts and rejects a late upload and terminal cleanup", async () => {
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: () => "blob:owned-draft", revokeObjectURL: revoke });
    let finish!: (response: Response) => void;
    const fetch = vi.fn((input: RequestInfo | URL) => String(input) === "/api/v1/agent/attachments"
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : Promise.resolve({ ok: true } as Response));
    vi.stubGlobal("fetch", fetch);
    let ids = ["op-upload-lifetime"];
    let changed!: () => void;
    const dispose = installOperationViewState({
      getOperations: () => ids.map((id) => ({ id })),
      subscribe: (listener: () => void) => { changed = listener; return () => {}; },
    } as unknown as ClientConsoleStateCapability);
    const draft = getComposerDraft(ids[0]!);
    draft.setText("keep until closed");
    draft.addFile(new File(["image"], "owned.png", { type: "image/png" }));
    expect(getComposerDraft(ids[0]!).read().attachments).toHaveLength(1);
    ids = [];
    changed();
    expect(revoke).toHaveBeenCalledWith("blob:owned-draft");
    saveTerminalViewPosition("op-upload-lifetime", { following: false, bottomDistance: 20 });
    expect(readTerminalViewPosition("op-upload-lifetime")).toBeUndefined();
    finish({ ok: true, json: async () => ({ id: "late-attachment" }) } as Response);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledWith("/api/v1/agent/attachments/late-attachment", expect.objectContaining({ method: "DELETE" }));
    expect(draft.read()).toMatchObject({ text: "", attachments: [] });
    dispose();
  });
});

describe("useAgentChatStream", () => {
  it("uses the host socket without a renderer ticket and stops commands when its scope ends", async () => {
    const abort = new AbortController();
    const socket = new FakeWebSocket("host-bound");
    const request = vi.fn(async () => { throw new Error("remote_ticket_forbidden"); });
    const events = vi.fn();
    const transport: HostTransport = {
      scope: { hostKey: "remote", epoch: 3, signal: abort.signal },
      request,
      events: () => { throw new Error("unexpected_sse"); },
      socket: vi.fn(() => socket as unknown as HostSocket),
      resourceUrl: () => { throw new Error("unexpected_resource"); },
    };
    let writable = false;
    const session = createChatSocketSession({ operationId: "same-operation", transport, canWrite: () => writable, onConnection: () => undefined, onEvent: events });
    session.start();
    socket.open();
    expect(request).not.toHaveBeenCalled();
    expect(ticketFetches).toHaveLength(0);
    expect(transport.socket).toHaveBeenCalledWith("/api/v1/terminal/ws", { operationId: "same-operation", channel: "chat" });
    await expect(session.send({ type: "stop" })).rejects.toThrow("read_only");
    writable = true;
    const sending = session.send({ type: "stop" });
    const frame = JSON.parse(socket.sent[0]!) as { id: string };
    socket.onmessage?.({ data: JSON.stringify({ type: "ok", id: frame.id }) });
    await sending;
    abort.abort();
    expect(socket.closed).toBe(true);
    socket.onmessage?.({ data: JSON.stringify({ type: "late-event" }) });
    expect(events).not.toHaveBeenCalled();
    await expect(session.send({ type: "stop" })).rejects.toThrow("read_only");
    session.dispose();
  });

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

it("keeps independent group journals alive across view closure, merges only confirmed message identities, and reads dormant history without waking", async () => {
  const previous = getState();
  const previousAgent = getAgentState();
  let group: GroupTimelineSnapshot | undefined;
  const board = { operationId: "root", members: [{ kind: "member" as const, operationId: "member", name: "Verifier", mark: { number: 1, tone: "teal" } }], events: [], decision: null };
  const clusters = [{ id: "objective", theaterId: "theater", title: "Objective", root: "root", members: [], conversation: board }];
  const clusterSource: OperationClusterSource = { get: () => clusters, subscribe: () => () => {} };
  const session = (id: string) => ({ sessionId: id, terminalSessionId: id, cwdLabel: "fixture", status: "live" as const, turnState: "running" as const, chatActive: true, createdAt: 1, resumeAvailable: true });
  setState({ operations: [{ id: "root", theaterId: "theater", title: "Commander", type: "agent", pluginId: null, geometry: null,
    payload: { chatMode: true }, ts: { createdAt: 1, updatedAt: 1 }, childSessions: [{ id: "member", payload: { chatMode: true }, ts: { createdAt: 2, updatedAt: 2 } },
      { id: "archived", payload: { chatMode: true }, ts: { createdAt: 3, updatedAt: 3 } }, { id: "waking", payload: { chatMode: true }, ts: { createdAt: 4, updatedAt: 4 } }] }],
    operationRuntime: { root: { lifecycle: "live", activity: "running" }, member: { lifecycle: "live", activity: "running" } } });
  setOperationRuntime("root", { lifecycle: "live", activity: "running" });
  setOperationRuntime("member", { lifecycle: "live", activity: "running" });
  setOperationRuntime("archived", { lifecycle: "dormant" });
  setOperationRuntime("waking", { lifecycle: "dormant" });
  const dormant = (id: string) => ({ ...session(id), status: "dormant" as const, chatActive: false });
  setAgentState({ sessions: { root: session("root"), member: session("member"), archived: dormant("archived"), waking: dormant("waking") } });
  // 휴면 참여자의 지난 대화는 파일 읽기 라우트로만 온다. 응답 시점은 테스트가 쥔다.
  const histories = new Map<string, (text: string) => void>();
  const ticketOnly = fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const history = /\/sessions\/([^/]+)\/chat-history$/.exec(String(input));
    if (!history) return ticketOnly(input, init);
    const text = await new Promise<string>((resolve) => histories.set(history[1]!, resolve));
    return { ok: true, json: async () => ({ entries: [{ seq: 1, at: 50, event: { kind: "text", text } }], truncated: false }) } as Response;
  });
  const dispose = installGroupTimeline({ experiments: { read: () => DEFAULT_EXPERIMENT_SETTINGS, subscribe: () => () => {} } });
  function GroupProbe() { group = useGroupTimeline("root"); return null; }
  const render = () => act(() => root!.render(createElement(GroupClusterProvider, { value: clusterSource }, createElement(GroupProbe))));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  try {
    render();
    await act(async () => { await Promise.resolve(); });
    expect(FakeWebSocket.instances).toHaveLength(2);
    const source = FakeWebSocket.instances.find((socket) => socket.url.includes("ticket-for-root"))!;
    const target = FakeWebSocket.instances.find((socket) => socket.url.includes("ticket-for-member"))!;
    const emit = (socket: FakeWebSocket, seq: number, event: AgentChatStreamEvent) => socket.onmessage?.({ data: JSON.stringify({ seq, at: seq * 100, event }) });
    act(() => {
      source.open(); target.open();
      emit(source, 1, { kind: "dispatch", text: "Start the review" });
      emit(source, 2, { kind: "text", text: "I will delegate." });
      emit(source, 3, { kind: "tool", id: "send-1", name: "SendMessage", detail: "Verifier", toolDetail: { sections: [{ kind: "message", text: "→ Verifier\nReview this" }] } });
      emit(source, 4, { kind: "tool-result", id: "send-1", ok: true, summary: "Delivered", recipientOperationId: "member" });
      emit(source, 5, { kind: "snapshot-end", turns: 1 });
    });
    // 서버의 확정 좌표가 있으면 수신 원장 없이도 명부의 역할·몽글 좌표가 선다. 도착을 꾸미지는 않는다.
    expect(group!.entries.find((entry) => entry.kind === "delegation")).toMatchObject({ received: false, ok: true, recipients: [{ operationId: "member", name: "Verifier", mark: { number: 1, tone: "teal" } }] });
    act(() => {
      emit(target, 5, { kind: "received", id: "root:send-1", from: "Commander", senderOperationId: "root", text: "Review this", inTurn: false });
      emit(target, 6, { kind: "text", text: "Review complete" });
      emit(source, 7, { kind: "snapshot-end", turns: 1 });
      emit(target, 8, { kind: "snapshot-end", turns: 1 });
    });
    expect(group!.entries.filter((entry) => entry.kind === "delegation")).toHaveLength(1);
    expect(group!.entries.find((entry) => entry.kind === "delegation")).toMatchObject({ received: true, ok: true, result: "Delivered", recipients: [{ operationId: "member", mark: { number: 1, tone: "teal" } }] });
    expect(group!.working.map((speaker) => speaker.operationId)).toEqual(["root", "member"]);
    expect(group!.preview).toMatchObject({ text: "Review complete", speaker: { operationId: "member" } });
    act(() => {
      emit(target, 9, { kind: "tool", id: "reply", name: "SendMessage", detail: "Session", toolDetail: { sections: [{ kind: "message", text: "→ Session\nReport" }] } });
      emit(target, 10, { kind: "tool-result", id: "reply", ok: true, summary: "Delivered", recipientOperationId: "root" });
    });
    expect(group!.entries.find((entry) => entry.id === "delegation:member:reply")).toMatchObject({ received: false, recipients: [{ operationId: "root", kind: "commander" }] });
    // 휴면 참여자: ticket·소켓 없이 지난 대화가 읽기 전용으로 선다.
    expect(ticketFetches.some(({ body }) => ["archived", "waking"].includes((body as { operationId?: string } | null)?.operationId ?? ""))).toBe(false);
    expect([...histories.keys()].sort()).toEqual(["archived", "waking"]);
    await act(async () => { histories.get("archived")!("Earlier verdict"); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(group!.entries.find((entry) => entry.kind === "message" && entry.operationId === "archived")).toMatchObject({ text: "Earlier verdict", at: 50 });
    expect(group!.unavailableOperationIds).toEqual(["waking"]);
    // 이력을 받기 전에 재개되면 live 스냅숏이 권위다 — 늦게 도착한 이력이 그것을 덮지 않는다.
    act(() => {
      setOperationRuntime("waking", { lifecycle: "live", activity: "idle" });
      setAgentState({ sessions: { ...getAgentState().sessions, waking: session("waking") } });
    });
    await act(async () => { await Promise.resolve(); });
    const waking = FakeWebSocket.instances.find((socket) => socket.url.includes("ticket-for-waking"))!;
    act(() => { waking.open(); emit(waking, 1, { kind: "text", text: "Live answer" }); emit(waking, 2, { kind: "snapshot-end", turns: 1 }); });
    await act(async () => { histories.get("waking")!("Stale history"); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(group!.entries.filter((entry) => entry.kind === "message" && entry.operationId === "waking").map((entry) => entry.kind === "message" ? entry.text : "")).toEqual(["Live answer"]);
    act(() => { root!.render(null); });
    expect(source.closed || target.closed).toBe(false);
    act(() => { emit(target, 11, { kind: "received", id: "root:different-call", from: "Commander", text: "Review this", inTurn: false }); });
    render();
    expect(group!.entries.filter((entry) => entry.kind === "delegation")).toHaveLength(3);
    act(() => { emit(source, 10, { kind: "cleared" }); });
    expect(group!.entries.some((entry) => entry.kind === "message" && entry.operationId === "root")).toBe(false);
    expect(group!.preview?.text).toBe("Review complete");
    const humanInput = { id: "10d824d9-7c30-4c0b-a15f-47f122e95b29", targetOperationId: "member" };
    act(() => {
      emit(source, 11, { kind: "dispatch", text: "Person told Verifier: exact words", by: { kind: "plugin", pluginId: "objectives", humanInput: { ...humanInput, copy: true } } });
      emit(target, 12, { kind: "dispatch", text: "exact words", by: { kind: "plugin", pluginId: "objectives", humanInput } });
    });
    const authored = group!.entries.filter((entry) => entry.id === `human:${humanInput.id}`);
    expect(authored).toHaveLength(1);
    expect(authored[0]).toMatchObject({ text: "exact words", speaker: { kind: "human" }, recipient: { operationId: "member", name: "Verifier" } });
  } finally {
    act(() => { dispose(); root?.unmount(); root = null; });
    clearOperationRuntime("root"); clearOperationRuntime("member"); clearOperationRuntime("archived"); clearOperationRuntime("waking");
    setState(previous); setAgentState(previousAgent);
  }
  expect(FakeWebSocket.instances.every((socket) => socket.closed)).toBe(true);
});

it("keeps group timeline sockets and dormant history closed until the conversation layout is active or a folded mobile group is open", async () => {
  const previous = getState();
  const previousAgent = getAgentState();
  let active = false;
  let subject: string | null = null;
  const listeners = new Set<() => void>();
  setState({ operations: [{ id: "root", theaterId: "theater", title: "Commander", type: "agent", pluginId: null, geometry: null,
    payload: { chatMode: true }, ts: { createdAt: 1, updatedAt: 1 }, childSessions: [{ id: "archived", payload: { chatMode: true }, ts: { createdAt: 3, updatedAt: 3 } }] }],
    operationRuntime: { root: { lifecycle: "live", activity: "running" }, archived: { lifecycle: "dormant" } } });
  setOperationRuntime("root", { lifecycle: "live", activity: "running" });
  setOperationRuntime("archived", { lifecycle: "dormant" });
  const session = { sessionId: "root", terminalSessionId: "root", cwdLabel: "fixture", status: "live" as const, turnState: "running" as const, chatActive: true, createdAt: 1, resumeAvailable: true };
  setAgentState({ sessions: { root: session, archived: { ...session, sessionId: "archived", terminalSessionId: "archived", status: "dormant" as const, chatActive: false } } });
  const dispose = installGroupTimeline({
    experiments: { read: () => DEFAULT_EXPERIMENT_SETTINGS, subscribe: () => () => {} },
    conversation: { isActive: () => active, subjectOperationId: () => subject, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } },
  });
  function GroupProbe() { useGroupTimeline("root"); return null; }
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  try {
    act(() => { root!.render(createElement(GroupProbe)); });
    await act(async () => { await Promise.resolve(); });
    // 대화 중심 화면이 아니면 채팅이 살아 있어도 그룹 소켓과 휴면 이력을 열지 않는다.
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(ticketFetches.some((entry) => entry.url.includes("chat-history"))).toBe(false);
    active = true;
    act(() => { for (const listener of listeners) listener(); });
    await act(async () => { await Promise.resolve(); });
    expect(FakeWebSocket.instances.filter((socket) => !socket.closed)).toHaveLength(1);
    expect(FakeWebSocket.instances.some((socket) => socket.url.includes("ticket-for-root"))).toBe(true);
    expect(ticketFetches.some((entry) => entry.url.includes("/sessions/archived/chat-history"))).toBe(true);
    active = false;
    act(() => { for (const listener of listeners) listener(); });
    expect(FakeWebSocket.instances.every((socket) => socket.closed)).toBe(true);
    // 모바일: 그 그룹 대화를 열어도 「턴 접기」가 꺼져 있으면 화면은 1:1 원장이라 그룹 소켓을 열지 않는다.
    subject = "root";
    act(() => { for (const listener of listeners) listener(); });
    await act(async () => { await Promise.resolve(); });
    expect(FakeWebSocket.instances.every((socket) => socket.closed)).toBe(true);
    // 켜면 열린 그 루트의 몫만 열고, 대화 목록(주인 없음)으로 돌아가면 닫는다.
    act(() => { setFoldTurns(true); });
    await act(async () => { await Promise.resolve(); });
    expect(FakeWebSocket.instances.filter((socket) => !socket.closed).map((socket) => socket.url.includes("ticket-for-root"))).toEqual([true]);
    subject = null;
    act(() => { for (const listener of listeners) listener(); });
    expect(FakeWebSocket.instances.every((socket) => socket.closed)).toBe(true);
  } finally {
    act(() => { setFoldTurns(false); dispose(); root?.unmount(); root = null; });
    clearOperationRuntime("root"); clearOperationRuntime("archived");
    setState(previous); setAgentState(previousAgent);
  }
});
