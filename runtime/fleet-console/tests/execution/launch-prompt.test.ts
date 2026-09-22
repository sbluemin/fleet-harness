import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentTerminalLaunchResolver } from "../../features/execution/host/agent/launch.js";

const baseProfile = {
  id: "claude",
  label: "Claude",
  bin: "/bin/claude",
  args: ["--model", "sonnet"],
  cwd: "/work",
  env: { PATH: "/bin", TERM: "xterm-256color" },
  messagePolicy: { bracketedPaste: true, multilineStrategy: "paste-mode" },
  terminalName: "xterm-256color",
} as const;

const AI_GATEWAY_BINDING = {
  routePath: "/api/v1/ai-gateway",
  origin: () => "http://127.0.0.1:43210",
};

function createFakeRuntime() {
  return {
    carrierRuntime: {
      jobs: {
        streaming: {
          register() {
            return () => {};
          },
        },
      },
    },
    dedicatedMcpSession: {},
    mcpRegistry: {
      getAllAgentTools() {
        return [];
      },
    },
    cleanup: async () => {},
  };
}

/** 런치가 플러그인 트리를 렌더할 자리. 실제 렌더는 스텁이 가로채므로 값 자체는 쓰이지 않는다. */
const launchDataDir = "/tmp/fleet-console-test/console";
/** 기동에 렌더된 트리를 대신한다 — 런치는 경로만 읽는다. */
const launchPluginStub = { pluginRoot: `${launchDataDir}/harness/claude`, pluginRoots: [`${launchDataDir}/harness/claude`] };

describe("createAgentTerminalLaunchResolver launch environment", () => {
  it("advertises supported terminal capabilities without replacing the compatible TERM entry", async () => {
    const resolve = createAgentTerminalLaunchResolver({
      dataDir: launchDataDir,
      plugin: launchPluginStub,
      infraServices: { agentOptionsService: { load: () => ({}), update: (mutate) => mutate({}) } },
      cwd: "/work",
      env: {
        COLORTERM: "256color",
        CLAUDE_CODE_CHILD_SESSION: "1",
        FLEET_TERMINAL_CMD: "/bin/sh",
        PATH: "/bin",
      } as NodeJS.ProcessEnv,
      platform: "linux",
    });

    const spec = await resolve("/work/project", { sessionId: "session-a" });

    expect(spec.env).toMatchObject({
      COLORTERM: "truecolor",
      TERM: "xterm-256color",
    });
    expect(spec.env.FORCE_HYPERLINK).toBeUndefined();
    expect(spec.env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
  });
});

describe("createAgentTerminalLaunchResolver prompt threading", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards context.prompt into resolveProfile options", async () => {
    const resolveProfile = vi.fn(async (env: NodeJS.ProcessEnv, cwd: string) => ({
      ...baseProfile,
      cwd,
      env: { ...env },
    }));
    const injectProfile = vi.fn(async (profile) => profile);
    const resolve = createAgentTerminalLaunchResolver({
      dataDir: launchDataDir,
      plugin: launchPluginStub,
      infraServices: { agentOptionsService: { load: () => ({}), update: (mutate) => mutate({}) } },
      cwd: "/work",
      env: { PATH: "/bin" } as NodeJS.ProcessEnv,
      agentRuntime: createFakeRuntime() as never,
      aiGateway: AI_GATEWAY_BINDING,
      injectProfile: injectProfile as never,
      resolveProfile: resolveProfile as never,
    });

    await resolve("/work/project", {
      sessionId: "session-a",
      cliId: "claude",
      prompt: "ship the prompt threading",
    });

    expect(resolveProfile).toHaveBeenCalledWith(
      expect.objectContaining({ FORCE_HYPERLINK: "1" }),
      "/work/project",
      expect.objectContaining({
        cliId: "claude",
        prompt: "ship the prompt threading",
      }),
    );
  });

  it("passes prompt as undefined when context has no prompt", async () => {
    const resolveProfile = vi.fn(async (env: NodeJS.ProcessEnv, cwd: string) => ({
      ...baseProfile,
      cwd,
      env: { ...env },
    }));
    const injectProfile = vi.fn(async (profile) => profile);
    const resolve = createAgentTerminalLaunchResolver({
      dataDir: launchDataDir,
      plugin: launchPluginStub,
      infraServices: { agentOptionsService: { load: () => ({}), update: (mutate) => mutate({}) } },
      cwd: "/work",
      env: { PATH: "/bin", FORCE_HYPERLINK: "0" } as NodeJS.ProcessEnv,
      agentRuntime: createFakeRuntime() as never,
      aiGateway: AI_GATEWAY_BINDING,
      injectProfile: injectProfile as never,
      resolveProfile: resolveProfile as never,
    });

    await resolve("/work/project", { sessionId: "session-a", cliId: "claude" });

    expect(resolveProfile).toHaveBeenCalledWith(
      expect.objectContaining({ FORCE_HYPERLINK: "0" }),
      "/work/project",
      expect.objectContaining({
        cliId: "claude",
        prompt: undefined,
      }),
    );
  });
});
