import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentTerminalLaunchResolver } from "../server/agent-api/launch.js";

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
  routePath: "/plugins/terminal/ai-gateway",
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

describe("createAgentTerminalLaunchResolver launch environment", () => {
  it("advertises truecolor without replacing the compatible TERM entry", async () => {
    const resolve = createAgentTerminalLaunchResolver({
      cwd: "/work",
      env: {
        COLORTERM: "256color",
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
      expect.any(Object),
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
      cwd: "/work",
      env: { PATH: "/bin" } as NodeJS.ProcessEnv,
      agentRuntime: createFakeRuntime() as never,
      aiGateway: AI_GATEWAY_BINDING,
      injectProfile: injectProfile as never,
      resolveProfile: resolveProfile as never,
    });

    await resolve("/work/project", { sessionId: "session-a", cliId: "claude" });

    expect(resolveProfile).toHaveBeenCalledWith(
      expect.any(Object),
      "/work/project",
      expect.objectContaining({
        cliId: "claude",
        prompt: undefined,
      }),
    );
  });
});
