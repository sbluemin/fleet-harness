// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentChatStream, type AgentChatViewState } from "./chat-store.js";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: AgentChatViewState | null = null;

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
  FakeEventSource.instances = [];
  latest = null;
  vi.stubGlobal("EventSource", FakeEventSource);
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
  it("opens one EventSource while the body is live", () => {
    mount("op-live", true);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe("/plugins/terminal/agent/sessions/op-live/chat-stream");
    expect(FakeEventSource.instances[0]?.closed).toBe(false);
    expect(latest?.connection).toBe("connecting");
  });

  it("does not open an EventSource while the body is parked", () => {
    mount("op-parked", false);
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(latest?.connection).toBe("idle");
  });

  it("closes the EventSource when the body leaves the live surface", () => {
    mount("op-toggle", true);
    const source = FakeEventSource.instances[0];
    expect(source?.closed).toBe(false);
    act(() => {
      root!.render(createElement(Probe, { operationId: "op-toggle", live: false }));
    });
    expect(source?.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
    // 화면 밖에서도 마지막 로그를 지키므로 lost로 뒤집지 않는다 — 다시 보이면 재접속이 저널을 되쓴다.
    expect(latest?.connection).toBe("idle");
  });

  it("opens a new EventSource when a parked body becomes live", () => {
    mount("op-return", false);
    expect(FakeEventSource.instances).toHaveLength(0);
    act(() => {
      root!.render(createElement(Probe, { operationId: "op-return", live: true }));
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe("/plugins/terminal/agent/sessions/op-return/chat-stream");
    expect(latest?.connection).toBe("connecting");
  });
});
