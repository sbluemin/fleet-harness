import { closeSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentCliProfile, InjectAgentCliProfileOptions } from "@dotobokuri/fleet-admiral";

import { createDefaultTerminalLaunchResolver } from "../src/terminal/launch.js";
import type { TerminalLaunchSpec } from "../src/terminal/types.js";

interface FakeRuntime {
  readonly carrierRuntime: {
    readonly jobs: {
      readonly streaming: {
        register(callback: (event: unknown) => void): () => void;
      };
    };
  };
  readonly dedicatedMcpSession: unknown;
  readonly mcpRegistry: {
    getAllAgentTools(): readonly unknown[];
  };
  cleanup(): Promise<void>;
}

const baseProfile = {
  id: "claude",
  label: "Claude Code",
  bin: "/bin/claude",
  args: ["--model", "sonnet"],
  cwd: "/work",
  env: { PATH: "/bin", TERM: "xterm-256color" },
  messagePolicy: { bracketedPaste: true, multilineStrategy: "paste-mode" },
  terminalName: "xterm-256color",
} as const;

const TEMP_DIRS: string[] = [];

describe("createDefaultTerminalLaunchResolver", () => {
  afterEach(() => {
    for (const dir of TEMP_DIRS.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves and injects the selected Agent CLI directly instead of a console wrapper", async () => {
    const events: unknown[] = [];
    const runtime = createFakeRuntime((event) => events.push(event));
    const resolveProfile = vi.fn(async (env: NodeJS.ProcessEnv, cwd: string) => ({ ...baseProfile, cwd, env: { ...env } }));
    const injectProfile = vi.fn(async (profile, options) => {
      expect(options.enableMetaphor).toBe(false);
      expect(options.replaceSystemPrompt).toBe(true);
      expect(options.buildSystemPrompt).toEqual(expect.any(Function));
      return { ...profile, args: [...profile.args, "--fleet"] };
    });
    const resolve = createDefaultTerminalLaunchResolver({
      cwd: "/work",
      env: { PATH: "/bin" } as NodeJS.ProcessEnv,
      agentRuntime: runtime as never,
      injectProfile: injectProfile as never,
      resolveProfile: resolveProfile as never,
    });

    const spec = await resolve("/work/project", { sessionId: "session-a" });

    expect(spec).toMatchObject<TerminalLaunchSpec>({
      bin: "/bin/claude",
      args: ["--model", "sonnet", "--fleet"],
      cwd: "/work/project",
      env: expect.objectContaining({
        FLEET_CONSOLE_SESSION_ID: "session-a",
        INIT_CWD: "/work/project",
        PWD: "/work/project",
        TERM: "xterm-256color",
      }),
      messagePolicy: { bracketedPaste: true, multilineStrategy: "paste-mode" },
      terminalName: "xterm-256color",
    });
    expect(resolveProfile).toHaveBeenCalledWith(expect.any(Object), "/work/project", expect.objectContaining({ authEnvResolver: expect.any(Function) }));
    expect(injectProfile).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });

  it("passes a selected Agent CLI id to fleet-admiral profile resolution", async () => {
    const runtime = createFakeRuntime(() => undefined);
    const resolveProfile = vi.fn(async (env: NodeJS.ProcessEnv, cwd: string) => ({ ...baseProfile, id: "codex" as const, label: "Codex", cwd, env: { ...env } }));
    const injectProfile = vi.fn(async (profile) => profile);
    const resolve = createDefaultTerminalLaunchResolver({
      cwd: "/work",
      env: { PATH: "/bin" } as NodeJS.ProcessEnv,
      agentRuntime: runtime as never,
      injectProfile: injectProfile as never,
      resolveProfile: resolveProfile as never,
    });

    await resolve("/work/project", { sessionId: "session-a", cliId: "codex" });

    expect(resolveProfile).toHaveBeenCalledWith(expect.any(Object), "/work/project", expect.objectContaining({ cliId: "codex" }));
  });

  it("honors a FLEET_TERMINAL_CMD override verbatim as an explicit operator override", async () => {
    const resolveProfile = vi.fn();
    const resolve = createDefaultTerminalLaunchResolver({
      cwd: "/work",
      env: { FLEET_TERMINAL_CMD: "bash -l" } as NodeJS.ProcessEnv,
      resolveProfile: resolveProfile as never,
    });

    const spec = await resolve("/work");

    expect(spec.bin).toBe("bash");
    expect(spec.args).toEqual(["-l"]);
    expect(resolveProfile).not.toHaveBeenCalled();
  });

  it("wraps a FLEET_TERMINAL_CMD Windows shim through ComSpec", async () => {
    const binDir = makeTempDir();
    const codexShim = touch(path.join(binDir, "codex.cmd"));
    const comSpec = "C:\\Windows\\System32\\cmd.exe";
    const resolveProfile = vi.fn();
    const resolve = createDefaultTerminalLaunchResolver({
      cwd: "/work",
      env: {
        ComSpec: comSpec,
        FLEET_TERMINAL_CMD: "codex --resume",
        PATH: binDir,
        PATHEXT: ".cmd",
      } as NodeJS.ProcessEnv,
      platform: "win32",
      resolveProfile: resolveProfile as never,
    });

    const spec = await resolve("/work");

    expect(spec.bin).toBe(comSpec);
    expect(spec.args).toEqual(["/d", "/s", "/c", "call", `${codexShim} `, "--resume"]);
    expect(resolveProfile).not.toHaveBeenCalled();
  });

  it("injects selected cwd and console session env for spawned Agent CLI sessions", async () => {
    const resolve = createDefaultTerminalLaunchResolver({
      cwd: "/work",
      env: { EXISTING: "kept", PATH: "/bin" } as NodeJS.ProcessEnv,
      agentRuntime: createFakeRuntime() as never,
      injectProfile: (async (profile: AgentCliProfile) => profile) as never,
      resolveProfile: (async (env: NodeJS.ProcessEnv, cwd: string) => ({ ...baseProfile, cwd, env: { ...env } })) as never,
    });

    const spec = await resolve("/work/project", { sessionId: "session-a" });

    expect(spec.cwd).toBe("/work/project");
    expect(spec.env).toMatchObject({
      EXISTING: "kept",
      FLEET_CONSOLE_SESSION_ID: "session-a",
      INIT_CWD: "/work/project",
      PWD: "/work/project",
      TERM: "xterm-256color",
    });
  });

  it("resolves an extensionless console entry symlink before building hook commands", async () => {
    const binDir = makeTempDir();
    const realEntry = touch(path.join(binDir, "cli.mjs"));
    const symlinkEntry = path.join(binDir, "fleet-console");
    const hookCommands: unknown[] = [];
    symlinkSync(realEntry, symlinkEntry);
    const resolve = createDefaultTerminalLaunchResolver({
      cwd: "/work",
      entryPath: symlinkEntry,
      env: { PATH: "/bin" } as NodeJS.ProcessEnv,
      execPath: "/node",
      agentRuntime: createFakeRuntime() as never,
      injectProfile: (async (profile: AgentCliProfile, options: InjectAgentCliProfileOptions) => {
        hookCommands.push(options.hookExec);
        return profile;
      }) as never,
      resolveProfile: (async () => baseProfile) as never,
    });

    await resolve("/work/project", { sessionId: "session-a" });

    expect(hookCommands).toEqual([
      {
        command: "/node",
        args: [realpathSync(realEntry), "hook", "subagents-context"],
      },
    ]);
  });

  it("launches the user's shell without Agent CLI injection for shell sessions", async () => {
    const resolveProfile = vi.fn();
    const resolve = createDefaultTerminalLaunchResolver({
      cwd: "/work",
      env: { FLEET_TERMINAL_CMD: "bash -l", SHELL: "/bin/zsh" } as NodeJS.ProcessEnv,
      resolveProfile: resolveProfile as never,
    });

    const spec = await resolve("", { sessionId: "shell", kind: "shell" });

    expect(spec).toMatchObject({
      bin: "/bin/zsh",
      args: [],
      cwd: "/work",
    });
    expect(spec.env).toMatchObject({ TERM: "xterm-256color" });
    expect(spec.env.FLEET_CONSOLE_SESSION_ID).toBeUndefined();
    expect(spec.env.INIT_CWD).toBeUndefined();
    expect(resolveProfile).not.toHaveBeenCalled();
  });

  it("resolves the user's Windows shell without Agent CLI injection for shell sessions", async () => {
    const shell = touch(path.join(makeTempDir(), "cmd.exe"));
    const resolveProfile = vi.fn();
    const resolve = createDefaultTerminalLaunchResolver({
      cwd: "/work",
      env: {
        ComSpec: shell,
        PATH: path.dirname(shell),
      } as NodeJS.ProcessEnv,
      platform: "win32",
      resolveProfile: resolveProfile as never,
    });

    const spec = await resolve("", { sessionId: "shell", kind: "shell" });

    expect(spec).toMatchObject({
      bin: shell,
      args: [],
      cwd: "/work",
    });
    expect(spec.env).toMatchObject({ TERM: "xterm-256color" });
    expect(spec.env.FLEET_CONSOLE_SESSION_ID).toBeUndefined();
    expect(spec.env.INIT_CWD).toBeUndefined();
    expect(resolveProfile).not.toHaveBeenCalled();
  });

  it("runs injected cleanup once when the terminal session closes", async () => {
    const cleanup = vi.fn();
    const runtimeCleanup = vi.fn(async () => undefined);
    const resolve = createDefaultTerminalLaunchResolver({
      cwd: "/work",
      env: { PATH: "/bin" } as NodeJS.ProcessEnv,
      agentRuntime: createFakeRuntime(undefined, runtimeCleanup) as never,
      injectProfile: (async (profile: AgentCliProfile, options: InjectAgentCliProfileOptions) => {
        options.onCleanup?.(cleanup);
        return profile;
      }) as never,
      resolveProfile: (async () => baseProfile) as never,
    });

    const spec = await resolve("/work", { sessionId: "session-a" });

    await spec.cleanup?.();
    await spec.cleanup?.();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(runtimeCleanup).not.toHaveBeenCalled();
  });
});

function createFakeRuntime(
  onRegister?: (event: unknown) => void,
  cleanup: () => Promise<void> = async () => undefined,
): FakeRuntime {
  return {
    carrierRuntime: {
      jobs: {
        streaming: {
          register(callback) {
            onRegister?.({ type: "registered" });
            callback({ type: "ready" });
            return () => undefined;
          },
        },
      },
    },
    dedicatedMcpSession: {},
    mcpRegistry: {
      getAllAgentTools: () => [{ name: "carrier_dispatch" }],
    },
    cleanup,
  };
}

function makeTempDir(prefix = "fleet-console-launch-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

function touch(filePath: string): string {
  closeSync(openSync(filePath, "w"));
  return filePath;
}
