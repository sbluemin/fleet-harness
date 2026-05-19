import { afterEach, describe, expect, it } from "vitest";

import { bootRuntime, type FleetCoreRuntimeContext } from "../src/runtime/runtime.js";

interface McpToolListResponse {
  readonly result?: {
    readonly tools?: ReadonlyArray<{ readonly name?: string }>;
  };
}

const EXPECTED_WIKI_TOOL_IDS = [
  "wiki_briefing",
  "wiki_orient",
  "wiki_read",
  "wiki_resolve",
  "wiki_drydock",
  "wiki_ingest",
  "wiki_patch_edit",
  "wiki_query",
] as const;

describe("fleet-agent dedicated CLI wiki MCP registration", () => {
  let rt: FleetCoreRuntimeContext | undefined;

  afterEach(async () => {
    await rt?.shutdown();
    rt = undefined;
  });

  it("exposes all Fleet Wiki agent tools on dedicated session tokens after boot", async () => {
    rt = await bootRuntime();
    const endpoint = await rt.admiral.mcp.getEndpoint();
    const token = rt.admiral.mcp.issueDedicatedSessionToken({
      label: "dedicated:test-wiki",
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
        method: "tools/list",
      }),
    });
    const body = await response.json() as McpToolListResponse;
    const toolNames = new Set(body.result?.tools?.map((tool) => tool.name).filter((name): name is string => Boolean(name)));

    for (const toolId of EXPECTED_WIKI_TOOL_IDS) {
      expect(toolNames.has(toolId)).toBe(true);
    }
  });
});
