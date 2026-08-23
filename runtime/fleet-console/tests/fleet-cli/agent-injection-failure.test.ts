import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { injectAgentCliProfile, type AgentCliProfile } from "@dotobokuri/fleet-admiral";

const TEST_PROFILE: AgentCliProfile = {
  args: [],
  bin: "claude",
  cwd: process.cwd(),
  env: {},
  id: "claude",
  label: "Claude",
  terminalName: "xterm-256color",
};

describe("agent CLI injection failure cleanup", () => {
  it("releases the MCP token when plugin rendering fails", async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "fleet-agent-injection-"));
    // 공유 플러그인 부모 자리에 파일이 서 있으면 트리를 렌더할 수 없다.
    closeSync(openSync(path.join(dataDir, "harness"), "w"));
    const releaseSessionToken = vi.fn();

    try {
      await expect(injectAgentCliProfile(TEST_PROFILE, {
        dataDir,
        dedicatedMcpSession: {
          getEndpoint: async () => ({
            servers: [{ name: "fleet", url: "http://127.0.0.1:1000/fleet" }],
          }),
          issueSessionToken: () => [{ name: "fleet", token: "token" }],
          releaseSessionToken,
        } as never,
      })).rejects.toThrow();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }

    expect(releaseSessionToken).toHaveBeenCalledTimes(1);
    expect(releaseSessionToken.mock.calls[0]?.[0]).toMatch(/^agent:claude:[0-9a-f-]{36}$/);
  });
});
