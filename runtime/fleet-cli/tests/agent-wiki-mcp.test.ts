import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createSystemPromptBuilder } from "@dotobokuri/fleet-admiral";
import {
  buildClaudeSubagentDefinition,
  buildCodexSubagentDefinition,
  createCarrierRuntime,
  initStore,
  resetStoreForTests,
  setCarrierAgentMode,
  updateAgentCliTypeOverride,
  updateAgentCliSelection,
  type CarrierConfig,
} from "@dotobokuri/fleet-carriers";
import { buildClaudeNativeArgs } from "../src/agent-cli/builders/claude.js";
import { buildCodexNativeArgs } from "../src/agent-cli/builders/codex.js";
import { injectAgentCliProfile } from "../src/agent-cli/injection.js";
import type { AgentCliInjectionContext } from "../src/agent-cli/types.js";
import { createFleetRuntimeLifecycle, type FleetRuntimeLifecycle } from "../src/runtime/runtime.js";

interface McpToolListResponse {
  readonly result?: {
    readonly tools?: ReadonlyArray<{ readonly name?: string }>;
  };
}

const EXPECTED_WIKI_TOOL_IDS = [
  "wiki_briefing",
  "wiki_drydock",
  "wiki_ingest",
  "wiki_orient",
  "wiki_patch_edit",
  "wiki_patch_queue",
  "wiki_compile_source",
  "wiki_query",
  "wiki_read",
  "wiki_resolve",
] as const;

const EXPECTED_CARRIER_TOOL_IDS = [
  "carrier_dispatch",
  "carrier_jobs",
] as const;

