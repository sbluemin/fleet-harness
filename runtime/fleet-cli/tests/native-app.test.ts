import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentCliProfile } from "@dotobokuri/fleet-admiral";

import { KITTY_DISABLE, KITTY_ENABLE, type PtyExitEvent } from "../src/controls/index.js";
import { createNativeTerminalLaunchStrategy } from "../src/native-app.js";

class FakePty {
  readonly writes: string[] = [];
  readonly resizes: Array<{ readonly cols: number; readonly rows: number }> = [];
  killCalls = 0;
  private dataListeners: Array<(chunk: string) => void> = [];
  private exitListeners: Array<(event: { readonly exitCode: number; readonly signal?: number }) => void> = [];

  onData(listener: (chunk: string) => void): { readonly dispose: () => void } {
    this.dataListeners.push(listener);
    return {
      dispose: () => {
        this.dataListeners = this.dataListeners.filter((candidate) => candidate !== listener);
      },
    };
  }

  onExit(listener: (event: { readonly exitCode: number; readonly signal?: number }) => void): { readonly dispose: () => void } {
    this.exitListeners.push(listener);
    return {
      dispose: () => {
        this.exitListeners = this.exitListeners.filter((candidate) => candidate !== listener);
      },
    };
  }

  write(data: string | Buffer): void {
    this.writes.push(Buffer.isBuffer(data) ? data.toString("utf8") : data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killCalls++;
  }

  emitData(chunk: string): void {
    for (const listener of this.dataListeners) {
      listener(chunk);
    }
  }

  emitExit(event: { readonly exitCode: number; readonly signal?: number }): void {
    for (const listener of [...this.exitListeners]) {
      listener(event);
    }
  }
}

const TEST_PROFILE: AgentCliProfile = {
  args: ["--model", "test"],
  bin: "codex",
  binPrefixArgs: ["shim"],
  cwd: "/tmp/native",
  env: { FLEET_TEST: "1" },
  id: "codex",
  label: "Codex",
  terminalName: "xterm-256color",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../src/app.js");
  vi.doUnmock("../src/tui/renderer.js");
  vi.doUnmock("../src/controls/pty/shell.js");
  vi.doUnmock("../src/runtime/runtime.js");
  vi.doUnmock("../src/mission-control/controller.js");
  vi.doUnmock("../src/mission-control/options/runtime.js");
  vi.doUnmock("../src/mission-control/menu/wiki-panel.js");
  vi.doUnmock("../src/mission-control/loaded-counts.js");
  vi.doUnmock("../src/tui/terminal-size.js");
  vi.doUnmock("../src/release.js");
  vi.doUnmock("../src/update/check.js");
  vi.doUnmock("@dotobokuri/fleet-admiral");
});

