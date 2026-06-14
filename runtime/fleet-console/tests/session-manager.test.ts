import { describe, expect, it } from "vitest";

import { createTerminalSessionManager } from "../src/terminal/session-manager.js";
import type { TerminalPtyDataDisposable, TerminalPtyHandle, TerminalSocket, TerminalSocketData } from "../src/terminal/types.js";

interface MockPty extends TerminalPtyHandle {
  readonly writes: string[];
  readonly resizes: Array<{ readonly cols: number; readonly rows: number }>;
  readonly killed: () => boolean;
  emitData(data: string): void;
  emitExit(): void;
}

interface MockSocket extends TerminalSocket {
  readonly sent: Buffer[];
  readonly closed: Array<{ readonly code?: number; readonly reason?: string }>;
  emitMessage(data: TerminalSocketData, isBinary: boolean): void;
  emitClose(): void;
}

describe("terminal session manager", () => {
  it("creates sessions without enforcing a concurrency cap", () => {
    const ptys: MockPty[] = [];
    const manager = createTerminalSessionManager({
      launch: (cwd, context) => ({ bin: "mock", args: [context?.sessionId ?? ""], cwd: cwd ?? "/", env: {} }),
      startShell: (launch) => {
        const pty = createMockPty();
        ptys.push(pty);
        pty.writes.push(`cwd:${launch.cwd}`);
        return pty;
      },
      maxSessions: 2,
    });

    manager.createSession({ sessionId: "session-a", cwd: "/a" });
    manager.createSession({ sessionId: "session-b", cwd: "/b" });

    // 상한이 제거되어 maxSessions 설정과 무관하게 추가 세션이 허용된다.
    expect(manager.canAttach("session-a")).toBe(true);
    expect(manager.canAttach("session-c")).toBe(true);
    expect(() => manager.createSession({ sessionId: "session-c", cwd: "/c" })).not.toThrow();
    expect(ptys.map((pty) => pty.writes[0])).toEqual(["cwd:/a", "cwd:/b", "cwd:/c"]);
  });

  it("replaces sockets only within the same session", () => {
    const manager = createTerminalSessionManager({
      launch: (cwd) => ({ bin: "mock", args: [], cwd: cwd ?? "/", env: {} }),
      startShell: () => createMockPty(),
      maxSessions: 2,
    });
    const firstA = createMockSocket();
    const secondA = createMockSocket();
    const firstB = createMockSocket();

    manager.attach(firstA, { sessionId: "session-a", cwd: "/a" });
    manager.attach(firstB, { sessionId: "session-b", cwd: "/b" });
    manager.attach(secondA, { sessionId: "session-a", cwd: "/a" });

    expect(firstA.closed).toEqual([{ code: 4000, reason: "terminal_replaced" }]);
    expect(firstB.closed).toEqual([]);
    expect(secondA.closed).toEqual([]);
  });

  it("keeps scrollback isolated per session", () => {
    const ptys = new Map<string, MockPty>();
    const manager = createTerminalSessionManager({
      launch: (cwd, context) => ({ bin: "mock", args: [], cwd: cwd ?? "/", env: { SESSION: context?.sessionId } }),
      startShell: (launch) => {
        const pty = createMockPty();
        ptys.set(String(launch.env.SESSION), pty);
        return pty;
      },
      maxSessions: 2,
    });
    const firstA = createMockSocket();
    const secondA = createMockSocket();
    const firstB = createMockSocket();

    manager.attach(firstA, { sessionId: "session-a", cwd: "/a" });
    manager.attach(firstB, { sessionId: "session-b", cwd: "/b" });
    ptys.get("session-a")?.emitData("alpha");
    ptys.get("session-b")?.emitData("beta");
    firstA.emitClose();
    manager.attach(secondA, { sessionId: "session-a", cwd: "/a" });

    expect(secondA.sent.map((chunk) => chunk.toString("utf8"))).toEqual(["alpha"]);
    expect(firstB.sent.map((chunk) => chunk.toString("utf8"))).toEqual(["beta"]);
  });

  it("terminates a session, killing the pty and notifying exit exactly once", () => {
    const ptys = new Map<string, MockPty>();
    const exits: string[] = [];
    const manager = createTerminalSessionManager({
      launch: (cwd, context) => ({ bin: "mock", args: [], cwd: cwd ?? "/", env: { SESSION: context?.sessionId } }),
      startShell: (launch) => {
        const pty = createMockPty();
        ptys.set(String(launch.env.SESSION), pty);
        return pty;
      },
      onSessionExit: (sessionId) => exits.push(sessionId),
    });

    manager.createSession({ sessionId: "session-a", cwd: "/a" });

    expect(manager.terminate("session-a")).toBe(true);
    expect(ptys.get("session-a")?.killed()).toBe(true);
    expect(exits).toEqual(["session-a"]);
    // 멱등 — 이미 종료된 세션 재종료는 false이고 중복 통지하지 않는다.
    expect(manager.terminate("session-a")).toBe(false);
    expect(exits).toEqual(["session-a"]);
  });

  it("passes the terminal kind into the launch resolver", () => {
    const launchKinds: Array<string | undefined> = [];
    const manager = createTerminalSessionManager({
      launch: (cwd, context) => {
        launchKinds.push(context?.kind);
        return { bin: "mock", args: [], cwd: cwd ?? "/", env: {} };
      },
      startShell: () => createMockPty(),
    });

    manager.attach(createMockSocket(), { sessionId: "shell", cwd: "", kind: "shell" });

    expect(launchKinds).toEqual(["shell"]);
  });
});

function createMockPty(): MockPty {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<() => void> = [];
  let killed = false;
  return {
    writes: [],
    resizes: [],
    killed: () => killed,
    emitData(data) {
      for (const listener of dataListeners) listener(data);
    },
    emitExit() {
      for (const listener of exitListeners) listener();
    },
    onData(callback) {
      dataListeners.push(callback);
      return createDisposable(dataListeners, callback);
    },
    onExit(callback) {
      exitListeners.push(callback);
      return createDisposable(exitListeners, callback);
    },
    write(data) {
      this.writes.push(data);
    },
    resize(cols, rows) {
      this.resizes.push({ cols, rows });
    },
    kill() {
      killed = true;
    },
  };
}

function createMockSocket(): MockSocket {
  const messageListeners: Array<(data: TerminalSocketData, isBinary: boolean) => void> = [];
  const closeListeners: Array<() => void> = [];
  return {
    readyState: 1,
    sent: [],
    closed: [],
    send(data) {
      this.sent.push(data);
    },
    close(code, reason) {
      this.closed.push({ code, reason });
    },
    on(_event, listener) {
      messageListeners.push(listener);
    },
    once(_event, listener) {
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

function createDisposable<T>(list: T[], item: T): TerminalPtyDataDisposable {
  return {
    dispose() {
      const index = list.indexOf(item);
      if (index >= 0) list.splice(index, 1);
    },
  };
}
