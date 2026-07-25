import { afterEach, describe, expect, it, vi } from "vitest";

import { createConsoleObservabilityStore } from "../server/agent-api/observability-store.js";
import { createOscAgentActivityTracker } from "../server/agent-api/osc-agent-activity.js";
import { createTerminalSessionManager } from "../server/shared/session-manager.js";
import type { TerminalPtyHandle, TerminalSocket, TerminalSocketData } from "../server/shared/terminal-types.js";

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
    store.createPendingTerminalSession({ sessionId: "agent-private", cwd: "/work", cliId: "codex", createdAt: 1_000 });
    const frames: unknown[] = [];
    const activityCalls: string[] = [];
    store.subscribeAll((event) => frames.push(event));
    const tracker = createOscAgentActivityTracker({
      cliId: "codex",
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
    const privateBody = "private-conversation-codexlab";
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