describe("fleet-cli agent CLI MCP registration", () => {
  let lifecycle: FleetRuntimeLifecycle | undefined;

  afterEach(async () => {
    await lifecycle?.shutdown();
    lifecycle = undefined;
  });

  it("exposes carrier and wiki tools on separate dedicated MCP servers", async () => {
    lifecycle = createFleetRuntimeLifecycle();
    const runtime = await lifecycle.start();
    const endpoint = await runtime.dedicatedMcpSession.getEndpoint();
    const tokens = runtime.dedicatedMcpSession.issueSessionToken({
      label: "agent:test-wiki",
      cwd: process.cwd(),
    });
    const servers = endpoint.servers.map((server) => ({
      ...server,
      token: tokens.find((entry) => entry.name === server.name)?.token,
    }));
    const carriers = servers.find((server) => server.name === "fleet-carriers");
    const wiki = servers.find((server) => server.name === "fleet-wiki");

    expect(carriers?.token).toBeDefined();
    expect(wiki?.token).toBeDefined();
    expect(carriers?.token).not.toEqual(wiki?.token);

    const carrierToolNames = await listMcpTools(carriers!.url, carriers!.token!);
    const wikiToolNames = await listMcpTools(wiki!.url, wiki!.token!);

    expect([...carrierToolNames].sort()).toEqual([...EXPECTED_CARRIER_TOOL_IDS].sort());

    for (const toolId of EXPECTED_WIKI_TOOL_IDS) {
      expect(wikiToolNames.has(toolId)).toBe(true);
    }
    expect(wikiToolNames.size).toBe(EXPECTED_WIKI_TOOL_IDS.length);
    expect(carrierToolNames.has("wiki_briefing")).toBe(false);
    expect(wikiToolNames.has("carrier_dispatch")).toBe(false);
    expect(wikiToolNames.has("carrier_jobs")).toBe(false);

    const systemPrompt = createSystemPromptBuilder({
      carrierRuntime: runtime.carrierRuntime,
      mcpRegistry: runtime.mcpRegistry,
    }).build(false);
    expect(systemPrompt).toContain('<fleet section="tool-guide" tool="carrier_dispatch">');
    expect(systemPrompt).toContain('<fleet section="tool-guide" tool="wiki_query">');
  });

  it("builds Claude and Codex configs with only the split internal MCP server names", () => {
    const context = makeAgentCliInjectionContext();

    const claudeArgs = buildClaudeNativeArgs(context);
    const mcpConfigIndex = claudeArgs.indexOf("--mcp-config") + 1;
    const claudeConfig = JSON.parse(claudeArgs[mcpConfigIndex]!) as {
      mcpServers: Record<string, { headers?: { Authorization?: string } }>;
    };
    expect(Object.keys(claudeConfig.mcpServers).sort()).toEqual(["fleet-carriers", "fleet-wiki"]);
    expect(claudeConfig.mcpServers["fleet-carriers"]?.headers?.Authorization).toBe("Bearer carriers-token");
    expect(claudeConfig.mcpServers["fleet-wiki"]?.headers?.Authorization).toBe("Bearer wiki-token");

    const codexArgs = buildCodexNativeArgs(context);
    const codexConfigArgs = codexArgs.filter((arg) => arg !== "-c");
    expect(codexConfigArgs.some((arg) => arg.includes("mcp_servers.fleet-tools"))).toBe(false);
    expect(codexConfigArgs).toContain('mcp_servers.fleet-carriers.url="http://127.0.0.1:1000/carriers"');
    expect(codexConfigArgs).toContain('mcp_servers.fleet-wiki.url="http://127.0.0.1:1001/wiki"');
  });

  it("writes injected system prompt files private and registers cleanup", async () => {
    const cleanups: Array<() => void> = [];
    const profile = await injectAgentCliProfile({
      args: [],
      bin: "claude",
      cwd: process.cwd(),
      env: {},
      id: "claude",
      label: "Claude",
      terminalName: "claude",
    }, {
      buildSystemPrompt: () => "private fleet prompt",
      carrierRuntime: createCarrierRuntime(),
      dedicatedMcpSession: {
        getEndpoint: async () => ({
          servers: [{ name: "fleet-carriers", url: "http://127.0.0.1:1000/carriers" }],
        }),
        issueSessionToken: () => [{ name: "fleet-carriers", token: "carriers-token" }],
      } as never,
      onCleanup: (cleanup) => cleanups.push(cleanup),
    });
    const systemPromptFile = profile.args[profile.args.indexOf("--system-prompt-file") + 1]!;

    expect(readFileSync(systemPromptFile, "utf8")).toBe("private fleet prompt");
    expect(statSync(systemPromptFile).mode & 0o777).toBe(0o600);
    expect(systemPromptFile).not.toBe(path.join(os.tmpdir(), "fleet-claude-system-prompt.md"));
    expect(path.basename(systemPromptFile)).toBe("system-prompt.md");
    expect(path.dirname(systemPromptFile)).toContain(path.join(os.tmpdir(), "fleet-claude-"));

    cleanups.forEach((cleanup) => cleanup());

    expect(existsSync(systemPromptFile)).toBe(false);
  });

  it("passes current effective Codex model settings into startup native roles", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "fleet-codex-startup-"));
    initStore(tempDir);
    try {
      const runtime = createCarrierRuntime();
      runtime.registerCarrierDefaults();
      updateAgentCliTypeOverride("ohio", "codex", "claude");
      await updateAgentCliSelection("ohio", "codex", { model: "gpt-5.4", effort: "high" });
      setCarrierAgentMode("ohio", true);

      await injectAgentCliProfile({
        args: [],
        bin: "codex",
        cwd: process.cwd(),
        env: {},
        id: "codex",
        label: "Codex",
        terminalName: "codex",
      }, {
        buildSystemPrompt: () => "fleet prompt",
        carrierRuntime: runtime,
        dedicatedMcpSession: {
          getEndpoint: async () => ({
            servers: [{ name: "fleet-carriers", url: "http://127.0.0.1:1000/carriers" }],
          }),
          issueSessionToken: () => [{ name: "fleet-carriers", token: "carriers-token" }],
        } as never,
      });

      const roleToml = readFileSync(path.join(tempDir, "codex-agents/ohio.toml"), "utf8");
      expect(roleToml).toContain('model = "gpt-5.4"');
      expect(roleToml).toContain('model_reasoning_effort = "high"');
    } finally {
      resetStoreForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("heals startup Codex roles from codex persona defaults when no codex model is stored", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "fleet-codex-default-startup-"));
    initStore(tempDir);
    try {
      const runtime = createCarrierRuntime();
      runtime.registerCarrierDefaults();
      updateAgentCliTypeOverride("vanguard", "codex", "claude");

      await injectAgentCliProfile({
        args: [],
        bin: "codex",
        cwd: process.cwd(),
        env: {},
        id: "codex",
        label: "Codex",
        terminalName: "codex",
      }, {
        buildSystemPrompt: () => "fleet prompt",
        carrierRuntime: runtime,
        dedicatedMcpSession: {
          getEndpoint: async () => ({
            servers: [{ name: "fleet-carriers", url: "http://127.0.0.1:1000/carriers" }],
          }),
          issueSessionToken: () => [{ name: "fleet-carriers", token: "carriers-token" }],
        } as never,
      });

      const roleToml = readFileSync(path.join(tempDir, "codex-agents/vanguard.toml"), "utf8");
      expect(roleToml).toContain('model = "gpt-5.4-mini"');
      expect(roleToml).toContain('model_reasoning_effort = "low"');
    } finally {
      resetStoreForTests();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("serializes inline Claude subagent model and effort in the Claude --agents JSON payload", () => {
    const context = {
      ...makeAgentCliInjectionContext(),
      claudeSubagents: [
        {
          carrierId: "ohio",
          color: "yellow" as const,
          description: "Ohio native subagent",
          effort: "low",
          model: "sonnet",
          name: "Ohio",
          prompt: "system prompt",
        },
      ],
    };

    const claudeArgs = buildClaudeNativeArgs(context);
    // 이 검증은 builder의 argv/JSON 직렬화 범위만 다룹니다.
    // 실제 Claude CLI의 per-agent effort 수용성은 별도 수동 또는 smoke 검증이 필요합니다.
    expect(claudeArgs.filter((arg) => arg === "--agents")).toHaveLength(1);
    expect(JSON.parse(claudeArgs[claudeArgs.indexOf("--agents") + 1]!)).toEqual({
      "Ohio": {
        background: true,
        color: "yellow",
        description: "Ohio native subagent",
        effort: "low",
        model: "sonnet",
        prompt: "system prompt",
      },
    });
    expect(buildCodexNativeArgs(context)).not.toContain("--agents");
  });

  it("serializes Codex native roles as agents config_file overrides", () => {
    const context = {
      ...makeAgentCliInjectionContext(),
      codexSubagents: [
        {
          definition: buildCodexSubagentDefinition(createTestCarrierConfig("ohio")),
          configFile: "/tmp/fleet-data/codex-agents/ohio.toml",
        },
      ],
    };

    const codexArgs = buildCodexNativeArgs(context);
    const codexConfigArgs = codexArgs.filter((arg) => arg !== "-c");

    expect(codexConfigArgs.some((arg) => arg.startsWith("agents.ohio.description="))).toBe(true);
    expect(codexConfigArgs).toContain('agents.ohio.config_file="/tmp/fleet-data/codex-agents/ohio.toml"');
    expect(codexConfigArgs.some((arg) => arg.includes("developer_instructions"))).toBe(false);
    expect(codexConfigArgs.some((arg) => arg.includes("model_reasoning_effort"))).toBe(false);
  });

  it("keeps malicious Claude subagent metadata inside one parseable --agents argv", () => {
    const maliciousFixture = {
      displayName: 'Display "Name"\n--display-flag $() </fleet>',
      prompt: 'Prompt "body"\n--prompt-flag $(touch sentinel) </fleet>',
      summary: 'Summary "line"\n--summary-flag $() </fleet>',
      title: 'Title "role"\n--title-flag $() </fleet>',
    };
    const definition = buildClaudeSubagentDefinition(makeMaliciousCarrierConfig(maliciousFixture));
    const context = {
      ...makeAgentCliInjectionContext(),
      claudeSubagents: [definition],
    };

    const claudeArgs = buildClaudeNativeArgs(context);
    const agentsIndex = claudeArgs.indexOf("--agents");
    const payloadArg = claudeArgs[agentsIndex + 1]!;
    const parsedPayload = JSON.parse(payloadArg) as Record<string, unknown>;

    expect(claudeArgs).toHaveLength(7);
    expect(claudeArgs.filter((arg) => arg === "--agents")).toHaveLength(1);
    expect(claudeArgs.filter((arg) => arg === "--display-flag")).toHaveLength(0);
    expect(claudeArgs.filter((arg) => arg === "--prompt-flag")).toHaveLength(0);
    expect(parsedPayload).toEqual({
      [definition.name]: {
        background: true,
        description: definition.description,
        prompt: definition.prompt,
      },
    });
    expect(definition.description).toContain('--display-flag $() </fleet>');
    expect(definition.description).toContain('--title-flag $() </fleet>');
    expect(definition.description).toContain('--summary-flag $() </fleet>');
    expect(definition.prompt).toContain(maliciousFixture.prompt);
  });

});

