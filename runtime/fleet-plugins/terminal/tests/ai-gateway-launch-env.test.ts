import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyAiGatewayEnv } from "../server/agent-api/launch.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Claude gateway launch environment", () => {
  it("enables Claude Code ToolSearch for a gateway that preserves tool references", () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "fleet-ai-gateway-claude-"));
    temporaryDirectories.push(configDir);

    const profile = {
      id: "claude-gateway",
      label: "Claude Gateway",
      bin: "claude",
      args: [],
      cwd: "/workspace",
      env: { CLAUDE_CONFIG_DIR: configDir },
      terminalName: "xterm-256color",
    } as const;
    const configured = applyAiGatewayEnv(profile, {
      routePath: "/plugins/terminal/ai-gateway",
      origin: () => "http://127.0.0.1:4310",
    });

    expect(configured.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4310/plugins/terminal/ai-gateway",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      ENABLE_TOOL_SEARCH: "true",
    });
  });
});
