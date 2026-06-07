import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
  it("releases the MCP token when plugin rendering fails", async () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "fleet-codex-home-"));
    vi.resetModules();
    vi.doMock("../src/agent-cli/plugin/index.js", () => ({
      createAgentCliPlugin: () => {
        throw new Error("render failed");
      },
    }));
    const releaseSessionToken = vi.fn();
    const { injectAgentCliProfile } = await import("../src/agent-cli/injection.js");

    try {
      await expect(injectAgentCliProfile({ ...TEST_PROFILE, env: { CODEX_HOME: codexHome } }, {
        buildSystemPrompt: () => "prompt",
        carrierRuntime: createCarrierRuntime(),
        dedicatedMcpSession: {
          getEndpoint: async () => ({
            servers: [{ name: "fleet", url: "http://127.0.0.1:1000/fleet" }],
          }),
          issueSessionToken: () => [{ name: "fleet", token: "token" }],
          releaseSessionToken,
        } as never,
      })).rejects.toThrow(/render failed/);
      expect(readdirSync(codexHome).filter((entry) => /^fleet-.*\.config\.toml$/.test(entry))).toEqual([]);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }

    expect(releaseSessionToken).toHaveBeenCalledTimes(1);
    expect(releaseSessionToken.mock.calls[0]?.[0]).toMatch(/^agent:codex:[0-9a-f-]{36}$/);
  });
});
