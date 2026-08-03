import { afterEach, describe, expect, it, vi } from "vitest";

import { createTerminalConnection, type WebSocketLike } from "../client/shared/terminal-connection.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("terminal connection replay input gate", () => {
  it("subscribes input only after replay output has drained while preserving resize", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ticket: "ticket-a", ttlMs: 10_000 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const terminal = new FakeTerminal();
    let socket: FakeWebSocket | undefined;
    const connection = createTerminalConnection({
      operationId: "session-a",
      terminal,
      ticketPath: "/ticket",
      wsPath: "/ws",
      location: { host: "console.test", protocol: "http:" },
      webSocketFactory: () => {
        socket = new FakeWebSocket();
        return socket;
      },
    });
    connection.resize(120, 40);
    connection.start();
    await vi.waitFor(() => expect(socket).toBeDefined());
    socket!.open();

    expect(socket!.sent).toEqual([JSON.stringify({ type: "resize", cols: 120, rows: 40 })]);
    terminal.emitData("before-replay-end");
    expect(socket!.sent).toHaveLength(1);

    const replay = new TextEncoder().encode("replayed-output");
    socket!.receive(replay.buffer);
    expect(terminal.written).toEqual([replay]);

    socket!.receive(JSON.stringify({ type: "replay_end" }));
    expect(terminal.pendingDrains).toHaveLength(1);
    terminal.emitData("while-draining");
    expect(socket!.sent).toHaveLength(1);
    expect(socket!.sent).not.toContain(JSON.stringify({ type: "replay_ack" }));

    terminal.releaseDrain();
    expect(socket!.sent).toEqual([
      JSON.stringify({ type: "resize", cols: 120, rows: 40 }),
      JSON.stringify({ type: "replay_ack" }),
    ]);
    terminal.emitData("live-input");
    expect(socket!.sent).toHaveLength(3);
    expect(socket!.sent[2]).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(socket!.sent[2] as Uint8Array)).toBe("live-input");

    connection.dispose();
  });
});

class FakeTerminal {
  readonly written: Uint8Array[] = [];
  readonly pendingDrains: Array<() => void> = [];
  private dataListener: ((data: string) => void) | null = null;

  readonly onData = (listener: (data: string) => void) => {
    this.dataListener = listener;
    return {
      dispose: () => {
        if (this.dataListener === listener) this.dataListener = null;
      },
    };
  };

  readonly write = (data: Uint8Array) => {
    this.written.push(data);
  };

  readonly drain = (callback: () => void) => {
    this.pendingDrains.push(callback);
  };

  emitData(data: string): void {
    this.dataListener?.(data);
  }

  releaseDrain(): void {
    this.pendingDrains.shift()?.();
  }
}

class FakeWebSocket implements WebSocketLike {
  binaryType: BinaryType = "blob";
  readyState = 0;
  readonly sent: Array<string | Uint8Array> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<ArrayBuffer | string>) => void) | null = null;
  onclose: ((event: { readonly code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  readonly send = (data: string | Uint8Array) => {
    this.sent.push(data);
  };

  readonly close = () => {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  };

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(data: ArrayBuffer | string): void {
    this.onmessage?.({ data } as MessageEvent<ArrayBuffer | string>);
  }
}
