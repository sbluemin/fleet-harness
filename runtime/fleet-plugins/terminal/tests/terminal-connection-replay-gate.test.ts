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

    socket!.receive(JSON.stringify({
      type: "replay_state",
      alternateScreenActive: false,
      mouseProtocol: "none",
      mouseEncoding: "default",
    }));
    const replay = new TextEncoder().encode("replayed-output");
    socket!.receive(replay.buffer);
    expect(terminal.written).toEqual([replay]);

    socket!.receive(JSON.stringify({ type: "replay_end", alternateScreenActive: false }));
    expect(terminal.pendingDrains).toHaveLength(1);
    terminal.emitData("while-draining");
    expect(socket!.sent).toHaveLength(1);

    terminal.releaseDrain();
    expect(socket!.sent).toEqual([JSON.stringify({ type: "resize", cols: 120, rows: 40 })]);
    terminal.emitData("live-input");
    expect(socket!.sent).toHaveLength(2);
    expect(socket!.sent[1]).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(socket!.sent[1] as Uint8Array)).toBe("live-input");

    connection.dispose();
  });

  it("does not let a closed socket's late drain close the reconnected socket's replay window", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ticket: "ticket-c", ttlMs: 10_000 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const terminal = new FakeTerminal();
    const replayStates: boolean[] = [];
    const sockets: FakeWebSocket[] = [];
    const connection = createTerminalConnection({
      operationId: "session-c",
      terminal,
      ticketPath: "/ticket",
      wsPath: "/ws",
      location: { host: "console.test", protocol: "http:" },
      onReplayStateChange: (replaying) => replayStates.push(replaying),
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    });
    connection.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();

    // The first socket asks to close its window, but its drain has not run yet.
    sockets[0]!.receive(JSON.stringify({ type: "replay_end", alternateScreenActive: false }));
    expect(terminal.pendingDrains).toHaveLength(1);

    // It dies first, and the reconnect opens a fresh replay window.
    sockets[0]!.close();
    await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 2_000 });
    sockets[1]!.open();
    expect(replayStates).toEqual([true, true]);

    // The dead socket's callback finally lands. It must not close the live socket's window.
    terminal.releaseDrain();
    expect(replayStates).toEqual([true, true]);

    // Only the live socket's own replay_end closes it.
    sockets[1]!.receive(JSON.stringify({ type: "replay_end", alternateScreenActive: false }));
    terminal.releaseDrain();
    expect(replayStates).toEqual([true, true, false]);

    connection.dispose();
  });
});

class FakeTerminal {
  readonly written: Uint8Array[] = [];
  readonly pendingDrains: Array<() => void> = [];
  private binaryListener: ((data: string) => void) | null = null;
  private dataListener: ((data: string) => void) | null = null;

  readonly onBinary = (listener: (data: string) => void) => {
    this.binaryListener = listener;
    return {
      dispose: () => {
        if (this.binaryListener === listener) this.binaryListener = null;
      },
    };
  };

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

  emitBinary(data: string): void {
    this.binaryListener?.(data);
  }

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
