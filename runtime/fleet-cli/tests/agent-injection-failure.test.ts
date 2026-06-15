import { closeSync, mkdtempSync, openSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { injectAgentCliProfile, type AgentCliProfile } from "@dotobokuri/fleet-admiral";
import { createCarrierRuntime } from "@dotobokuri/fleet-carriers";

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
    const invalidPluginRoot = path.join(codexHome, "not-a-directory");
    closeSync(openSync(invalidPluginRoot, "w"));
    const releaseSessionToken = vi.fn();

    try {
      await expect(injectAgentCliProfile({ ...TEST_PROFILE, env: { CODEX_HOME: codexHome } }, {
        buildSystemPrompt: () => "prompt",
        carrierRuntime: createCarrierRuntime(),
        codexCommandRunner: () => ({ status: 0, stderr: "", stdout: "" }),
        dataDir: codexHome,
        dedicatedMcpSession: {
          getEndpoint: async () => ({
            servers: [{ name: "fleet", url: "http://127.0.0.1:1000/fleet" }],
          }),
          issueSessionToken: () => [{ name: "fleet", token: "token" }],
          releaseSessionToken,
        } as never,
        pluginRootDir: invalidPluginRoot,
        withMarketplaceLock: (_target, fn) => fn(),
      })).rejects.toThrow();
      expect(readdirSync(codexHome).filter((entry) => /^fleet-.*\.config\.toml$/.test(entry))).toEqual([]);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }

    expect(releaseSessionToken).toHaveBeenCalledTimes(1);
    expect(releaseSessionToken.mock.calls[0]?.[0]).toMatch(/^agent:codex:[0-9a-f-]{36}$/);
  });
});
