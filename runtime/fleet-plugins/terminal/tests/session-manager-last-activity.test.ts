import { describe, expect, it } from "vitest";

import { createTerminalSessionManager } from "../server/shared/session-manager.js";
import type { TerminalPtyHandle, TerminalSocket, TerminalSocketData } from "../server/shared/terminal-types.js";

describe("session-manager lastActivityAt", () => {
  it("updates lastActivityAt on attach, PTY output, and binary input but not resize", async () => {
    let clock = 1_000;
    const ptys = new Map<string, MockPty>();
    const manager = createTerminalSessionManager({
      now: () => clock,
      launch: async (cwd, context) => ({ bin: "mock", args: [], cwd: cwd ?? "/", env: { SESSION_ID: context?.sessionId } }),
      startShell: (launch) => {
        const pty = createMockPty();
        ptys.set(String(launch.env.SESSION_ID), pty);
        return pty;
      },
    });

    expect(manager.getSessionLastActivityAt("agent-a")).toBeNull();

    const socket = createMockSocket();
    await manager.attach(socket, { sessionId: "agent-a", cwd: "/work", operationType: "agent" });
    expect(manager.getSessionLastActivityAt("agent-a")).toBe(1_000);

    clock = 2_000;
    ptys.get("agent-a")?.emitData("pty-output");
    expect(manager.getSessionLastActivityAt("agent-a")).toBe(2_000);

    clock = 3_000;
    socket.emitMessage(Buffer.from("user-input", "utf8"), true);
    expect(manager.getSessionLastActivityAt("agent-a")).toBe(3_000);

    clock = 4_000;
    socket.emitMessage(Buffer.from(JSON.stringify({ type: "resize", cols: 120, rows: 40 }), "utf8"), false);
    expect(manager.getSessionLastActivityAt("agent-a")).toBe(3_000);
    expect(ptys.get("agent-a")?.resized.at(-1)).toEqual({ cols: 120, rows: 40 });

    // 서버 주입 입력(reminder·rename)도 활동으로 갱신한다.
    clock = 5_000;
    expect(manager.writeToSession("agent-a", "injected-reminder")).toBe(true);
    expect(manager.getSessionLastActivityAt("agent-a")).toBe(5_000);

    await manager.stop();
  });

  it("returns null for unknown sessions", () => {
    const manager = createTerminalSessionManager({
      launch: async () => ({ bin: "mock", args: [], cwd: "/", env: {} }),
      startShell: () => createMockPty(),
    });
    expect(manager.getSessionLastActivityAt("missing")).toBeNull();
  });
});

interface MockPty extends TerminalPtyHandle {
  emitData(data: string): void;
  readonly resized: Array<{ readonly cols: number; readonly rows: number }>;
}

function createMockPty(): MockPty {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<() => void> = [];
  const resized: Array<{ readonly cols: number; readonly rows: number }> = [];
  return {
    resized,
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
    write() {},
    resize(cols, rows) {
      resized.push({ cols, rows });
    },
    kill() {},
  };
}

interface MockSocket extends TerminalSocket {
  readonly sent: Buffer[];
  emitMessage(data: TerminalSocketData, isBinary: boolean): void;
}

function createMockSocket(): MockSocket {
  const messageListeners: Array<(data: TerminalSocketData, isBinary: boolean) => void> = [];
  return {
    readyState: 1,
    sent: [],
    send(data, options) {
      if (options.binary) this.sent.push(Buffer.from(data));
    },
    close() {},
    on(event: "message", listener: (data: TerminalSocketData, isBinary: boolean) => void) {
      if (event === "message") messageListeners.push(listener);
    },
    once(_event: "close", _listener: () => void) {},
    emitMessage(data, isBinary) {
      for (const listener of messageListeners) listener(data, isBinary);
    },
  };
}

function removeListener<T>(listeners: T[], listener: T): void {
  const index = listeners.indexOf(listener);
  if (index >= 0) listeners.splice(index, 1);
}
