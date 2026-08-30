import { describe, expect, it, vi } from "vitest";

import { createTerminalSessionManager } from "../server/shared/session-manager.js";
import type { TerminalPtyHandle, TerminalSocket, TerminalSocketData } from "../server/shared/terminal-types.js";

const DA_QUERY = "\x1b[c";
const DA_RESPONSE = "\x1b[?1;2c";
const CONTEXT = { sessionId: "session-a", cwd: "/work" } as const;

describe("session-manager terminal query replay", () => {
  it("delegates live terminal queries and answers again after detach", async () => {
    const { manager, pty } = await createHarness();
    const socket = createMockSocket();
    await manager.attach(socket, CONTEXT);

    pty.emitData(DA_QUERY);
    expect(pty.written).toEqual([]);
    expect(socket.sent.filter((frame) => frame.binary).map((frame) => frame.data.toString("utf8"))).toEqual([DA_QUERY]);

    socket.emitClose();
    pty.emitData(DA_QUERY);
    expect(pty.written).toEqual([DA_RESPONSE]);
    expect(socket.sent.filter((frame) => frame.binary).map((frame) => frame.data.toString("utf8"))).toEqual([DA_QUERY]);
    await manager.stop();
  });

  it("carries a live query prefix into the detached responder", async () => {
    const { manager, pty } = await createHarness();
    const socket = createMockSocket();
    await manager.attach(socket, CONTEXT);

    pty.emitData("\x1b[");
    expect(pty.written).toEqual([]);

    socket.emitClose();
    pty.emitData("c");
    expect(pty.written).toEqual([DA_RESPONSE]);
    await manager.stop();
  });

  it("answers terminal queries while no live client is attached", async () => {
    const { manager, pty } = await createHarness();

    pty.emitData(DA_QUERY);

    expect(pty.written).toContain(DA_RESPONSE);
    await manager.stop();
  });

  it("sends replayed binary scrollback before one text replay-end frame", async () => {
    const { manager, pty } = await createHarness();
    pty.emitData("detached-output");
    const socket = createMockSocket();

    await manager.attach(socket, CONTEXT);

    expect(socket.sent).toHaveLength(3);
    expect(socket.sent[0]).toMatchObject({ binary: false });
    expect(JSON.parse(socket.sent[0]?.data.toString("utf8") ?? "null")).toEqual({ type: "replay_state", alternateScreenActive: false, mouseProtocol: "none", mouseEncoding: "default" });
    expect(socket.sent[1]).toMatchObject({ binary: true });
    expect(socket.sent[1]?.data.toString("utf8")).toBe("detached-output");
    expect(socket.sent[2]).toMatchObject({ binary: false });
    expect(JSON.parse(socket.sent[2]?.data.toString("utf8") ?? "null")).toEqual({ type: "replay_end", alternateScreenActive: false, mouseProtocol: "none", mouseEncoding: "default" });
    await manager.stop();
  });

  it("sends replay-end for an empty fresh session", async () => {
    const { manager } = await createHarness();
    const socket = createMockSocket();

    await manager.attach(socket, CONTEXT);

    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[0]).toMatchObject({ binary: false });
    expect(JSON.parse(socket.sent[0]?.data.toString("utf8") ?? "null")).toEqual({ type: "replay_state", alternateScreenActive: false, mouseProtocol: "none", mouseEncoding: "default" });
    expect(socket.sent[1]).toMatchObject({ binary: false });
    expect(JSON.parse(socket.sent[1]?.data.toString("utf8") ?? "null")).toEqual({ type: "replay_end", alternateScreenActive: false, mouseProtocol: "none", mouseEncoding: "default" });
    await manager.stop();
  });

  it("tracks a split alternate-screen sequence after its entry scrollback was evicted", async () => {
    const { manager, pty } = await createHarness({ scrollbackLimit: 1 });
    pty.emitData("\x1b[?10");
    pty.emitData("49h");
    pty.emitData("latest-paint");
    const socket = createMockSocket();

    await manager.attach(socket, CONTEXT);

    expect(socket.sent.filter((frame) => frame.binary).map((frame) => frame.data.toString("utf8"))).toEqual(["latest-paint"]);
    expect(JSON.parse(socket.sent[0]?.data.toString("utf8") ?? "null")).toMatchObject({
      type: "replay_state",
      alternateScreenActive: true,
    });
    expect(JSON.parse(socket.sent.at(-1)?.data.toString("utf8") ?? "null")).toEqual({
      type: "replay_end",
      alternateScreenActive: true,
      mouseProtocol: "none",
      mouseEncoding: "default",
    });
    await manager.stop();
  });

  it("returns the tracked mode to normal on full reset", async () => {
    const { manager, pty } = await createHarness();
    pty.emitData("\x1b[?1049h");
    pty.emitData("\x1bc");
    const socket = createMockSocket();

    await manager.attach(socket, CONTEXT);

    expect(JSON.parse(socket.sent.at(-1)?.data.toString("utf8") ?? "null")).toEqual({
      type: "replay_end",
      alternateScreenActive: false,
      mouseProtocol: "none",
      mouseEncoding: "default",
    });
    await manager.stop();
  });

  it("writes client binary input to the PTY without UTF-8 replacement", async () => {
    const { manager, pty } = await createHarness();
    const socket = createMockSocket();
    await manager.attach(socket, CONTEXT);
    const report = Buffer.from([0x1b, 0x5b, 0x4d, 0x80, 0xff, 0x00]);

    socket.emitMessage(report, true);

    expect(pty.written).toHaveLength(1);
    expect(Buffer.isBuffer(pty.written[0])).toBe(true);
    expect([...pty.written[0] as Buffer]).toEqual([...report]);
    await manager.stop();
  });

});

