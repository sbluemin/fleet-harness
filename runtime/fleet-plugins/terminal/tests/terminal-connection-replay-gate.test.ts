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

  it("preserves legacy onBinary mouse report bytes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ticket: "ticket-binary", ttlMs: 10_000 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const terminal = new FakeTerminal();
    let socket: FakeWebSocket | undefined;
    const connection = createTerminalConnection({
      operationId: "session-binary",
      terminal,
      ticketPath: "/ticket",
      wsPath: "/ws",
      location: { host: "console.test", protocol: "http:" },
      webSocketFactory: () => {
        socket = new FakeWebSocket();
        return socket;
      },
    });
    connection.start();
    await vi.waitFor(() => expect(socket).toBeDefined());
    socket!.open();
    socket!.receive(JSON.stringify({ type: "replay_end", alternateScreenActive: false }));
    terminal.releaseDrain();

    terminal.emitBinary("\x1b[M\x80\xff\x00");

    expect(socket!.sent).toHaveLength(1);
    expect([...socket!.sent[0] as Uint8Array]).toEqual([0x1b, 0x5b, 0x4d, 0x80, 0xff, 0x00]);
    connection.dispose();
  });

  it("passes server modes before replay parsing and confirms them only after drain", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ticket: "ticket-state", ttlMs: 10_000 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const terminal = new FakeTerminal();
    const replayStates: Array<{ readonly replaying: boolean; readonly alternate?: boolean }> = [];
    const initialModes: boolean[] = [];
    let socket: FakeWebSocket | undefined;
    const connection = createTerminalConnection({
      operationId: "session-state",
      terminal,
      ticketPath: "/ticket",
      wsPath: "/ws",
      location: { host: "console.test", protocol: "http:" },
      onReplayState: (state) => initialModes.push(state.alternateScreenActive === true),
      onReplayStateChange: (replaying, state) => replayStates.push({ replaying, alternate: state?.alternateScreenActive }),
      webSocketFactory: () => {
        socket = new FakeWebSocket();
        return socket;
      },
    });
    connection.start();
    await vi.waitFor(() => expect(socket).toBeDefined());
    socket!.open();
    socket!.receive(JSON.stringify({ type: "replay_state", alternateScreenActive: true }));
    expect(initialModes).toEqual([true]);
    socket!.receive(JSON.stringify({ type: "replay_end", alternateScreenActive: true }));

    expect(replayStates).toEqual([{ replaying: true }]);
    terminal.releaseDrain();
    expect(replayStates).toEqual([
      { replaying: true },
      { replaying: false, alternate: true },
    ]);
    connection.dispose();
  });

  it("sends a resize frame only when the grid actually changed, and renegotiates on every reconnect", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ticket: "ticket-d", ttlMs: 10_000 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const terminal = new FakeTerminal();
    const sockets: FakeWebSocket[] = [];
    const connection = createTerminalConnection({
      operationId: "session-d",
      terminal,
      ticketPath: "/ticket",
      wsPath: "/ws",
      location: { host: "console.test", protocol: "http:" },
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    });
    connection.resize(120, 40);
    connection.start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: "resize", cols: 120, rows: 40 })]);

    // The panel box moved by less than a cell, so fit lands on the same grid. Re-sending it would
    // cost a SIGWINCH and a full-screen TUI redraw for a screen that did not change.
    connection.resize(120, 40);
    expect(sockets[0]!.sent).toHaveLength(1);

    // A real grid change still goes out.
    connection.resize(118, 40);
    expect(sockets[0]!.sent).toHaveLength(2);
    expect(sockets[0]!.sent[1]).toBe(JSON.stringify({ type: "resize", cols: 118, rows: 40 }));

    // A new socket inherits no size history: the client cannot assume what the session behind it
    // knows, so every reconnect negotiates the grid once even though nothing changed locally.
    sockets[0]!.close();
    await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 2_000 });
    sockets[1]!.open();
    expect(sockets[1]!.sent).toEqual([JSON.stringify({ type: "resize", cols: 118, rows: 40 })]);

    connection.dispose();
  });

  it("reports the replay window on every attach so replayed side effects stay suppressed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ticket: "ticket-b", ttlMs: 10_000 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const terminal = new FakeTerminal();
    const replayStates: boolean[] = [];
    const sockets: FakeWebSocket[] = [];
    const connection = createTerminalConnection({
      operationId: "session-b",
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

    // The window opens with the attach itself, before any replayed byte can reach the parser.
    expect(replayStates).toEqual([true]);

    sockets[0]!.receive(new TextEncoder().encode("replayed-output").buffer);
    expect(replayStates).toEqual([true]);

    sockets[0]!.receive(JSON.stringify({ type: "replay_end", alternateScreenActive: false }));
    expect(replayStates).toEqual([true]);

    // It closes only once the replayed bytes have actually been parsed.
    terminal.releaseDrain();
    expect(replayStates).toEqual([true, false]);

    // A reconnect replays the same scrollback again, so the window must reopen.
    sockets[0]!.close();
    await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 2_000 });
    expect(replayStates).toEqual([true, false, true]);

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
