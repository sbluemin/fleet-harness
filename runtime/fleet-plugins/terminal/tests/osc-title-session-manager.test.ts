import { describe, expect, it } from "vitest";

import { createTerminalSessionManager } from "../server/shared/session-manager.js";
import type { TerminalPtyHandle, TerminalSocket, TerminalSocketData } from "../server/shared/terminal-types.js";

describe("OSC title session wiring", () => {
  it("observes only opted-in sessions and preserves raw PTY output when a listener throws", async () => {
    const ptys = new Map<string, MockPty>();
    const titles: Array<{ readonly sessionId: string; readonly title: string }> = [];
    const manager = createTerminalSessionManager({
      launch: async (cwd, context) => ({ bin: "mock", args: [], cwd: cwd ?? "/", env: { SESSION_ID: context?.sessionId } }),
      startShell: (launch) => {
        const pty = createMockPty();
        ptys.set(String(launch.env.SESSION_ID), pty);
        return pty;
      },
      resolveTitleListener: (context) => context.operationType === "agent"
        ? (sessionId, title) => {
            titles.push({ sessionId, title });
            throw new Error("observer failure");
          }
        : undefined,
    });
    const agentSocket = createMockSocket();
    const shellSocket = createMockSocket();
    await manager.attach(agentSocket, { sessionId: "agent-a", cwd: "/work", operationType: "agent" });
    await manager.attach(shellSocket, { sessionId: "shell-a", cwd: "/work", operationType: "shell" });
    const rawAgentOutput = Buffer.from("\x1b]0;⠐ project\x07visible", "utf8");

    ptys.get("agent-a")?.emitData(rawAgentOutput.toString("utf8"));
    ptys.get("agent-a")?.emitData("after-listener-error");
    ptys.get("shell-a")?.emitData("\x1b]0;✳ shell\x07");

    expect(titles).toEqual([{ sessionId: "agent-a", title: "⠐ project" }]);
    expect(agentSocket.sent[0]?.equals(rawAgentOutput)).toBe(true);
    expect(agentSocket.sent[1]?.toString("utf8")).toBe("after-listener-error");
    expect(shellSocket.sent[0]?.toString("utf8")).toBe("\x1b]0;✳ shell\x07");
    await manager.stop();
  });
});

interface MockPty extends TerminalPtyHandle {
  emitData(data: string): void;
}

function createMockPty(): MockPty {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<() => void> = [];
  return {
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
    resize() {},
    kill() {},
  };
}

interface MockSocket extends TerminalSocket {
  readonly sent: Buffer[];
}

function createMockSocket(): MockSocket {
  return {
    readyState: 1,
    sent: [],
    send(data) {
      this.sent.push(Buffer.from(data));
    },
    close() {},
    on(_event: "message", _listener: (data: TerminalSocketData, isBinary: boolean) => void) {},
    once(_event: "close", _listener: () => void) {},
  };
}

function removeListener<T>(listeners: T[], listener: T): void {
  const index = listeners.indexOf(listener);
  if (index >= 0) listeners.splice(index, 1);
}
