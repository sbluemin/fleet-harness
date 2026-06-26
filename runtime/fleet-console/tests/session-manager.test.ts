import { describe, expect, it } from "vitest";

import { createTerminalSessionManager } from "../core/host/terminal/session-manager.js";
import type { TerminalPtyDataDisposable, TerminalPtyHandle, TerminalSocket, TerminalSocketData } from "../core/host/terminal/types.js";

interface MockPty extends TerminalPtyHandle {
  readonly writes: string[];
  readonly resizes: Array<{ readonly cols: number; readonly rows: number }>;
  readonly killed: () => boolean;
  readonly killCount: () => number;
  emitData(data: string): void;
  emitExit(): void;
  throwAlreadyExitedOnKill(): void;
  throwUnexpectedOnKill(): void;
}

interface MockSocket extends TerminalSocket {
  readonly sent: Buffer[];
  readonly closed: Array<{ readonly code?: number; readonly reason?: string }>;
  emitMessage(data: TerminalSocketData, isBinary: boolean): void;
  emitClose(): void;
}

describe("terminal session manager", () => {
  it("creates sessions without enforcing a concurrency cap", async () => {
    const ptys: MockPty[] = [];
    const manager = createTerminalSessionManager({
      launch: async (cwd, context) => ({ bin: "mock", args: [context?.sessionId ?? ""], cwd: cwd ?? "/", env: {} }),
      startShell: (launch) => {
        const pty = createMockPty();
        ptys.push(pty);
        pty.writes.push(`cwd:${launch.cwd}`);
        return pty;
      },
      maxSessions: 2,
    });

    await manager.createSession({ sessionId: "session-a", cwd: "/a" });
    await manager.createSession({ sessionId: "session-b", cwd: "/b" });

    // 상한이 제거되어 maxSessions 설정과 무관하게 추가 세션이 허용된다.
    expect(manager.canAttach("session-a")).toBe(true);
    expect(manager.canAttach("session-c")).toBe(true);
    await expect(manager.createSession({ sessionId: "session-c", cwd: "/c" })).resolves.toBeUndefined();
    expect(ptys.map((pty) => pty.writes[0])).toEqual(["cwd:/a", "cwd:/b", "cwd:/c"]);
  });

  it("coalesces concurrent creates for the same session id into one pty", async () => {
    const launchGate = createDeferred<void>();
    const ptys: MockPty[] = [];
    const launchSessionIds: string[] = [];
    const manager = createTerminalSessionManager({
      launch: async (cwd, context) => {
        launchSessionIds.push(context?.sessionId ?? "");
        await launchGate.promise;
        return { bin: "mock", args: [], cwd: cwd ?? "/", env: { SESSION: context?.sessionId } };
      },
      startShell: () => {
        const pty = createMockPty();
        ptys.push(pty);
        return pty;
      },
    });

    const first = manager.createSession({ sessionId: "session-a", cwd: "/a" });
    const second = manager.createSession({ sessionId: "session-a", cwd: "/a" });

    expect(launchSessionIds).toEqual(["session-a"]);
    launchGate.resolve();
    await Promise.all([first, second]);

    expect(ptys).toHaveLength(1);
    expect(manager.terminate("session-a")).toBe(true);
    expect(ptys[0]?.killed()).toBe(true);
  });

  it("clears a failed in-flight session launch so the session can be retried", async () => {
    let launchCount = 0;
    const ptys: MockPty[] = [];
    const manager = createTerminalSessionManager({
      launch: async (cwd, context) => {
        launchCount += 1;
        if (launchCount === 1) throw new Error("launch failed");
        return { bin: "mock", args: [], cwd: cwd ?? "/", env: { SESSION: context?.sessionId } };
      },
      startShell: () => {
        const pty = createMockPty();
        ptys.push(pty);
        return pty;
      },
    });

    await expect(manager.createSession({ sessionId: "session-a", cwd: "/a" })).rejects.toThrow("launch failed");
    await expect(manager.createSession({ sessionId: "session-a", cwd: "/a" })).resolves.toBeUndefined();

    expect(launchCount).toBe(2);
    expect(ptys).toHaveLength(1);
  });

  it("passes the selected Agent CLI id into the launch context", async () => {
    const launchCliIds: Array<string | undefined> = [];
    const manager = createTerminalSessionManager({
      launch: async (cwd, context) => {
        launchCliIds.push(context?.cliId);
        return { bin: "mock", args: [], cwd: cwd ?? "/", env: {} };
      },
      startShell: () => createMockPty(),
    });

    await manager.createSession({ sessionId: "session-a", cwd: "/a", cliId: "codex" });

    expect(launchCliIds).toEqual(["codex"]);
  });

  it("passes resumeSessionId into the launch context without changing the fleet session id", async () => {
    const contexts: unknown[] = [];
    const manager = createTerminalSessionManager({
      launch: async (cwd, context) => {
        contexts.push({ cwd, context });
        return { bin: "mock", args: [], cwd: cwd ?? "/", env: {} };
      },
      startShell: () => createMockPty(),
    });

    await manager.createSession({ sessionId: "fleet-session-a", cwd: "/a", cliId: "claude", resumeSessionId: "provider-session-a" });

    expect(contexts).toEqual([{
      cwd: "/a",
      context: {
        sessionId: "fleet-session-a",
        kind: undefined,
        cliId: "claude",
        resumeSessionId: "provider-session-a",
      },
    }]);
  });

  it("stops a session that finishes launching while server shutdown is waiting", async () => {
    const launchGate = createDeferred<void>();
    const exitGate = createDeferred<void>();
    const ptys: MockPty[] = [];
    const exits: string[] = [];
    let stoppedResolved = false;
    const manager = createTerminalSessionManager({
      launch: async (cwd, context) => {
        await launchGate.promise;
        return { bin: "mock", args: [], cwd: cwd ?? "/", env: { SESSION: context?.sessionId } };
      },
      startShell: () => {
        const pty = createMockPty();
        ptys.push(pty);
        return pty;
      },
      onSessionExit: async (sessionId) => {
        exits.push(sessionId);
        await exitGate.promise;
      },
    });

    const created = manager.createSession({ sessionId: "session-a", cwd: "/a" });
    const stopped = manager.stop().then(() => {
      stoppedResolved = true;
    });
    launchGate.resolve();
    await created;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ptys).toHaveLength(1);
    expect(ptys[0]?.killed()).toBe(true);
    expect(exits).toEqual(["session-a"]);
    expect(stoppedResolved).toBe(false);
    exitGate.resolve();
    await stopped;
    expect(stoppedResolved).toBe(true);
    expect(manager.writeToSession("session-a", "after-stop")).toBe(false);
  });

  it("replaces sockets only within the same session", async () => {
    const manager = createTerminalSessionManager({
      launch: async (cwd) => ({ bin: "mock", args: [], cwd: cwd ?? "/", env: {} }),
      startShell: () => createMockPty(),
      maxSessions: 2,
    });
    const firstA = createMockSocket();
    const secondA = createMockSocket();
    const firstB = createMockSocket();

    await manager.attach(firstA, { sessionId: "session-a", cwd: "/a" });
    await manager.attach(firstB, { sessionId: "session-b", cwd: "/b" });
    await manager.attach(secondA, { sessionId: "session-a", cwd: "/a" });

    expect(firstA.closed).toEqual([{ code: 4000, reason: "terminal_replaced" }]);
    expect(firstB.closed).toEqual([]);
    expect(secondA.closed).toEqual([]);
  });

  it("keeps scrollback isolated per session", async () => {
    const ptys = new Map<string, MockPty>();
    const manager = createTerminalSessionManager({
      launch: async (cwd, context) => ({ bin: "mock", args: [], cwd: cwd ?? "/", env: { SESSION: context?.sessionId } }),
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

    await manager.attach(firstA, { sessionId: "session-a", cwd: "/a" });
    await manager.attach(firstB, { sessionId: "session-b", cwd: "/b" });
    ptys.get("session-a")?.emitData("alpha");
    ptys.get("session-b")?.emitData("beta");
    firstA.emitClose();
    await manager.attach(secondA, { sessionId: "session-a", cwd: "/a" });

    expect(secondA.sent.map((chunk) => chunk.toString("utf8"))).toEqual(["alpha"]);
    expect(firstB.sent.map((chunk) => chunk.toString("utf8"))).toEqual(["beta"]);
  });

  it("responds to terminal device queries without altering output delivery", async () => {
    const ptys = new Map<string, MockPty>();
    const manager = createTerminalSessionManager({
      launch: async (cwd, context) => ({ bin: "mock", args: [], cwd: cwd ?? "/", env: { SESSION: context?.sessionId } }),
      startShell: (launch) => {
        const pty = createMockPty();
        ptys.set(String(launch.env.SESSION), pty);
        return pty;
      },
    });
    const socket = createMockSocket();

    await manager.attach(socket, { sessionId: "session-a", cwd: "/a" });
    socket.emitMessage(Buffer.from(JSON.stringify({ type: "resize", cols: 120, rows: 40 }), "utf8"), false);
    ptys.get("session-a")?.emitData(`before\x1b[6nafter\x1b[5n\x1b[c\x1b[0c\x1b[>c\x1b[31m`);

    expect(ptys.get("session-a")?.writes).toEqual(["\x1b[40;120R", "\x1b[0n", "\x1b[?1;2c", "\x1b[?1;2c", "\x1b[>0;0;0c"]);
    expect(socket.sent.map((chunk) => chunk.toString("utf8"))).toEqual([`before\x1b[6nafter\x1b[5n\x1b[c\x1b[0c\x1b[>c\x1b[31m`]);
  });

  it("responds to terminal device queries split across pty chunks", async () => {
    const ptys = new Map<string, MockPty>();
    const manager = createTerminalSessionManager({
      launch: async (cwd, context) => ({ bin: "mock", args: [], cwd: cwd ?? "/", env: { SESSION: context?.sessionId } }),
      startShell: (launch) => {
        const pty = createMockPty();
        ptys.set(String(launch.env.SESSION), pty);
        return pty;
      },
    });

    await manager.createSession({ sessionId: "session-a", cwd: "/a" });
    ptys.get("session-a")?.emitData("\x1b");
    ptys.get("session-a")?.emitData("[");
    ptys.get("session-a")?.emitData("6n");
    ptys.get("session-a")?.emitData("\x1b[");
    ptys.get("session-a")?.emitData(">c");

    expect(ptys.get("session-a")?.writes).toEqual(["\x1b[24;80R", "\x1b[>0;0;0c"]);
  });

  it("terminates a session, killing the pty and notifying exit exactly once", async () => {
    const ptys = new Map<string, MockPty>();
    const exits: string[] = [];
    const manager = createTerminalSessionManager({
      launch: async (cwd, context) => ({ bin: "mock", args: [], cwd: cwd ?? "/", env: { SESSION: context?.sessionId } }),
      startShell: (launch) => {
        const pty = createMockPty();
        ptys.set(String(launch.env.SESSION), pty);
        return pty;
      },
      onSessionExit: (sessionId) => exits.push(sessionId),
    });

    await manager.createSession({ sessionId: "session-a", cwd: "/a" });

    expect(manager.terminate("session-a")).toBe(true);
    expect(ptys.get("session-a")?.killed()).toBe(true);
    expect(exits).toEqual(["session-a"]);
    // 멱등 — 이미 종료된 세션 재종료는 false이고 중복 통지하지 않는다.
    expect(manager.terminate("session-a")).toBe(false);
    expect(exits).toEqual(["session-a"]);
  });

  it("writes only to an existing live session and returns false after termination", async () => {
    const ptys = new Map<string, MockPty>();
    const launches: string[] = [];
    const manager = createTerminalSessionManager({
      launch: async (cwd, context) => {
        launches.push(context?.sessionId ?? "");
        return {
          bin: "mock",
          args: [],
          cwd: cwd ?? "/",
          env: { SESSION: context?.sessionId },
          messagePolicy: { bracketedPaste: true, multilineStrategy: "paste-mode" },
        };
      },
      startShell: (launch) => {
        const pty = createMockPty();
        ptys.set(String(launch.env.SESSION), pty);
        return pty;
      },
    });

    expect(manager.writeToSession("session-a", "missing")).toBe(false);
    await manager.createSession({ sessionId: "session-a", cwd: "/a" });

    expect(manager.writeToSession("session-a", "hello")).toBe(true);
    expect(manager.getSessionMessagePolicy("session-a")).toEqual({ bracketedPaste: true, multilineStrategy: "paste-mode" });
    expect(ptys.get("session-a")?.writes).toEqual(["hello"]);
    expect(launches).toEqual(["session-a"]);

    expect(manager.terminate("session-a")).toBe(true);
    expect(manager.writeToSession("session-a", "after")).toBe(false);
    expect(ptys.get("session-a")?.writes).toEqual(["hello"]);
  });

  it("returns false when the session pty rejects programmatic writes", async () => {
    const manager = createTerminalSessionManager({
      launch: async (cwd) => ({ bin: "mock", args: [], cwd: cwd ?? "/", env: {} }),
      startShell: () => ({
        ...createMockPty(),
        write() {
          throw new Error("not writable");
        },
      }),
    });

    await manager.createSession({ sessionId: "session-a", cwd: "/a" });

    expect(manager.writeToSession("session-a", "hello")).toBe(false);
  });

  it("keeps the pty alive when the active socket closes, surviving reconnect", async () => {
    const ptys = new Map<string, MockPty>();
    const exits: string[] = [];
    const manager = createTerminalSessionManager({
      launch: async (cwd, context) => ({ bin: "mock", args: [], cwd: cwd ?? "/", env: { SESSION: context?.sessionId } }),
      startShell: (launch) => {
        const pty = createMockPty();
        ptys.set(String(launch.env.SESSION), pty);
        return pty;
      },
      onSessionExit: (sessionId) => exits.push(sessionId),
    });
    const first = createMockSocket();
    const second = createMockSocket();

    await manager.attach(first, { sessionId: "session-a", cwd: "/a" });
    ptys.get("session-a")?.emitData("before-detach");
    first.emitClose();

    // 소켓이 끊겨도(콘솔 웹 종료·세션 전환) PTY는 살아있고 세션도 정리되지 않는다 — 자동 종료 없음.
    expect(ptys.get("session-a")?.killed()).toBe(false);
    expect(exits).toEqual([]);

    // 재연결하면 같은 세션에 다시 붙어 scrollback을 그대로 재생한다.
    await manager.attach(second, { sessionId: "session-a", cwd: "/a" });
    expect(second.sent.map((chunk) => chunk.toString("utf8"))).toEqual(["before-detach"]);
    expect(ptys.get("session-a")?.killed()).toBe(false);
  });

  it("removes the session and notifies exit when the pty exits on its own", async () => {
    const ptys = new Map<string, MockPty>();
    const exits: string[] = [];
    const manager = createTerminalSessionManager({
      launch: async (cwd, context) => ({ bin: "mock", args: [], cwd: cwd ?? "/", env: { SESSION: context?.sessionId } }),
      startShell: (launch) => {
        const pty = createMockPty();
        ptys.set(String(launch.env.SESSION), pty);
        return pty;
      },
      onSessionExit: (sessionId) => exits.push(sessionId),
    });

    await manager.createSession({ sessionId: "session-a", cwd: "/a" });
    ptys.get("session-a")?.emitExit();

    // PTY 자가종료도 node-pty agent.kill() 경로를 한 번 지나 conout/inSocket 정리를 시도한다.
    expect(ptys.get("session-a")?.killed()).toBe(true);
    expect(exits).toEqual(["session-a"]);
  });

  it("cleans up and notifies exit when natural-exit kill reports the pty already exited", async () => {
    const ptys = new Map<string, MockPty>();
    const exits: string[] = [];
    const manager = createTerminalSessionManager({
      launch: async (cwd, context) => ({ bin: "mock", args: [], cwd: cwd ?? "/", env: { SESSION: context?.sessionId } }),
      startShell: (launch) => {
        const pty = createMockPty();
        pty.throwAlreadyExitedOnKill();
        ptys.set(String(launch.env.SESSION), pty);
        return pty;
      },
      onSessionExit: (sessionId) => exits.push(sessionId),
    });

    await manager.createSession({ sessionId: "session-a", cwd: "/a" });

    expect(() => ptys.get("session-a")?.emitExit()).not.toThrow();
    expect(ptys.get("session-a")?.killCount()).toBe(1);
    expect(exits).toEqual(["session-a"]);
    expect(manager.writeToSession("session-a", "after-exit")).toBe(false);
  });

  it("cleans up and notifies exit when natural-exit kill throws an unexpected error", async () => {
    const ptys = new Map<string, MockPty>();
    const exits: string[] = [];
    let cleanupCount = 0;
    const manager = createTerminalSessionManager({
      launch: async (cwd, context) => ({
        bin: "mock",
        args: [],
        cwd: cwd ?? "/",
        env: { SESSION: context?.sessionId },
        cleanup: () => {
          cleanupCount += 1;
        },
      }),
      startShell: (launch) => {
        const pty = createMockPty();
        pty.throwUnexpectedOnKill();
        ptys.set(String(launch.env.SESSION), pty);
        return pty;
      },
      onSessionExit: (sessionId) => exits.push(sessionId),
    });

    await manager.createSession({ sessionId: "session-a", cwd: "/a" });

    expect(() => ptys.get("session-a")?.emitExit()).not.toThrow();
    await Promise.resolve();
    expect(ptys.get("session-a")?.killCount()).toBe(1);
    expect(exits).toEqual(["session-a"]);
    expect(cleanupCount).toBe(1);
    expect(manager.writeToSession("session-a", "after-exit")).toBe(false);
  });

  it("passes the terminal kind into the launch resolver", async () => {
    const launchKinds: Array<string | undefined> = [];
    const manager = createTerminalSessionManager({
      launch: async (cwd, context) => {
        launchKinds.push(context?.kind);
        return { bin: "mock", args: [], cwd: cwd ?? "/", env: {} };
      },
      startShell: () => createMockPty(),
    });

    await manager.attach(createMockSocket(), { sessionId: "shell", cwd: "", kind: "shell" });

    expect(launchKinds).toEqual(["shell"]);
  });
});

function createMockPty(): MockPty {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<() => void> = [];
  let killed = false;
  let killCount = 0;
  let throwAlreadyExited = false;
  let throwUnexpected = false;
  return {
    writes: [],
    resizes: [],
    killed: () => killed,
    killCount: () => killCount,
    emitData(data) {
      for (const listener of dataListeners) listener(data);
    },
    emitExit() {
      for (const listener of exitListeners) listener();
    },
    throwAlreadyExitedOnKill() {
      throwAlreadyExited = true;
    },
    throwUnexpectedOnKill() {
      throwUnexpected = true;
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
      killCount += 1;
      if (throwAlreadyExited) throw new Error("Cannot kill a pty that has already exited");
      if (throwUnexpected) throw new Error("unexpected kill failure");
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

function createDeferred<T>(): { readonly promise: Promise<T>; resolve(value: T | PromiseLike<T>): void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
