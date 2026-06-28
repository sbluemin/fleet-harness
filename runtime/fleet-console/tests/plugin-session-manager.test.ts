import { describe, expect, it } from "vitest";

import { createTerminalSessionManager } from "../../fleet-plugins/terminal/server/shared/session-manager.js";
import type { TerminalPtyDataDisposable, TerminalPtyHandle } from "../../fleet-plugins/terminal/server/shared/terminal-types.js";

interface MockPty extends TerminalPtyHandle {
  readonly killed: () => boolean;
  readonly disposed: () => number;
}

describe("plugin terminal session manager", () => {
  it("cleans up a spawned pty when registration fails before the session is stored", async () => {
    let cleanupCount = 0;
    const failedPty = createMockPty({ throwOnExitRegistration: true });
    const healthyPty = createMockPty();
    const ptys = [failedPty, healthyPty];
    const manager = createTerminalSessionManager({
      launch: async (cwd) => ({
        bin: "mock",
        args: [],
        cwd: cwd ?? "/",
        env: {},
        cleanup: () => {
          cleanupCount += 1;
        },
      }),
      startShell: () => ptys.shift() ?? createMockPty(),
    });

    await expect(manager.createSession({ sessionId: "session-a", cwd: "/a" })).rejects.toThrow("onExit registration failed");

    expect(failedPty.killed()).toBe(true);
    expect(failedPty.disposed()).toBe(1);
    expect(cleanupCount).toBe(1);
    expect(manager.hasLiveSessions()).toBe(false);

    await expect(manager.createSession({ sessionId: "session-a", cwd: "/a" })).resolves.toBeUndefined();
    expect(healthyPty.killed()).toBe(false);
  });
});

function createMockPty(options: { readonly throwOnExitRegistration?: boolean } = {}): MockPty {
  let killed = false;
  let disposed = 0;
  return {
    killed: () => killed,
    disposed: () => disposed,
    onData() {
      return createDisposable(() => {
        disposed += 1;
      });
    },
    onExit() {
      if (options.throwOnExitRegistration) throw new Error("onExit registration failed");
      return createDisposable(() => {
        disposed += 1;
      });
    },
    write() {
      return undefined;
    },
    resize() {
      return undefined;
    },
    kill() {
      killed = true;
    },
  };
}

function createDisposable(onDispose: () => void): TerminalPtyDataDisposable {
  return {
    dispose: onDispose,
  };
}
