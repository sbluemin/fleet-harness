// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetConsoleChannelsForTest, subscribeConsoleChannel } from "../core/client/src/operations-sse.js";

interface FakeSource {
  readonly listeners: Map<string, (event: MessageEvent<string>) => void>;
  emit(channel: string, data: string): void;
}

const sources: FakeSource[] = [];

class StubEventSource {
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();
  constructor(public readonly url: string) {
    sources.push(this as unknown as FakeSource);
  }
  addEventListener(type: string, handler: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, handler);
  }
  emit(channel: string, data: string): void {
    this.listeners.get(channel)?.({ data } as MessageEvent<string>);
  }
  close(): void {}
}

beforeEach(() => {
  sources.length = 0;
  resetConsoleChannelsForTest();
  vi.stubGlobal("EventSource", StubEventSource);
});

afterEach(() => {
  resetConsoleChannelsForTest();
  vi.unstubAllGlobals();
});

describe("plugin channels on the console stream", () => {
  // 서버는 플러그인이 올린 채널만 이 스트림으로 흘려보낸다. 받는 쪽이 없으면 프레임은
  // 조용히 버려진다 — Codex의 실시간 갱신이 실제로 그렇게 죽어 있었다.
  it("hands a registered channel's frames to its subscriber", async () => {
    const { connectOperationsSse } = await import("../core/client/src/operations-sse.js");
    const seen: unknown[] = [];
    subscribeConsoleChannel("codex:changed", (payload) => seen.push(payload));

    connectOperationsSse();
    sources.at(-1)!.emit("codex:changed", JSON.stringify({ workspaceId: "ws", scopes: ["wiki"] }));

    expect(seen).toEqual([{ workspaceId: "ws", scopes: ["wiki"] }]);
  });

  it("attaches a channel subscribed after the stream is already open", async () => {
    const { connectOperationsSse } = await import("../core/client/src/operations-sse.js");
    connectOperationsSse();

    const seen: unknown[] = [];
    subscribeConsoleChannel("codex:watch", (payload) => seen.push(payload));
    sources.at(-1)!.emit("codex:watch", JSON.stringify({ workspaceId: "ws", state: "degraded" }));

    expect(seen).toEqual([{ workspaceId: "ws", state: "degraded" }]);
  });

  it("keeps delivering after a reconnect builds a new stream", async () => {
    const { connectOperationsSse } = await import("../core/client/src/operations-sse.js");
    const seen: unknown[] = [];
    subscribeConsoleChannel("codex:changed", (payload) => seen.push(payload));

    connectOperationsSse();
    connectOperationsSse();
    sources.at(-1)!.emit("codex:changed", JSON.stringify({ workspaceId: "ws", scopes: ["queue"] }));

    expect(seen).toEqual([{ workspaceId: "ws", scopes: ["queue"] }]);
  });

  it("stops delivering once the subscriber lets go", async () => {
    const { connectOperationsSse } = await import("../core/client/src/operations-sse.js");
    const seen: unknown[] = [];
    const stop = subscribeConsoleChannel("codex:changed", (payload) => seen.push(payload));

    connectOperationsSse();
    stop();
    sources.at(-1)!.emit("codex:changed", JSON.stringify({ workspaceId: "ws", scopes: ["queue"] }));

    expect(seen).toEqual([]);
  });

  it("keeps one listener's failure from swallowing the next", async () => {
    const { connectOperationsSse } = await import("../core/client/src/operations-sse.js");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const seen: string[] = [];
    subscribeConsoleChannel("codex:changed", () => { seen.push("first"); throw new Error("boom"); });
    subscribeConsoleChannel("codex:changed", () => { seen.push("second"); });

    connectOperationsSse();
    sources.at(-1)!.emit("codex:changed", JSON.stringify({ workspaceId: "ws", scopes: ["queue"] }));

    expect(seen).toEqual(["first", "second"]);
  });

  it("ignores a malformed frame instead of tearing the stream down", async () => {
    const { connectOperationsSse } = await import("../core/client/src/operations-sse.js");
    const seen: unknown[] = [];
    subscribeConsoleChannel("codex:changed", (payload) => seen.push(payload));

    connectOperationsSse();
    expect(() => sources.at(-1)!.emit("codex:changed", "{not json")).not.toThrow();

    expect(seen).toEqual([]);
  });
});
