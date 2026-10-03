import { afterEach, describe, expect, it, vi } from "vitest";

import { createConsoleObservabilityStore } from "../../features/execution/host/agent/observability-store.js";
import { createOscAgentActivityTracker } from "../../features/execution/host/agent/osc-agent-activity.js";
import { createTerminalSessionManager } from "../../features/execution/host/terminal/session-manager.js";
import type { TerminalPtyHandle, TerminalSocket, TerminalSocketData } from "../../features/execution/host/terminal/terminal-types.js";

afterEach(() => {
  vi.useRealTimers();
});

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

  it("keeps raw titles private and emits once per semantic transition across repeated spinner frames", async () => {
    const ptys = new Map<string, MockPty>();
    const store = createConsoleObservabilityStore({ workspaceHash: () => "theater-a" });
    store.createPendingTerminalSession({ sessionId: "agent-private", cwd: "/work", cliId: "claude", createdAt: 1_000 });
    const frames: unknown[] = [];
    const activityCalls: string[] = [];
    store.subscribeAll((event) => frames.push(event));
    const tracker = createOscAgentActivityTracker({
      cliId: "claude",
      cwdBasename: "work",
      onActivity: (activity) => {
        activityCalls.push(activity);
        const updated = store.setTerminalSessionModelActivity("agent-private", activity);
        if (updated) store.notifySessionUpdated(updated);
      },
    });
    const manager = createTerminalSessionManager({
      launch: async (cwd, context) => ({ bin: "mock", args: [], cwd: cwd ?? "/", env: { SESSION_ID: context?.sessionId } }),
      startShell: (launch) => {
        const pty = createMockPty();
        ptys.set(String(launch.env.SESSION_ID), pty);
        return pty;
      },
      resolveTitleListener: () => (_sessionId, title) => tracker.observeTitle(title),
    });
    const socket = createMockSocket();
    await manager.attach(socket, { sessionId: "agent-private", cwd: "/work", operationType: "agent" });
    const privateBody = "private-conversation-project";
    const rawTitle = `⠏ ${privateBody}`;

    for (let index = 0; index < 10; index += 1) {
      ptys.get("agent-private")?.emitData(`\x1b]0;${rawTitle}\x07`);
    }
    expect(activityCalls).toHaveLength(10);
    expect(frames.map((frame) => (frame as { readonly type: string }).type)).toEqual(["session:updated"]);

    store.notifySessionAttention(store.getTerminalSessionInfo("agent-private")!, "permission_prompt");
    for (let index = 0; index < 10; index += 1) {
      ptys.get("agent-private")?.emitData(`\x1b]0;${rawTitle}\x07`);
    }
    expect(activityCalls).toHaveLength(20);
    expect(frames.map((frame) => (frame as { readonly type: string }).type)).toEqual([
      "session:updated",
      "session:attention",
      "session:updated",
    ]);
    expect(store.getTerminalSessionInfo("agent-private")).not.toHaveProperty("attentionPending");

    const browserAndDurableState = JSON.stringify({
      session: store.getTerminalSessionInfo("agent-private"),
      frames,
      durable: store.listDurableOperations(),
    });
    expect(browserAndDurableState).not.toContain(rawTitle);
    expect(browserAndDurableState).not.toContain(privateBody);
    expect(socket.sent[0]?.toString("utf8")).toContain(rawTitle);
    await manager.stop();
  });

  /**
   * Shell의 `cd` 주입(open-at)은 프롬프트 줄이 비었을 때만 허용된다. 명령이 도는 동안 미리 친 글자는
   * 다음 프롬프트 줄에 다시 올라오므로, 그 프롬프트의 cwd 보고가 "입력 중"을 지우면 치다 만 줄 뒤에
   * `cd …`가 붙어 실행된다.
   */
  it("keeps the prompt line dirty for typed-ahead input until a line is ended", async () => {
    let pty: MockPty | null = null;
    const manager = createTerminalSessionManager({
      launch: async (cwd) => ({ bin: "zsh", args: [], cwd: cwd ?? "/", env: {} }),
      startShell: () => (pty = createMockPty()),
      resolveCwdListener: () => () => undefined,
    });
    const socket = createMockSocket();
    await manager.attach(socket, { sessionId: "console-shell", cwd: "/work", operationType: "shell" });
    const cwd = (dir: string) => pty!.emitData(`\x1b]7;file://${dir}\x07`);
    const prompt = () => pty!.emitData("\x1b]7;file:///work\x07\x1b]133;A\x07% ");
    const line = () => manager.getShellLineState("console-shell");

    // rc가 도는 동안 나온 cwd 보고는 프롬프트가 아니다.
    cwd("/work");
    expect(line()).toMatchObject({ promptSeen: false, promptOpen: false });

    prompt();
    socket.type("sleep 3\r");
    socket.type("abc");
    prompt();
    expect(line()).toMatchObject({ promptOpen: true, inputPending: true });

    socket.type("\r");
    prompt();
    expect(line()).toMatchObject({ promptOpen: true, inputPending: false });

    // 명령 안에서 디렉터리를 옮기면 zsh `chpwd`가 cwd를 보고하지만, 그 뒤의 `read`는 프롬프트가 아니다.
    socket.type("cd /tmp; read answer\r");
    cwd("/tmp");
    expect(line()).toMatchObject({ promptOpen: false });
    socket.type("yes\r");
    prompt();

    // 대체 화면을 쥔 전체 화면 프로그램(less)이 읽은 키는 셸 줄에 남지 않는다.
    socket.type("less notes.txt\r");
    pty!.emitData("\x1b[?1049h");
    socket.type("q");
    pty!.emitData("\x1b[?1049l");
    prompt();
    expect(line()).toMatchObject({ promptOpen: true, inputPending: false });
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
  /** 브라우저가 키 입력을 보내듯 binary 프레임을 넣는다. */
  type(text: string): void;
}

function createMockSocket(): MockSocket {
  const messageListeners: Array<(data: TerminalSocketData, isBinary: boolean) => void> = [];
  return {
    readyState: 1,
    sent: [],
    send(data, options) {
      if (options.binary) this.sent.push(Buffer.from(data));
    },
    type(text) {
      for (const listener of messageListeners) listener(Buffer.from(text, "utf8"), true);
    },
    close() {},
    on(_event: "message", listener: (data: TerminalSocketData, isBinary: boolean) => void) {
      messageListeners.push(listener);
    },
    once(_event: "close", _listener: () => void) {},
  };
}

function removeListener<T>(listeners: T[], listener: T): void {
  const index = listeners.indexOf(listener);
  if (index >= 0) listeners.splice(index, 1);
}
