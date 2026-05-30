import { afterEach, describe, expect, it } from "vitest";

import { createSystemPromptBuilder } from "@dotobokuri/fleet-admiral";
import { buildClaudeSubagentDefinition, type CarrierConfig } from "@dotobokuri/fleet-carriers";
import { buildClaudeNativeArgs } from "../src/agent-cli/builders/claude.js";
import { buildCodexNativeArgs } from "../src/agent-cli/builders/codex.js";
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

  it("adds inline Claude subagents only to the Claude native builder", () => {
    const context = {
      ...makeAgentCliInjectionContext(),
      claudeSubagents: [
        {
          carrierId: "ohio",
          description: "Ohio native subagent",
          name: "Ohio",
          prompt: "system prompt",
        },
      ],
    };

    const claudeArgs = buildClaudeNativeArgs(context);
    expect(claudeArgs.filter((arg) => arg === "--agents")).toHaveLength(1);
    expect(JSON.parse(claudeArgs[claudeArgs.indexOf("--agents") + 1]!)).toEqual({
      "Ohio": {
        description: "Ohio native subagent",
        prompt: "system prompt",
      },
    });
    expect(buildCodexNativeArgs(context)).not.toContain("--agents");
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
        description: definition.description,
        prompt: definition.prompt,
      },
    });
    expect(definition.description).toContain('--display-flag $() </fleet>');
    expect(definition.description).toContain('--title-flag $() </fleet>');
    expect(definition.description).toContain('--summary-flag $() </fleet>');
    expect(definition.prompt).toContain(maliciousFixture.prompt);
  });

  it("keeps native subagent carriers out of the carrier_dispatch roster section", async () => {
    lifecycle = createFleetRuntimeLifecycle();
    const runtime = await lifecycle.start();
    const systemPrompt = createSystemPromptBuilder({
      carrierRuntime: runtime.carrierRuntime,
      mcpRegistry: runtime.mcpRegistry,
    }).build(false, [{
      carrierId: "ohio",
      description: "Ohio native subagent",
      name: "Ohio",
      prompt: "system prompt",
    }]);

    expect(extractFleetSection(systemPrompt, "roster")).not.toContain("**ohio**");
    expect(extractFleetSection(systemPrompt, "roster")).not.toContain('carrier_id: "ohio"');
    expect(extractFleetSection(systemPrompt, "subagents")).toContain("- ohio: invoke as `Ohio`");
  });

  it("renders original carrier ids separately from slugged native subagent invocation names", async () => {
    lifecycle = createFleetRuntimeLifecycle();
    const runtime = await lifecycle.start();
    const systemPrompt = createSystemPromptBuilder({
      carrierRuntime: runtime.carrierRuntime,
      mcpRegistry: runtime.mcpRegistry,
    }).build(false, [{
      carrierId: "foo_bar",
      description: "Slugged native subagent",
      name: "FooBar",
      prompt: "system prompt",
    }]);
    const subagentsSection = extractFleetSection(systemPrompt, "subagents");

    expect(subagentsSection).toContain("- foo_bar: invoke as `FooBar`");
    expect(subagentsSection).not.toContain("- FooBar: invoke as `FooBar`");
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

function extractFleetSection(systemPrompt: string, section: string): string {
  const pattern = new RegExp(`<fleet section="${section}">\\n([\\s\\S]*?)\\n</fleet>`);
  return pattern.exec(systemPrompt)?.[1] ?? "";
}

function makeMaliciousCarrierConfig(fixture: {
  readonly displayName: string;
  readonly prompt: string;
  readonly summary: string;
  readonly title: string;
}): CarrierConfig {
  return {
    id: 'malicious-"carrier"',
    cliType: "claude",
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
