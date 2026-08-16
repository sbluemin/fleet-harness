// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentChatStream, type AgentChatViewState, type ChatWebSocketLike } from "./chat-store.js";

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
    expect(ticketFetches[0]?.url).toBe("/plugins/terminal/agent/ticket");
    expect(ticketFetches[0]?.body).toEqual({ operationId: "op-live", channel: "chat" });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toContain("/plugins/terminal/ws?ticket=ticket-for-op-live");
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
    expect(FakeWebSocket.instances[0]?.url).toContain("/plugins/terminal/ws?ticket=ticket-for-op-return");
    expect(latest?.connection).toBe("connecting");
  });

  it("resets the journal when a socket reconnects so replay does not duplicate turns", async () => {
    mount("op-replay", true);
    await act(async () => {
      await Promise.resolve();
    });
    const first = FakeWebSocket.instances[0];
    expect(first).toBeTruthy();
    const replay = { seq: 1, event: { kind: "dispatch", text: "hello" } };
    act(() => {
      first!.open();
      first!.onmessage?.({ data: JSON.stringify(replay) });
    });
    expect(latest?.turns).toHaveLength(1);
    expect(latest?.turns[0]?.dispatch?.text).toBe("hello");

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
      second!.onmessage?.({ data: JSON.stringify(replay) });
    });
    expect(latest?.turns).toHaveLength(1);
    expect(latest?.connection).toBe("open");
  });
});
