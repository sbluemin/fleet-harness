import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentTerminalLaunchResolver } from "../server/agent-api/launch.js";

const baseProfile = {
  id: "claude-native",
  label: "Claude",
  bin: "/bin/claude",
  args: ["--model", "sonnet"],
  cwd: "/work",
  env: { PATH: "/bin", TERM: "xterm-256color" },
  messagePolicy: { bracketedPaste: true, multilineStrategy: "paste-mode" },
  terminalName: "xterm-256color",
} as const;

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
      injectProfile: injectProfile as never,
      resolveProfile: resolveProfile as never,
    });

    await resolve("/work/project", {
      sessionId: "session-a",
      cliId: "claude-native",
      prompt: "ship the prompt threading",
    });

    expect(resolveProfile).toHaveBeenCalledWith(
      expect.any(Object),
      "/work/project",
      expect.objectContaining({
        cliId: "claude-native",
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
      injectProfile: injectProfile as never,
      resolveProfile: resolveProfile as never,
    });

    await resolve("/work/project", { sessionId: "session-a", cliId: "claude-native" });

    expect(resolveProfile).toHaveBeenCalledWith(
      expect.any(Object),
      "/work/project",
      expect.objectContaining({
        cliId: "claude-native",
        prompt: undefined,
      }),
    );
  });
});