describe("native terminal app", () => {
  it("wires native launcher input through Mission Control instead of the input router", async () => {
    vi.resetModules();
    const handleInput = vi.fn();
    const missionControlResize = vi.fn();
    const addInputListener = vi.fn();
    const stdinListeners = new Set<(data: Buffer | string) => void>();
    const processOn = vi.spyOn(process, "on").mockImplementation(() => process);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "on").mockImplementation(() => process.stdout);
    vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
    vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    const stdinOn = vi.spyOn(process.stdin, "on").mockImplementation((_event, listener) => {
      stdinListeners.add(listener as (data: Buffer | string) => void);
      return process.stdin;
    });
    const stdinOff = vi.spyOn(process.stdin, "off").mockImplementation((_event, listener) => {
      stdinListeners.delete(listener as (data: Buffer | string) => void);
      return process.stdin;
    });

    class FakeLocalTui {
      private listeners: Array<(data: string) => void> = [];

      readonly columns = 80;
      readonly rows = 24;

      addInputListener(listener: (data: string) => void): () => void {
        addInputListener(listener);
        this.listeners.push(listener);
        return () => {
          this.listeners = this.listeners.filter((candidate) => candidate !== listener);
        };
      }

      emitInput(data: string): void {
        for (const listener of this.listeners) {
          listener(data);
        }
      }

      refreshSize(): void {}
      requestRender(): void {}
      setChildren(): void {}
      start(): void {}
      stop(): void {}
    }

    const tuiInstances: FakeLocalTui[] = [];

    vi.doMock("../src/app.js", () => ({
      createMissionControlProfileConfig: () => ({
        cliOptions: [{ id: "codex", label: "Codex" }],
        initialCliId: "codex",
        resolveProfile: async () => TEST_PROFILE,
      }),
    }));
    vi.doMock("../src/tui/renderer.js", () => ({
      LocalTui: class extends FakeLocalTui {
        constructor() {
          super();
          tuiInstances.push(this);
        }
      },
    }));
    vi.doMock("../src/runtime/runtime.js", () => ({
      createFleetRuntimeLifecycle: () => ({
        shutdown: async () => undefined,
        start: async () => ({
          carrierRuntime: {
            jobs: {
              streaming: {
                register: () => () => undefined,
              },
            },
          },
          dedicatedMcpSession: {},
          infraServices: {
            authService: {},
            globalOptionsService: {},
          },
        }),
      }),
    }));
    vi.doMock("../src/mission-control/controller.js", () => ({
      createMissionControlController: () => ({
        component: {
          handleInput,
          invalidate: () => undefined,
          render: () => [],
        },
        ptyView: {
          get maxRows() {
            return 0;
          },
          resize: missionControlResize,
        },
        dispose: () => undefined,
        setRelease: () => undefined,
      }),
    }));
    vi.doMock("../src/mission-control/options/runtime.js", () => ({
      createSessionOptionsRuntime: () => ({
        getDraft: () => ({
          cliId: "codex",
          enableMetaphor: false,
          replaceSystemPrompt: true,
        }),
        getResolved: () => ({
          values: {
            cliId: "codex",
            enableMetaphor: false,
            replaceSystemPrompt: true,
          },
        }),
      }),
    }));
    vi.doMock("../src/mission-control/menu/wiki-panel.js", () => ({
      createWikiProcessController: () => ({}),
    }));
    vi.doMock("../src/mission-control/loaded-counts.js", () => ({
      discoverMissionControlCounts: () => ({}),
    }));
    vi.doMock("../src/release.js", () => ({
      readFleetCliRelease: () => ({ channel: "local", version: "0.0.0" }),
    }));
    vi.doMock("../src/update/check.js", () => ({
      checkForUpdate: async () => undefined,
    }));
    vi.doMock("@dotobokuri/fleet-admiral", () => ({
      createSystemPromptBuilder: () => ({ build: () => "prompt" }),
      getAgentCliMetadata: () => [{ id: "codex", label: "Codex" }],
      getDefaultAgentCliId: () => "codex",
      injectAgentCliProfile: async (profile: AgentCliProfile) => profile,
      parseAgentCliId: (value: string | undefined) => value,
    }));

    const { runNativeApp } = await import("../src/native-app.js");

    await runNativeApp();
    for (const listener of stdinListeners) {
      listener(Buffer.from("\r"));
    }

    expect(tuiInstances).toHaveLength(1);
    expect(addInputListener).toHaveBeenCalledTimes(1);
    expect(handleInput).toHaveBeenCalledWith("\r");
    expect(stdinOn).toHaveBeenCalledTimes(1);
    expect(stdinOff).not.toHaveBeenCalled();
    // 런처가 빈 화면이 되지 않도록 Mission Control에 터미널 크기가 전파되어야 한다.
    expect(missionControlResize).toHaveBeenCalled();
    expect(processOn).toHaveBeenCalled();
    expect(stdoutWrite).toHaveBeenCalled();
  });

  it("injects sanitized carrier reminders only while a native raw PTY child is active", async () => {
    vi.resetModules();
    const pty = new FakePty();
    const stdinListeners = new Set<(data: Buffer | string) => void>();
    const handleInput = vi.fn();
    const unregisterCarrierStream = vi.fn();
    const missionControlResize = vi.fn();
    let carrierStreamHandler: ((event: {
      readonly systemReminder?: string;
      readonly type: string;
    }) => void) | undefined;
    let launchProfile: ReturnType<typeof createNativeTerminalLaunchStrategy> | undefined;
    let stdoutResize: (() => void) | undefined;
    let sigwinch: (() => void) | undefined;
    const startShell = vi.fn(() => pty as never);
    vi.spyOn(process, "on").mockImplementation((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === "SIGWINCH") {
        sigwinch = listener as () => void;
      }
      return process;
    });
    vi.spyOn(process.stdout, "on").mockImplementation((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === "resize") {
        stdoutResize = listener as () => void;
      }
      return process.stdout;
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
    vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    const stdinOn = vi.spyOn(process.stdin, "on").mockImplementation((_event: string | symbol, listener: (...args: unknown[]) => void) => {
      stdinListeners.add(listener as (data: Buffer | string) => void);
      return process.stdin;
    });
    const stdinOff = vi.spyOn(process.stdin, "off").mockImplementation((_event: string | symbol, listener: (...args: unknown[]) => void) => {
      stdinListeners.delete(listener as (data: Buffer | string) => void);
      return process.stdin;
    });

    vi.doMock("../src/app.js", () => ({
      createMissionControlProfileConfig: () => ({
        cliOptions: [{ id: "codex", label: "Codex" }],
        initialCliId: "codex",
        resolveProfile: async () => TEST_PROFILE,
      }),
    }));
    vi.doMock("../src/tui/renderer.js", () => ({
      LocalTui: class {
        private listeners: Array<(data: string) => void> = [];

        addInputListener(listener: (data: string) => void): () => void {
          this.listeners.push(listener);
          return () => {
            this.listeners = this.listeners.filter((candidate) => candidate !== listener);
          };
        }

        emitInput(data: string): void {
          for (const listener of this.listeners) {
            listener(data);
          }
        }

        refreshSize(): void {}
        requestRender(): void {}
        setChildren(): void {}
        start(): void {}
        stop(): void {}
      },
    }));
    vi.doMock("../src/controls/pty/shell.js", () => ({ startShell }));
    vi.doMock("../src/tui/terminal-size.js", () => ({
      getTerminalSize: () => ({ columns: 120, rows: 50 }),
    }));
    vi.doMock("../src/runtime/runtime.js", () => ({
      createFleetRuntimeLifecycle: () => ({
        shutdown: async () => undefined,
        start: async () => ({
          carrierRuntime: {
            jobs: {
              streaming: {
                register: (handler: typeof carrierStreamHandler) => {
                  carrierStreamHandler = handler;
                  return unregisterCarrierStream;
                },
              },
            },
          },
          dedicatedMcpSession: {},
          infraServices: {
            authService: {},
            globalOptionsService: {},
          },
        }),
      }),
    }));
    vi.doMock("../src/mission-control/controller.js", () => ({
      createMissionControlController: (options: { readonly launchProfile?: typeof launchProfile }) => {
        launchProfile = options.launchProfile;
        return {
          component: {
            handleInput,
            invalidate: () => undefined,
            render: () => [],
          },
          ptyView: {
            get maxRows() {
              return 0;
            },
            resize: missionControlResize,
          },
          dispose: () => undefined,
          setRelease: () => undefined,
        };
      },
    }));
    vi.doMock("../src/mission-control/options/runtime.js", () => ({
      createSessionOptionsRuntime: () => ({
        getDraft: () => ({
          cliId: "codex",
          enableMetaphor: false,
          replaceSystemPrompt: true,
        }),
        getResolved: () => ({
          values: {
            cliId: "codex",
            enableMetaphor: false,
            replaceSystemPrompt: true,
          },
        }),
      }),
    }));
    vi.doMock("../src/mission-control/menu/wiki-panel.js", () => ({
      createWikiProcessController: () => ({}),
    }));
    vi.doMock("../src/mission-control/loaded-counts.js", () => ({
      discoverMissionControlCounts: () => ({}),
    }));
    vi.doMock("../src/release.js", () => ({
      readFleetCliRelease: () => ({ channel: "local", version: "0.0.0" }),
    }));
    vi.doMock("../src/update/check.js", () => ({
      checkForUpdate: async () => undefined,
    }));
    vi.doMock("@dotobokuri/fleet-admiral", () => ({
      createSystemPromptBuilder: () => ({ build: () => "prompt" }),
      getAgentCliMetadata: () => [{ id: "codex", label: "Codex" }],
      getDefaultAgentCliId: () => "codex",
      injectAgentCliProfile: async (profile: AgentCliProfile) => profile,
      parseAgentCliId: (value: string | undefined) => value,
    }));

    const { runNativeApp } = await import("../src/native-app.js");

    await runNativeApp();
    carrierStreamHandler?.(finalizedReminderEvent("launcher reminder"));
    stdoutResize?.();
    expect(pty.writes).toEqual([]);
    expect(missionControlResize).toHaveBeenCalledWith(120, 50);

    const exits: PtyExitEvent[] = [];
    const promise = launchProfile?.({
      cols: 90,
      createPtyHost: () => {
        throw new Error("must not create PTY host");
      },
      createPtyView: () => {
        throw new Error("must not create PTY view");
      },
      onActive: () => {
        throw new Error("must not create embedded launch");
      },
      onExit: (event) => exits.push(event),
      onNativeActive: () => undefined,
      onRenderRequest: () => undefined,
      profile: TEST_PROFILE,
      rows: 30,
    });
    await Promise.resolve();
    sigwinch?.();
    carrierStreamHandler?.({ type: "track:begin" });
    carrierStreamHandler?.(finalizedReminderEvent("active\x1b[201~ reminder\x07"));
    for (const listener of stdinListeners) {
      listener("typed");
    }
    pty.emitExit({ exitCode: 0 });
    await promise;
    carrierStreamHandler?.(finalizedReminderEvent("after exit"));

    expect(startShell).toHaveBeenCalledTimes(1);
    expect(stdinOn).toHaveBeenCalledTimes(1);
    expect(stdinOff).not.toHaveBeenCalled();
    expect(pty.resizes).toEqual([{ cols: 120, rows: 50 }]);
    expect(pty.writes).toEqual(["active reminder\r", "typed"]);
    expect(exits).toEqual([{ exitCode: 0, signal: undefined }]);
    for (const listener of stdinListeners) {
      listener("after-exit-input");
    }
    expect(handleInput).toHaveBeenCalledWith("after-exit-input");
    expect(unregisterCarrierStream).not.toHaveBeenCalled();
  });

  it("hands off to a raw node-pty bridge and resumes Fleet in order", async () => {
    const events: string[] = [];
    const pty = new FakePty();
    let activeChild: { readonly bridge: { readonly writeRaw: (data: string) => void } } | undefined;
    const startShellCalls: Array<{ readonly args: readonly string[]; readonly env: Record<string, string> }> = [];
    const launch = createNativeTerminalLaunchStrategy({
      getTerminalSize: () => ({ columns: 100, rows: 40 }),
      onActiveChildChange: (child) => {
        activeChild = child;
        events.push(child === undefined ? "active-child:clear" : "active-child:set");
      },
      onAfterResume: () => events.push("render"),
      runCleanup: () => events.push("cleanup"),
      startShell: ((config, opts) => {
        events.push(`start:${config.profile.bin}:${opts.cols}x${opts.rows}`);
        startShellCalls.push({ args: config.profile.args, env: { ...config.profile.env } });
        return pty as never;
      }) as never,
      stdout: {
        write: (chunk: string) => {
          events.push(chunk === KITTY_DISABLE ? "kitty-disable" : chunk === KITTY_ENABLE ? "kitty-enable" : `stdout:${chunk}`);
          return true;
        },
      },
      ui: {
        refreshSize: (size) => events.push(`resize:${size.columns}x${size.rows}`),
        start: () => events.push("ui-start"),
        stop: () => events.push("ui-stop"),
      },
    });
    const exitEvents: PtyExitEvent[] = [];
    const promise = launch({
      cols: 80,
      createPtyHost: () => {
        throw new Error("must not create PTY host");
      },
      createPtyView: () => {
        throw new Error("must not create PTY view");
      },
      onActive: () => {
        throw new Error("must not create embedded launch");
      },
      onExit: (event) => exitEvents.push(event),
      onNativeActive: () => events.push("native-active"),
      onRenderRequest: () => undefined,
      profile: TEST_PROFILE,
      rows: 24,
    });

    expect(events).toEqual([
      "kitty-disable",
      "ui-stop",
      "start:codex:80x24",
      "active-child:set",
      "native-active",
    ]);
    activeChild?.bridge.writeRaw("raw\r");
    pty.emitData("child-output");
    pty.emitExit({ exitCode: 0 });
    await promise;

    expect(events).toEqual([
      "kitty-disable",
      "ui-stop",
      "start:codex:80x24",
      "active-child:set",
      "native-active",
      "stdout:child-output",
      "active-child:clear",
      "cleanup",
      "resize:100x40",
      "ui-start",
      "kitty-enable",
      "render",
    ]);
    expect(pty.writes).toEqual(["raw\r"]);
    expect(startShellCalls).toEqual([{ args: ["--model", "test"], env: { FLEET_TEST: "1" } }]);
    expect(startShellCalls[0]?.env).not.toBe(TEST_PROFILE.env);
    expect(exitEvents).toEqual([{ exitCode: 0, signal: undefined }]);
  });

  it("preserves node-pty signal exits for Mission Control diagnostics", async () => {
    const pty = new FakePty();
    const launch = createNativeTerminalLaunchStrategy({
      runCleanup: () => undefined,
      startShell: (() => pty as never) as never,
      stdout: { write: () => true },
      ui: {
        refreshSize: () => undefined,
        start: () => undefined,
        stop: () => undefined,
      },
    });
    const exitEvents: PtyExitEvent[] = [];
    const promise = launch({
      cols: 80,
      createPtyHost: () => {
        throw new Error("must not create PTY host");
      },
      createPtyView: () => {
        throw new Error("must not create PTY view");
      },
      onActive: () => undefined,
      onExit: (event) => exitEvents.push(event),
      onNativeActive: () => undefined,
      onRenderRequest: () => undefined,
      profile: TEST_PROFILE,
      rows: 24,
    });

    pty.emitExit({ exitCode: 1, signal: 15 });
    await promise;

    expect(exitEvents).toEqual([{ exitCode: 1, signal: 15 }]);
  });

  it("restores Fleet when native PTY startup throws", async () => {
    const events: string[] = [];
    const launch = createNativeTerminalLaunchStrategy({
      runCleanup: () => events.push("cleanup"),
      startShell: (() => {
        throw new Error("spawn failed");
      }) as never,
      stdout: {
        write: (chunk: string) => {
          events.push(chunk === KITTY_DISABLE ? "kitty-disable" : chunk === KITTY_ENABLE ? "kitty-enable" : `stdout:${chunk}`);
          return true;
        },
      },
      ui: {
        refreshSize: () => events.push("resize"),
        start: () => events.push("ui-start"),
        stop: () => events.push("ui-stop"),
      },
    });
    const promise = launch({
      cols: 80,
      createPtyHost: () => {
        throw new Error("must not create PTY host");
      },
      createPtyView: () => {
        throw new Error("must not create PTY view");
      },
      onActive: () => undefined,
      onExit: () => undefined,
      onNativeActive: () => events.push("native-active"),
      onRenderRequest: () => undefined,
      profile: TEST_PROFILE,
      rows: 24,
    });

    await expect(promise).rejects.toThrow("spawn failed");
    expect(events).toEqual(["kitty-disable", "ui-stop", "cleanup", "resize", "ui-start", "kitty-enable"]);
  });
});

function finalizedReminderEvent(systemReminder: string): {
  readonly finishedAt: number;
  readonly jobId: string;
  readonly status: "done";
  readonly summary: string;
  readonly systemReminder: string;
  readonly type: "job:finalized";
} {
  return {
    finishedAt: 1,
    jobId: "job:test",
    status: "done",
    summary: "done",
    systemReminder,
    type: "job:finalized",
  };
}
