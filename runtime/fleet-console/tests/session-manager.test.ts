import { describe, expect, it, vi } from "vitest";

import { createTerminalSessionManager } from "../../fleet-plugins/terminal/server/shared/session-manager.js";
import type { TerminalPtyDataDisposable, TerminalPtyHandle, TerminalSocket, TerminalSocketData } from "../../fleet-plugins/terminal/server/shared/terminal-types.js";

interface MockPty extends TerminalPtyHandle {
  readonly writes: Array<string | Buffer>;
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

  /** 볼 대상이 없는 관전은 성립하지 않는다 — 여기서 PTY를 띄우면 관전이 실행이 된다. */
  it("refuses to open a session for a viewer", () => {
    const started: MockPty[] = [];
    const manager = createTerminalSessionManager({
      launch: async (cwd) => ({ bin: "mock", args: [], cwd: cwd ?? "/", env: {} }),
      startShell: () => { const pty = createMockPty(); started.push(pty); return pty; },
    });

    expect(manager.attachViewer(createMockSocket(), "never-started")).toBe(false);
    expect(started).toHaveLength(0);
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
    expect(second.sent.map((chunk) => chunk.toString("utf8"))).toEqual([
      JSON.stringify({ type: "replay_state", alternateScreenActive: false, mouseProtocol: "none", mouseEncoding: "default" }),
      "before-detach",
      JSON.stringify({ type: "replay_end", alternateScreenActive: false, mouseProtocol: "none", mouseEncoding: "default" }),
    ]);
    expect(ptys.get("session-a")?.killed()).toBe(false);
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
