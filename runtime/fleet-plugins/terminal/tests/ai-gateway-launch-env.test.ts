import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareAiGatewayLaunchProfile } from "@dotobokuri/fleet-admiral";
import { resolveAiGatewaySelection } from "@dotobokuri/core-ai-gateway";

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
    const configured = prepareAiGatewayLaunchProfile(profile, {
      baseUrl: "http://127.0.0.1:4310/plugins/terminal/ai-gateway",
    });

    expect(configured.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4310/plugins/terminal/ai-gateway",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      ENABLE_TOOL_SEARCH: "true",
    });
    expect(configured.env).not.toHaveProperty("ANTHROPIC_MODEL");
  });


  it("writes the discovery cache in provider clusters even when membership was interleaved", () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "fleet-ai-gateway-claude-"));
    temporaryDirectories.push(configDir);

    const selection = resolveAiGatewaySelection({
      version: 1,
      models: [
        { id: "cursor--grok-4.5-fast" },
        { id: "codex--gpt-5.6-sol-fast" },
        { id: "kimi--k3" },
        { id: "codex--gpt-5.6-luna-fast" },
      ],
    });
    prepareAiGatewayLaunchProfile({
      id: "claude-gateway",
      label: "Claude Gateway",
      bin: "claude",
      args: [],
      cwd: "/workspace",
      env: { CLAUDE_CONFIG_DIR: configDir },
      terminalName: "xterm-256color",
    } as const, {
      baseUrl: "http://127.0.0.1:4310/plugins/terminal/ai-gateway",
      selection,
    });

    const cache = JSON.parse(readFileSync(path.join(configDir, "cache", "gateway-models.json"), "utf8")) as {
      readonly models: readonly { readonly id: string }[];
    };
    expect(cache.models.map((model) => model.id)).toEqual([
      "claude-gateway--codex--gpt-5.6-sol-fast[1m]",
      "claude-gateway--codex--gpt-5.6-luna-fast[1m]",
      "claude-gateway--cursor--grok-4.5-fast[1m]",
      "claude-gateway--kimi--k3[1m]",
    ]);
  });

  it("writes an empty cache when the settings enable no models (opt-in)", () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "fleet-ai-gateway-claude-"));
    temporaryDirectories.push(configDir);

    prepareAiGatewayLaunchProfile({
      id: "claude-gateway",
      label: "Claude Gateway",
      bin: "claude",
      args: [],
      cwd: "/workspace",
      env: { CLAUDE_CONFIG_DIR: configDir },
      terminalName: "xterm-256color",
    } as const, {
      baseUrl: "http://127.0.0.1:4310/plugins/terminal/ai-gateway",
      selection: resolveAiGatewaySelection({ version: 1 }),
    });

    const cache = JSON.parse(readFileSync(path.join(configDir, "cache", "gateway-models.json"), "utf8")) as {
      readonly models: readonly { readonly id: string }[];
    };
    expect(cache.models).toHaveLength(0);
  });

  it("keeps a profile-provided ANTHROPIC_MODEL over the configured default", () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "fleet-ai-gateway-claude-"));
    temporaryDirectories.push(configDir);

    const selection = resolveAiGatewaySelection({
      version: 1,
      models: [{ id: "kimi--k3-256k" }],
    });
    const configured = prepareAiGatewayLaunchProfile({
      id: "claude-gateway",
      label: "Claude Gateway",
      bin: "claude",
      args: [],
      cwd: "/workspace",
      env: { CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_MODEL: "claude-gateway--codex--gpt-5.6-sol[1m]" },
      terminalName: "xterm-256color",
    } as const, {
      baseUrl: "http://127.0.0.1:4310/plugins/terminal/ai-gateway",
      selection,
    });

    expect(configured.env.ANTHROPIC_MODEL).toBe("claude-gateway--codex--gpt-5.6-sol[1m]");
  });
});