async function listMcpTools(url: string, token: string): Promise<Set<string>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    }),
  });
  const body = await response.json() as McpToolListResponse;
  return new Set(body.result?.tools?.map((tool) => tool.name).filter((name): name is string => Boolean(name)));
}

function makeAgentCliInjectionContext(): AgentCliInjectionContext {
  return {
    cliId: "codex",
    mcpServers: [
      {
        name: "fleet-carriers",
        endpointUrl: "http://127.0.0.1:1000/carriers",
        bearerToken: "carriers-token",
      },
      {
        name: "fleet-wiki",
        endpointUrl: "http://127.0.0.1:1001/wiki",
        bearerToken: "wiki-token",
      },
    ],
    replaceSystemPrompt: true,
    systemPromptFile: "/tmp/fleet-system-prompt.md",
  };
}

function makeMaliciousCarrierConfig(fixture: {
  readonly displayName: string;
  readonly prompt: string;
  readonly summary: string;
  readonly title: string;
}): CarrierConfig {
  return {
    id: 'malicious-"carrier"',
    defaultCliType: "claude",
    slot: 1,
    displayName: fixture.displayName,
    color: "",
    carrierMetadata: {
      title: fixture.title,
      summary: fixture.summary,
      category: "operations",
      whenToUse: [],
      whenNotToUse: [],
      requestBlocks: [],
      permissions: [],
      outputFormat: fixture.prompt,
    },
  };
}

function createTestCarrierConfig(id: string): CarrierConfig {
  return {
    carrierMetadata: {
      category: "operations",
      outputFormat: "Report completion.",
      permissions: ["Execute only the assigned wave."],
      principles: ["Follow the plan."],
      requestBlocks: [],
      summary: "Multi-wave execution",
      title: "Captain",
      whenNotToUse: [],
      whenToUse: ["plan-file execution"],
    },
    color: "",
    defaultCliType: "claude",
    displayName: id[0]!.toUpperCase() + id.slice(1),
    id,
    slot: 1,
    subagent: {
      byHost: {
        codex: { defaultModel: "gpt-5.5", defaultEffort: "low" },
      },
    },
  };
}
