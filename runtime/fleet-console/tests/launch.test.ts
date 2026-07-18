import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentCliProfile, InjectAgentCliProfileOptions } from "@dotobokuri/fleet-admiral";

import { createDefaultTerminalLaunchResolver } from "../../fleet-plugins/terminal/server/agent-api/launch.js";
import { createShellTerminalLaunchResolver, resolveNodePtyModulePath, resolveUseConptyDll } from "../../fleet-plugins/terminal/server/shared/pty.js";
import type { TerminalLaunchSpec } from "../../fleet-plugins/terminal/server/shared/terminal-types.js";

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

// 전역 옵션(enableMetaphor)을 고정 반환하는 InfraServices 스텁 —
// launch resolver가 실제 ~/.fleet/settings.json을 읽지 않도록 테스트를 격리한다.
function createFakeInfraServices(globalOptions: { readonly enableMetaphor?: boolean } = {}) {
  const data = { version: 1 as const, ...globalOptions };
  return {
    authService: {},
    globalOptionsService: {
      load: () => data,
      save: () => data,
      update: () => data,
    },
  };
}

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
      expect(options.buildSystemPrompt).toEqual(expect.any(Function));
      expect(options.captureSessionHookExec).toMatchObject({ command: process.execPath });
      expect(options.captureSessionHookExec?.args).toContain("capture-session");
      expect(options.captureSessionHookExec?.args).toContain("claude");
      return { ...profile, args: [...profile.args, "--fleet"] };
    });
    const resolve = createDefaultTerminalLaunchResolver({
      cwd: "/work",
      env: { PATH: "/bin" } as NodeJS.ProcessEnv,
      agentRuntime: runtime as never,
      infraServices: createFakeInfraServices() as never,
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
    expect(resolveProfile).toHaveBeenCalledWith(expect.any(Object), "/work/project", expect.objectContaining({ cliId: undefined }));
    expect(injectProfile).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });

  it("injects global settings (metaphor + system prompt mode) into fleet-admiral injection", async () => {
    const runtime = createFakeRuntime(() => undefined);
    let captured: InjectAgentCliProfileOptions | null = null;
    const resolveProfile = vi.fn(async (env: NodeJS.ProcessEnv, cwd: string) => ({ ...baseProfile, cwd, env: { ...env } }));
    const injectProfile = vi.fn(async (profile: AgentCliProfile, options: InjectAgentCliProfileOptions) => {
      captured = options;
      return profile;
    });
    const resolve = createDefaultTerminalLaunchResolver({
      cwd: "/work",
      env: { PATH: "/bin" } as NodeJS.ProcessEnv,
      agentRuntime: runtime as never,
      infraServices: createFakeInfraServices({ enableMetaphor: true }) as never,
      injectProfile: injectProfile as never,
      resolveProfile: resolveProfile as never,
    });

    await resolve("/work/project", { sessionId: "session-g" });

    expect(captured).not.toBeNull();
    expect(captured!.enableMetaphor).toBe(true);
  });

  it("passes resumeSessionId and capture hook exec to fleet-admiral injection", async () => {
    const runtime = createFakeRuntime(() => undefined);
    const injectedOptions: InjectAgentCliProfileOptions[] = [];
    const resolveProfile = vi.fn(async (env: NodeJS.ProcessEnv, cwd: string) => ({ ...baseProfile, id: "codex" as const, label: "Codex", cwd, env: { ...env } }));
    const injectProfile = vi.fn(async (profile: AgentCliProfile, options: InjectAgentCliProfileOptions) => {
      injectedOptions.push(options);
      return { ...profile, args: [...profile.args, "resume", "provider-session-a"] };
    });
    const resolve = createDefaultTerminalLaunchResolver({
      cwd: "/work",
      entryPath: "/console/cli.ts",
      env: { PATH: "/bin" } as NodeJS.ProcessEnv,
      execPath: "/node",
      tsxLoaderPath: "/loader/tsx.mjs",
      agentRuntime: runtime as never,
      injectProfile: injectProfile as never,
      resolveProfile: resolveProfile as never,
    });

    await resolve("/work/project", { sessionId: "fleet-session-a", cliId: "codex", resumeSessionId: "provider-session-a" });

    expect(resolveProfile).toHaveBeenCalledWith(expect.any(Object), "/work/project", expect.objectContaining({
      cliId: "codex",
      resumeSessionId: "provider-session-a",
    }));
    expect(injectedOptions[0]).toMatchObject({ resumeSessionId: "provider-session-a" });
    expect(injectedOptions[0]?.captureSessionHookExec).toEqual({
      command: "/node",
      args: ["--import", pathToFileURL("/loader/tsx.mjs").href, "/console/cli.ts", "hook", "capture-session", "codex"],
    });
  });

  it("forwards host-only bindings to dedicated MCP without changing the selected execution cwd", async () => {
    const runtime = createFakeRuntime(() => undefined);
    const bindings = Object.freeze({ "fleet-plans.workspace-ref": "opaque-workspace" });
    const resolveProfile = vi.fn(async (env: NodeJS.ProcessEnv, cwd: string) => ({ ...baseProfile, cwd, env: { ...env } }));
    const injectProfile = vi.fn(async (profile: AgentCliProfile) => profile);
    const resolve = createDefaultTerminalLaunchResolver({
      cwd: "/work",
      env: { PATH: "/bin" } as NodeJS.ProcessEnv,
      agentRuntime: runtime as never,
      injectProfile: injectProfile as never,
      resolveProfile: resolveProfile as never,
      resolveServerBindings: (context) => context?.theaterId === "theater-a" ? bindings : undefined,
    });

    const spec = await resolve("/work/.fleet/worktrees/topic", { sessionId: "session-a", theaterId: "theater-a" });

    expect(spec.cwd).toBe("/work/.fleet/worktrees/topic");
    expect(injectProfile).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ serverBindings: bindings }));
    expect(JSON.stringify(spec)).not.toContain("opaque-workspace");
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
      platform: "linux",
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

  it("launches the user's shell without Agent CLI injection for shell sessions", async () => {
    const resolve = createShellTerminalLaunchResolver({
      cwd: "/work",
      env: { FLEET_TERMINAL_CMD: "bash -l", SHELL: "/bin/zsh" } as NodeJS.ProcessEnv,
      platform: "linux",
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
  });

  it("resolves the user's Windows shell without Agent CLI injection for shell sessions", async () => {
    const shell = touch(path.join(makeTempDir(), "cmd.exe"));
    const resolve = createShellTerminalLaunchResolver({
      cwd: "/work",
      env: {
        ComSpec: shell,
        PATH: path.dirname(shell),
      } as NodeJS.ProcessEnv,
      platform: "win32",
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

  it("binds one opaque provider identity resolver during Agent CLI launch", async () => {
    const createResolver = vi.fn(() => ({ resolve: async () => null }));
    const resolve = createDefaultTerminalLaunchResolver({
      cwd: "/work",
      env: { PATH: "/bin" } as NodeJS.ProcessEnv,
      agentRuntime: createFakeRuntime() as never,
      injectProfile: (async (profile: AgentCliProfile) => profile) as never,
      resolveProfile: (async () => ({ ...baseProfile, id: "codex", bin: "/custom/codex-wrapper", binPrefixArgs: ["--wrapper-prefix"] })) as never,
      createSessionIdentityResolver: createResolver as never,
    });

    const spec = await resolve("/work", { sessionId: "session-a", cliId: "claude" });

    expect(spec.sessionIdentityResolver).toMatchObject({ resolve: expect.any(Function) });
    expect(createResolver).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      command: "/custom/codex-wrapper",
      commandPrefixArgs: ["--wrapper-prefix"],
      cwd: "/work",
    }));
  });

  it("maps a Claude-family CLI to the Claude provider identity resolver", async () => {
    const createResolver = vi.fn(() => ({ resolve: async () => null }));
    const resolve = createDefaultTerminalLaunchResolver({
      cwd: "/work",
      env: { PATH: "/bin" } as NodeJS.ProcessEnv,
      agentRuntime: createFakeRuntime() as never,
      injectProfile: (async (profile: AgentCliProfile) => profile) as never,
      resolveProfile: (async () => ({ ...baseProfile, id: "claude-kimi", label: "Kimi (Claude Code)" })) as never,
      createSessionIdentityResolver: createResolver as never,
    });

    await resolve("/work", { sessionId: "session-a", cliId: "claude-kimi" });

    expect(createResolver).toHaveBeenCalledWith(expect.objectContaining({
      provider: "claude",
    }));
  });

  it("does not bind an identity resolver for an explicit shell override", async () => {
    const resolve = createDefaultTerminalLaunchResolver({
      cwd: "/work",
      env: { FLEET_TERMINAL_CMD: "bash -l" } as NodeJS.ProcessEnv,
    });

    const spec = await resolve("/work");
    expect(spec.sessionIdentityResolver).toBeUndefined();
  });
});

describe("resolveUseConptyDll", () => {
  it("defaults on for Windows", () => {
    expect(resolveUseConptyDll("win32", {})).toBe(true);
  });

  it("is always off for Linux and Darwin", () => {
    expect(resolveUseConptyDll("linux", { FLEET_USE_CONPTY_DLL: "1" })).toBe(false);
    expect(resolveUseConptyDll("darwin", { FLEET_USE_CONPTY_DLL: "1" })).toBe(false);
  });

  it("honors the Windows zero override", () => {
    expect(resolveUseConptyDll("win32", { FLEET_USE_CONPTY_DLL: "0" })).toBe(false);
  });

  it("honors the Windows false override case-insensitively", () => {
    expect(resolveUseConptyDll("win32", { FLEET_USE_CONPTY_DLL: "FALSE" })).toBe(false);
  });

  it("honors the Windows enabled override", () => {
    expect(resolveUseConptyDll("win32", { FLEET_USE_CONPTY_DLL: "1" })).toBe(true);
  });
});

describe("resolveNodePtyModulePath", () => {
  it("prefers the fleet-console package resolver for plugin dev cache bundles", () => {
    const repoRoot = path.resolve(process.cwd(), "../..");
    const devCacheBundle = path.join(repoRoot, "runtime/fleet-plugins/terminal/node_modules/.cache/fleet-console-plugin-test/routes.mjs");

    expect(resolveNodePtyModulePath(devCacheBundle)).toContain(path.join(repoRoot, "node_modules", ".pnpm", "node-pty@1.1.0"));
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