interface MockPty extends TerminalPtyHandle {
  readonly written: Array<string | Buffer>;
  emitData(data: string): void;
}

interface SentFrame {
  readonly data: Buffer;
  readonly binary: boolean;
}

interface MockSocket extends TerminalSocket {
  readonly sent: SentFrame[];
  emitMessage(data: TerminalSocketData, isBinary: boolean): void;
  emitClose(): void;
}

async function createHarness(options: { readonly scrollbackLimit?: number } = {}): Promise<{ readonly manager: ReturnType<typeof createTerminalSessionManager>; readonly pty: MockPty }> {
  const pty = createMockPty();
  const manager = createTerminalSessionManager({
    launch: async (cwd) => ({ bin: "mock", args: [], cwd: cwd ?? "/", env: {} }),
    startShell: () => pty,
    ...options,
  });
  await manager.createSession(CONTEXT);
  return { manager, pty };
}

function createMockPty(): MockPty {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<() => void> = [];
  return {
    written: [],
    emitData(data) {
      for (const listener of dataListeners) listener(data);
    },
    onData(callback) {
      dataListeners.push(callback);
      return { dispose: () => removeListener(dataListeners, callback) };
    },
    onExit(callback) {
      exitListeners.push(callback);
      return { dispose: () => removeListener(exitListeners, callback) };
    },
    write(data) {
      this.written.push(data);
    },
    resize() {},
    kill() {},
  };
}

function createMockSocket(): MockSocket {
  const messageListeners: Array<(data: TerminalSocketData, isBinary: boolean) => void> = [];
  const closeListeners: Array<() => void> = [];
  return {
    readyState: 1,
    sent: [],
    send(data, options) {
      this.sent.push({ data: Buffer.from(data), binary: options.binary });
    },
    close() {},
    on(_event: "message", listener: (data: TerminalSocketData, isBinary: boolean) => void) {
      messageListeners.push(listener);
    },
    once(_event: "close", listener: () => void) {
      closeListeners.push(listener);
    },
    emitMessage(data, isBinary) {
      for (const listener of messageListeners) listener(data, isBinary);
    },
    emitClose() {
      for (const listener of closeListeners) listener();
    },
  };
}

function removeListener<T>(listeners: T[], listener: T): void {
  const index = listeners.indexOf(listener);
  if (index >= 0) listeners.splice(index, 1);
}
