import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getToolsForSession,
  stopMcpServer,
} from "@sbluemin/fleet-mcp-server";

import { clearAllDefaultTools, clearAllExtraTools, registerAgentTool } from "../../src/admiral/agent/tools.js";
import { admiral } from "../../src/admiral/index.js";
import { bootFleetCore, type AgentToolSpec } from "../../src/index.js";

const dedicatedProbeTool: AgentToolSpec = {
  id: "dedicated_probe",
  tag: "dedicated_probe",
  title: "Dedicated Probe",
  description: "Dedicated MCP probe",
  promptSnippet: "dedicated_probe",
  whenToUse: [],
  whenNotToUse: [],
  usageGuidelines: [],
  parameters: {},
  async execute(_args, ctx) {
    return {
      content: [{ type: "text", text: `cwd:${ctx.cwd}` }],
      isError: false,
    };
  },
};

describe("admiral.mcp dedicated CLI facade", () => {
  beforeEach(() => {
    clearAllDefaultTools();
    clearAllExtraTools();
  });

  afterEach(async () => {
    admiral.mcp.cleanupDedicatedMcpSessionsForRuntimeShutdown();
    clearAllDefaultTools();
    clearAllExtraTools();
    await stopMcpServer();
  });

  it("getEndpoint awaits the MCP server and returns a URL string", async () => {
    const endpoint = await admiral.mcp.getEndpoint();

    expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/.+/);
  });

  it("issueDedicatedSessionToken registers a non-empty tool snapshot and fresh tokens", async () => {
    const runtime = bootFleetCore({ dataDir: process.cwd(), bootMode: "dev" });

    const firstToken = admiral.mcp.issueDedicatedSessionToken({
      label: "dedicated:claude",
      cwd: process.cwd(),
    });
    const secondToken = admiral.mcp.issueDedicatedSessionToken({
      label: "dedicated:codex",
      cwd: process.cwd(),
    });

    expect(firstToken).not.toBe(secondToken);
    expect(getToolsForSession(firstToken).length).toBeGreaterThan(0);
    expect(getToolsForSession(secondToken).length).toBeGreaterThan(0);
    await runtime.shutdown();
  });

  it("same-label token replacement cleans up the old snapshot and installs the new one", async () => {
    const runtime = bootFleetCore({ dataDir: process.cwd(), bootMode: "dev" });

    const oldToken = admiral.mcp.issueDedicatedSessionToken({
      label: "dedicated:claude",
      cwd: process.cwd(),
    });
    const newToken = admiral.mcp.issueDedicatedSessionToken({
      label: "dedicated:claude",
      cwd: process.cwd(),
    });

    expect(newToken).not.toBe(oldToken);
    expect(getToolsForSession(oldToken)).toHaveLength(0);
    expect(getToolsForSession(newToken).length).toBeGreaterThan(0);
    await runtime.shutdown();
  });

  it("issued tokens install a direct executor router for MCP tools/call", async () => {
    const runtime = bootFleetCore({ dataDir: process.cwd(), bootMode: "dev" });
    registerAgentTool(dedicatedProbeTool);
    const endpoint = await admiral.mcp.getEndpoint();
    const token = admiral.mcp.issueDedicatedSessionToken({
      label: "dedicated:claude",
      cwd: process.cwd(),
    });

    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "dedicated_probe", arguments: {} },
      }),
    });
    const body = await response.json() as { result?: { content?: Array<{ text?: string }> } };

    expect(body.result?.content?.[0]?.text).toBe(`cwd:${process.cwd()}`);
    await runtime.shutdown();
  });
});
