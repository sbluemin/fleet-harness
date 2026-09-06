import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentCliProfile, InjectAgentCliProfileOptions } from "@dotobokuri/fleet-admiral";

import { createDefaultTerminalLaunchResolver as createDefaultTerminalLaunchResolverImpl } from "../../fleet-plugins/terminal/server/agent-api/launch.js";
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
const DEFAULT_AI_GATEWAY = {
  routePath: "/plugins/terminal/ai-gateway",
  origin: () => "http://127.0.0.1:43210",
};

function createDefaultTerminalLaunchResolver(
  options: Parameters<typeof createDefaultTerminalLaunchResolverImpl>[0],
) {
  return createDefaultTerminalLaunchResolverImpl({ aiGateway: DEFAULT_AI_GATEWAY, ...options });
}

// 전역 옵션을 고정 반환하는 InfraServices 스텁 —
// launch resolver가 실제 ~/.fleet/settings.json을 읽지 않도록 테스트를 격리한다.
function createFakeInfraServices(globalOptions: {
  readonly agentIdleDormantMinutes?: number | null;
  readonly claudeCodeSystemPrompt?: "on" | "off";
} = {}) {
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
        COLORTERM: "truecolor",
        TERM: "xterm-256color",
      }),
      messagePolicy: { bracketedPaste: true, multilineStrategy: "paste-mode" },
      terminalName: "xterm-256color",
    });
    expect(resolveProfile).toHaveBeenCalledWith(expect.any(Object), "/work/project", expect.objectContaining({ cliId: "claude" }));
    expect(injectProfile).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });

  it("passes the resume coordinate and capture hook exec to fleet-admiral injection", async () => {
    const runtime = createFakeRuntime(() => undefined);
    const injectedOptions: InjectAgentCliProfileOptions[] = [];
    const resolveProfile = vi.fn(async (env: NodeJS.ProcessEnv, cwd: string) => ({ ...baseProfile, id: "claude" as const, label: "Claude", cwd, env: { ...env } }));
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

    await resolve("/work/project", { sessionId: "fleet-session-a", cliId: "claude", resumeSessionId: "provider-session-a" });

    expect(resolveProfile).toHaveBeenCalledWith(expect.any(Object), "/work/project", expect.objectContaining({
      cliId: "claude",
      resumeSessionId: "provider-session-a",
    }));
    // 재개는 좌표로 넘어간다. 대역이 아니라 실제 주입이 읽는 필드여야 한다 — 예전 이름을
    // 그대로 두면 주입이 그것을 무시한 채 매번 새 세션을 열고, 대화가 조용히 끊긴다.
    expect(injectedOptions[0]?.origin).toEqual({ kind: "resume", sessionId: "provider-session-a" });
    expect(injectedOptions[0]?.captureSessionHookExec).toEqual({
      command: "/node",
      args: ["--import", pathToFileURL("/loader/tsx.mjs").href, "/console/cli.ts", "hook", "capture-session", "claude"],
    });
  });

  it("rejects a scoped gateway model that became stale before spawn", async () => {
    const root = makeTempDir("fleet-gateway-stale-model-");
    const resolve = createDefaultTerminalLaunchResolver({
      cwd: root,
      dataDir: root,
      env: {
        CLAUDE_BIN: process.execPath,
        CLAUDE_CONFIG_DIR: path.join(root, "claude-config"),
        PATH: process.env.PATH,
      },
      agentRuntime: createFakeRuntime() as never,
      aiGateway: {
        routePath: "/plugins/terminal/ai-gateway",
        origin: () => "http://127.0.0.1:43210",
      },
      infraServices: createFakeInfraServices() as never,
      injectProfile: (async (profile: AgentCliProfile) => profile) as never,
      createSessionIdentityResolver: (() => ({ resolve: async () => null })) as never,
      readAiGatewaySettings: () => ({ version: 1 }),
    });

    await expect(resolve(root, {
      cliId: "claude",
      model: "kimi--k3",
      sessionId: "gateway-stale-model",
    })).rejects.toMatchObject({
      name: "GatewayLaunchOptionError",
      code: "gateway_model_not_enabled",
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
    expect(spec.env).toMatchObject({ COLORTERM: "truecolor", TERM: "xterm-256color" });
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
