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
  id: "claude-gateway",
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
  readonly claudeGatewaySystemPromptMode?: "append" | "replace" | "off";
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
    expect(resolveProfile).toHaveBeenCalledWith(expect.any(Object), "/work/project", expect.objectContaining({ cliId: "claude-gateway" }));
    expect(injectProfile).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });

  it("passes resumeSessionId and capture hook exec to fleet-admiral injection", async () => {
    const runtime = createFakeRuntime(() => undefined);
    const injectedOptions: InjectAgentCliProfileOptions[] = [];
    const resolveProfile = vi.fn(async (env: NodeJS.ProcessEnv, cwd: string) => ({ ...baseProfile, id: "claude-gateway" as const, label: "Claude", cwd, env: { ...env } }));
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

    await resolve("/work/project", { sessionId: "fleet-session-a", cliId: "claude-gateway", resumeSessionId: "provider-session-a" });

    expect(resolveProfile).toHaveBeenCalledWith(expect.any(Object), "/work/project", expect.objectContaining({
      cliId: "claude-gateway",
      resumeSessionId: "provider-session-a",
    }));
    expect(injectedOptions[0]).toMatchObject({ resumeSessionId: "provider-session-a" });
    expect(injectedOptions[0]?.captureSessionHookExec).toEqual({
      command: "/node",
      args: ["--import", pathToFileURL("/loader/tsx.mjs").href, "/console/cli.ts", "hook", "capture-session", "claude"],
    });
  });

  it("passes a selected Agent CLI id to fleet-admiral profile resolution", async () => {
    const runtime = createFakeRuntime(() => undefined);
    const resolveProfile = vi.fn(async (env: NodeJS.ProcessEnv, cwd: string) => ({ ...baseProfile, id: "claude-gateway" as const, label: "Claude", cwd, env: { ...env } }));
    const injectProfile = vi.fn(async (profile) => profile);
    const resolve = createDefaultTerminalLaunchResolver({
      cwd: "/work",
      env: { PATH: "/bin" } as NodeJS.ProcessEnv,
      agentRuntime: runtime as never,
      injectProfile: injectProfile as never,
      resolveProfile: resolveProfile as never,
    });

    await resolve("/work/project", { sessionId: "session-a", cliId: "claude-gateway" });

    expect(resolveProfile).toHaveBeenCalledWith(expect.any(Object), "/work/project", expect.objectContaining({ cliId: "claude-gateway" }));
  });


  it("launches gateway variants with built-in model aliases or converted scoped model ids", async () => {
    const root = makeTempDir("fleet-gateway-launch-variant-");
    const settings = {
      version: 1 as const,
      models: [{ id: "cursor--grok-4.5" }],
    };
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
      readAiGatewaySettings: () => settings,
    });

    const native = await resolve(root, {
      cliId: "claude-gateway",
      model: "fable",
      effort: "max",
      sessionId: "gateway-native-variant",
    });
    const scoped = await resolve(root, {
      cliId: "claude-gateway",
      model: "cursor--grok-4.5",
      effort: "high",
      sessionId: "gateway-scoped-variant",
    });
    const rowOnly = await resolve(root, {
      cliId: "claude-gateway",
      model: "cursor--grok-4.5",
      sessionId: "gateway-scoped-row",
    });

    expect(native.args).toEqual(["--model", "fable[1m]", "--effort", "max"]);
    expect(scoped.args).toEqual([
      "--model",
      "claude-gateway--cursor--grok-4.5",
      "--effort",
      "high",
    ]);
    expect(rowOnly.args).toEqual([
      "--model",
      "claude-gateway--cursor--grok-4.5",
    ]);
    expect(rowOnly.args).not.toContain("--effort");
    for (const spec of [native, scoped, rowOnly]) {
      // 세션 기본 모델 축이 없으므로 launch env는 ANTHROPIC_MODEL을 주입하지 않는다.
      // 모델 선택은 CLI args(--model)가 담당한다.
      expect(spec.env.ANTHROPIC_MODEL).toBeUndefined();
      expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
      await spec.cleanup?.();
    }
  });

  it("launches a host-only gateway model while withholding it from the delegation identities", async () => {
    // 이 두 철자가 갈라지는 유일한 자리다. 같은 selection에서 실행 경로는 models를,
    // 정체성 렌더는 delegationModels를 받는다 — 한쪽만 되돌려도 여기서만 드러난다.
    const root = makeTempDir("fleet-gateway-host-only-");
    const settings = {
      version: 1 as const,
      models: [
        { id: "cursor--auto", hostOnly: true },
        { id: "cursor--grok-4.5" },
      ],
    };
    let injected: InjectAgentCliProfileOptions | undefined;
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
      injectProfile: (async (profile: AgentCliProfile, options: InjectAgentCliProfileOptions) => {
        injected = options;
        return profile;
      }) as never,
      createSessionIdentityResolver: (() => ({ resolve: async () => null })) as never,
      readAiGatewaySettings: () => settings,
    });

    const spec = await resolve(root, {
      cliId: "claude-gateway",
      model: "cursor--auto",
      sessionId: "gateway-host-only",
    });

    // 호스트 세션 쪽: 여전히 고를 수 있고, --model args로 배선된다.
    expect(spec.args).toEqual(["--model", "claude-gateway--cursor--auto"]);
    expect(spec.env.ANTHROPIC_MODEL).toBeUndefined();
    // 위임 쪽: 정체성을 만들 목록에서만 빠진다.
    const delegable = (injected?.gatewayDelegationModels ?? []).map((model) => model.id);
    expect(delegable).toEqual(["cursor--grok-4.5"]);
    await spec.cleanup?.();
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
      cliId: "claude-gateway",
      model: "kimi--k3",
      sessionId: "gateway-stale-model",
    })).rejects.toMatchObject({
      name: "GatewayLaunchOptionError",
      code: "gateway_model_not_enabled",
    });
  });

  it("rejects a scoped gateway effort that became stale before spawn", async () => {
    const root = makeTempDir("fleet-gateway-stale-effort-");
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
      readAiGatewaySettings: () => ({
        version: 1,
        models: [{ id: "kimi--k3", efforts: ["max"] }],
      }),
    });

    await expect(resolve(root, {
      cliId: "claude-gateway",
      model: "kimi--k3",
      effort: "high",
      sessionId: "gateway-stale-effort",
    })).rejects.toMatchObject({
      name: "GatewayLaunchOptionError",
      code: "invalid_effort",
    });
  });

  it("launches claude-gateway through the real shared Admiral package", async () => {
    const root = makeTempDir("fleet-gateway-admiral-integration-");
    const releasedLabels: string[] = [];
    const resolve = createDefaultTerminalLaunchResolver({
      agentRuntime: {
        dedicatedMcpSession: {
          async getEndpoint() {
            return { servers: [{ name: "fleet", url: "http://127.0.0.1:48123/mcp" }] };
          },
          issueSessionToken() {
            return [{ name: "fleet", token: "gateway-token" }];
          },
          releaseSessionToken(label: string) {
            releasedLabels.push(label);
          },
        },
        mcpRegistry: { getAllAgentTools: () => [] },
        async cleanup() {},
      } as never,
      aiGateway: {
        routePath: "/plugins/terminal/ai-gateway",
        origin: () => "http://127.0.0.1:43210",
      },
      createSessionIdentityResolver: (() => ({ resolve: async () => null })) as never,
      cwd: root,
      dataDir: root,
      entryPath: "/console/cli.mjs",
      env: {
        CLAUDE_BIN: process.execPath,
        CLAUDE_CONFIG_DIR: path.join(root, "claude-config"),
        PATH: process.env.PATH,
      },
      execPath: process.execPath,
      infraServices: createFakeInfraServices() as never,
    });

    const spec = await resolve(root, {
      cliId: "claude-gateway",
      sessionId: "gateway-integration",
    });
    const pluginRoot = spec.args[spec.args.indexOf("--plugin-dir") + 1];
    const promptPath = spec.args[spec.args.indexOf("--append-system-prompt-file") + 1];

    expect(spec.bin).toBe(process.execPath);
    expect(spec.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:43210/plugins/terminal/ai-gateway");
    expect(pluginRoot).toBe(path.join(root, "marketplace", "plugins", "fleet-gateway"));
    expect(existsSync(path.join(pluginRoot!, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(path.join(pluginRoot!, ".codex-plugin", "plugin.json"))).toBe(false);
    expect(existsSync(promptPath!)).toBe(true);

    await spec.cleanup?.();
    expect(existsSync(promptPath!)).toBe(false);
    expect(releasedLabels).toEqual(["gateway-integration"]);
  });

  it("replaces the Claude Code system prompt only for new AI Gateway launches when enabled", async () => {
    const root = makeTempDir();
    const resolve = createDefaultTerminalLaunchResolver({
      agentRuntime: {
        carrierRuntime: { jobs: { streaming: { register: () => () => {} } } },
        dedicatedMcpSession: {
          async getEndpoint() {
            return { servers: [{ name: "fleet", url: "http://127.0.0.1:9000/mcp" }] };
          },
          issueSessionToken() {
            return [{ name: "fleet", token: "gateway-token" }];
          },
          releaseSessionToken() {},
        },
        mcpRegistry: { getAllAgentTools: () => [] },
        async cleanup() {},
      } as never,
      aiGateway: {
        routePath: "/plugins/terminal/ai-gateway",
        origin: () => "http://127.0.0.1:43210",
      },
      createSessionIdentityResolver: (() => ({ resolve: async () => null })) as never,
      cwd: root,
      dataDir: root,
      entryPath: "/console/cli.mjs",
      env: {
        CLAUDE_BIN: process.execPath,
        CLAUDE_CONFIG_DIR: path.join(root, "claude-config"),
        PATH: process.env.PATH,
      },
      execPath: process.execPath,
      infraServices: createFakeInfraServices({ claudeGatewaySystemPromptMode: "replace" }) as never,
    });

    const spec = await resolve(root, {
      cliId: "claude-gateway",
      sessionId: "gateway-replace",
    });

    expect(spec.args).toContain("--system-prompt-file");
    expect(spec.args).not.toContain("--append-system-prompt-file");
    await spec.cleanup?.();
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
    const customShim = touch(path.join(binDir, "custom-agent.cmd"));
    const comSpec = "C:\\Windows\\System32\\cmd.exe";
    const resolveProfile = vi.fn();
    const resolve = createDefaultTerminalLaunchResolver({
      cwd: "/work",
      env: {
        ComSpec: comSpec,
        FLEET_TERMINAL_CMD: "custom-agent --resume",
        PATH: binDir,
        PATHEXT: ".cmd",
      } as NodeJS.ProcessEnv,
      platform: "win32",
      resolveProfile: resolveProfile as never,
    });

    const spec = await resolve("/work");

    expect(spec.bin).toBe(comSpec);
    expect(spec.args).toEqual(["/d", "/s", "/c", "call", `${customShim} `, "--resume"]);
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
      resolveProfile: (async () => ({ ...baseProfile, id: "claude", bin: "/custom/claude-wrapper", binPrefixArgs: ["--wrapper-prefix"] })) as never,
      createSessionIdentityResolver: createResolver as never,
    });

    const spec = await resolve("/work", { sessionId: "session-a", cliId: "claude-gateway" });

    expect(spec.sessionIdentityResolver).toMatchObject({ resolve: expect.any(Function) });
    // resolver는 세션 기록을 읽을 뿐이라 프로필에서 필요한 것은 그 기록이 놓인 cwd 하나다.
    // 예전에는 provider와 spawn 명령까지 받았지만, 띄우는 CLI가 claude 하나로 좁혀지며 사라졌다.
    expect(createResolver).toHaveBeenCalledWith({ cwd: "/work" });
  });

  it("binds a session identity resolver for the Claude gateway profile too", async () => {
    const claudeConfigDir = makeTempDir("fleet-gateway-identity-");
    const createResolver = vi.fn(() => ({ resolve: async () => null }));
    const resolve = createDefaultTerminalLaunchResolver({
      cwd: "/work",
      env: { CLAUDE_CONFIG_DIR: claudeConfigDir, PATH: "/bin" } as NodeJS.ProcessEnv,
      agentRuntime: createFakeRuntime() as never,
      aiGateway: {
        routePath: "/plugins/terminal/ai-gateway",
        origin: () => "http://127.0.0.1:43210",
      },
      infraServices: createFakeInfraServices() as never,
      injectProfile: (async (profile: AgentCliProfile) => profile) as never,
      resolveProfile: (async () => ({ ...baseProfile, id: "claude-gateway", label: "Claude (Gateway)" })) as never,
      createSessionIdentityResolver: createResolver as never,
    });

    await resolve("/work", { sessionId: "session-a", cliId: "claude-gateway" });

    expect(createResolver).toHaveBeenCalledWith({ cwd: "/work" });
  });

  it("prewrites the complete Claude Code gateway model cache before launch", async () => {
    const claudeConfigDir = makeTempDir("fleet-claude-gateway-");
    const resolve = createDefaultTerminalLaunchResolver({
      cwd: "/work",
      env: { CLAUDE_CONFIG_DIR: claudeConfigDir, PATH: "/bin" } as NodeJS.ProcessEnv,
      agentRuntime: createFakeRuntime() as never,
      aiGateway: {
        routePath: "/plugins/terminal/ai-gateway",
        origin: () => "http://127.0.0.1:43210",
      },
      infraServices: createFakeInfraServices() as never,
      injectProfile: (async (profile: AgentCliProfile) => profile) as never,
      resolveProfile: (async (env: NodeJS.ProcessEnv, cwd: string) => ({
        ...baseProfile,
        id: "claude-gateway",
        label: "Claude (Gateway)",
        cwd,
        env: { ...env },
      })) as never,
    });

    const spec = await resolve("/work", { sessionId: "session-gateway", cliId: "claude-gateway" });
    const cache = JSON.parse(readFileSync(path.join(claudeConfigDir, "cache", "gateway-models.json"), "utf8")) as {
      readonly baseUrl: string;
      readonly fetchedAt: number;
      readonly models: ReadonlyArray<{ readonly id: string; readonly display_name: string }>;
    };
    const ids = cache.models.map((model) => model.id);

    expect(spec.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:43210/plugins/terminal/ai-gateway");
    expect(spec.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000");
    expect(cache.baseUrl).toBe(spec.env.ANTHROPIC_BASE_URL);
    expect(cache.fetchedAt).toEqual(expect.any(Number));
    // core-ai-gateway의 GATEWAY_MODELS 전량이 prewrite되어야 한다 — 카탈로그가 바뀌면 이 수도 함께 맞춘다.
    expect(cache.models).toHaveLength(27);
    expect(ids).toContain("claude-gateway--codex--gpt-5.6-sol-fast");
    expect(ids).toContain("claude-gateway--cursor--auto");
    expect(ids).toContain("claude-gateway--cursor--composer-2.5");
    expect(ids).toContain("claude-gateway--cursor--grok-4.5");
    expect(ids).toContain("claude-gateway--cursor--grok-4.5-fast");
    expect(ids).toContain("claude-gateway--cursor--grok-4.6");
    expect(ids).toContain("claude-gateway--cursor--grok-4.6-fast");
    expect(ids).not.toContain("claude-gateway--cursor--claude-opus-5-1m[1m]");
    expect(ids).not.toContain("claude-gateway--cursor--kimi-k3");
    expect(ids).not.toContain("claude-gateway--cursor--gpt-5.6-luna[1m]");
    expect(ids).toContain("claude-gateway--kimi--k3[1m]");
    expect(ids).toContain("claude-gateway--kimi--k3-256k");
    expect(ids.some((id) => id.includes("--codex--") && id.endsWith("[1m]"))).toBe(false);
    expect(cache.models).toContainEqual(expect.objectContaining({
      id: "claude-gateway--cursor--grok-4.5",
      display_name: "Cursor-Grok-4.5",
    }));
    expect(cache.models).toContainEqual(expect.objectContaining({
      id: "claude-gateway--kimi--k3[1m]",
      display_name: "Moonshot-Kimi-K3-1M (1M Context)",
    }));
    expect(cache.models.every((model) => model.id.startsWith("claude"))).toBe(true);
    expect(cache.models.every((model) => /^(Codex|Cursor|Moonshot-Kimi|OpenCode|Grok)-/.test(model.display_name))).toBe(true);
  });

  it("preserves an explicit Claude Code auto-compact window for gateway launches", async () => {
    const claudeConfigDir = makeTempDir("fleet-claude-gateway-");
    const resolve = createDefaultTerminalLaunchResolver({
      cwd: "/work",
      env: {
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: "850000",
        PATH: "/bin",
      } as NodeJS.ProcessEnv,
      agentRuntime: createFakeRuntime() as never,
      aiGateway: {
        routePath: "/plugins/terminal/ai-gateway",
        origin: () => "http://127.0.0.1:43210",
      },
      infraServices: createFakeInfraServices() as never,
      injectProfile: (async (profile: AgentCliProfile) => profile) as never,
      resolveProfile: (async (env: NodeJS.ProcessEnv, cwd: string) => ({
        ...baseProfile,
        id: "claude-gateway",
        label: "Claude (Gateway)",
        cwd,
        env: { ...env },
      })) as never,
    });

    const spec = await resolve("/work", { sessionId: "session-gateway", cliId: "claude-gateway" });

    expect(spec.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("850000");
  });

  it("does not bind an identity resolver for an explicit shell override", async () => {
    const resolve = createDefaultTerminalLaunchResolver({
      cwd: "/work",
      env: { FLEET_TERMINAL_CMD: "bash -l" } as NodeJS.ProcessEnv,
      platform: "linux",
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
