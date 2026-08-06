import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyAiGatewayEnv } from "../server/agent-api/launch.js";
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
    const configured = applyAiGatewayEnv(profile, {
      routePath: "/plugins/terminal/ai-gateway",
      origin: () => "http://127.0.0.1:4310",
    });

    expect(configured.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4310/plugins/terminal/ai-gateway",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      ENABLE_TOOL_SEARCH: "true",
    });
    expect(configured.env).not.toHaveProperty("ANTHROPIC_MODEL");
  });

  it("starts the session on the configured gateway default model and narrows the cache", () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "fleet-ai-gateway-claude-"));
    temporaryDirectories.push(configDir);

    const selection = resolveAiGatewaySelection({
      version: 1,
      models: [
        { id: "cursor--claude-opus-5" },
        { id: "cursor--kimi-k3-1m" },
        { id: "kimi--k3-256k" },
      ],
      defaultModel: "cursor--claude-opus-5",
    });
    const configured = applyAiGatewayEnv({
      id: "claude-gateway",
      label: "Claude Gateway",
      bin: "claude",
      args: [],
      cwd: "/workspace",
      env: { CLAUDE_CONFIG_DIR: configDir },
      terminalName: "xterm-256color",
    } as const, {
      routePath: "/plugins/terminal/ai-gateway",
      origin: () => "http://127.0.0.1:4310",
    }, selection);

    expect(configured.env.ANTHROPIC_MODEL).toBe("claude-gateway--cursor--claude-opus-5[1m]");
    // effort는 Claude Code 소관이다 — launch env는 건드리지 않는다.
    expect(configured.env).not.toHaveProperty("CLAUDE_CODE_EFFORT_LEVEL");
    const cache = JSON.parse(readFileSync(path.join(configDir, "cache", "gateway-models.json"), "utf8")) as {
      readonly models: readonly { readonly id: string }[];
    };
    // Cursor 경유 Kimi와 Kimi 프로바이더 모델이 함께 남는다 — 이중 경로 동시 노출.
    expect(cache.models.map((model) => model.id)).toEqual([
      "claude-gateway--cursor--claude-opus-5[1m]",
      "claude-gateway--cursor--kimi-k3-1m[1m]",
      "claude-gateway--kimi--k3-256k",
    ]);
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
    applyAiGatewayEnv({
      id: "claude-gateway",
      label: "Claude Gateway",
      bin: "claude",
      args: [],
      cwd: "/workspace",
      env: { CLAUDE_CONFIG_DIR: configDir },
      terminalName: "xterm-256color",
    } as const, {
      routePath: "/plugins/terminal/ai-gateway",
      origin: () => "http://127.0.0.1:4310",
    }, selection);

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

    applyAiGatewayEnv({
      id: "claude-gateway",
      label: "Claude Gateway",
      bin: "claude",
      args: [],
      cwd: "/workspace",
      env: { CLAUDE_CONFIG_DIR: configDir },
      terminalName: "xterm-256color",
    } as const, {
      routePath: "/plugins/terminal/ai-gateway",
      origin: () => "http://127.0.0.1:4310",
    }, resolveAiGatewaySelection({ version: 1 }));

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
      defaultModel: "kimi--k3-256k",
    });
    const configured = applyAiGatewayEnv({
      id: "claude-gateway",
      label: "Claude Gateway",
      bin: "claude",
      args: [],
      cwd: "/workspace",
      env: { CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_MODEL: "claude-gateway--codex--gpt-5.6-sol[1m]" },
      terminalName: "xterm-256color",
    } as const, {
      routePath: "/plugins/terminal/ai-gateway",
      origin: () => "http://127.0.0.1:4310",
    }, selection);

    expect(configured.env.ANTHROPIC_MODEL).toBe("claude-gateway--codex--gpt-5.6-sol[1m]");
  });
});
