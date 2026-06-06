import { describe, expect, it, vi } from "vitest";

import { createCarrierRuntime } from "@dotobokuri/fleet-carriers";
import type { AgentCliProfile } from "../src/agent-cli/types.js";

const TEST_PROFILE: AgentCliProfile = {
  args: [],
  bin: "codex",
  cwd: process.cwd(),
  env: {},
  id: "codex",
  label: "Codex",
  terminalName: "xterm-256color",
};

describe("agent CLI injection failure cleanup", () => {
  it("releases the MCP token when session plugin rendering fails", async () => {
    vi.resetModules();
    vi.doMock("../src/agent-cli/session-plugin/index.js", () => ({
      createAgentCliSessionPlugin: () => {
        throw new Error("render failed");
      },
    }));
    const releaseSessionToken = vi.fn();
    const { injectAgentCliProfile } = await import("../src/agent-cli/injection.js");

    await expect(injectAgentCliProfile(TEST_PROFILE, {
      buildSystemPrompt: () => "prompt",
      carrierRuntime: createCarrierRuntime(),
      dedicatedMcpSession: {
        getEndpoint: async () => ({
          servers: [{ name: "fleet-carriers", url: "http://127.0.0.1:1000/carriers" }],
        }),
        issueSessionToken: () => [{ name: "fleet-carriers", token: "token" }],
        releaseSessionToken,
      } as never,
    })).rejects.toThrow(/render failed/);

    expect(releaseSessionToken).toHaveBeenCalledTimes(1);
    expect(releaseSessionToken.mock.calls[0]?.[0]).toMatch(/^agent:codex:[0-9a-f-]{36}$/);
  });
});
