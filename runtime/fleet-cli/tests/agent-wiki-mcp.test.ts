import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isHostSessionToolAllowed } from "@dotobokuri/fleet-admiral";
import { getWikiToolSpecs } from "@dotobokuri/fleet-wiki";
import { createFleetCliRuntime, type FleetCliRuntime } from "../src/runtime/runtime.js";

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
  "wiki_schema_list",
  "wiki_schema_read",
  "wiki_schema_create",
] as const;

describe("fleet-cli gateway MCP composition", () => {
  let runtime: FleetCliRuntime | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await runtime?.cleanup();
    runtime = undefined;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it("exposes exactly Wiki and gateway_models tools on a gateway-doctrine fleet session", async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "fleet-cli-runtime-"));
    runtime = await createFleetCliRuntime({ dataDir });
    const endpoint = await runtime.dedicatedMcpSession.getEndpoint();
    const tokens = await runtime.dedicatedMcpSession.issueSessionToken({
      label: "gateway-host",
      cwd: process.cwd(),
      includeTool: (toolId) => isHostSessionToolAllowed(toolId, "gateway"),
    });

    expect(endpoint.servers.map((server) => server.name)).toEqual(["fleet"]);
    expect(tokens.map((token) => token.name)).toEqual(["fleet"]);
    const fleetServer = endpoint.servers[0]!;
    const fleetToken = tokens[0]!;
    const toolNames = await listMcpTools(fleetServer.url, fleetToken.token);
    const expected = [...EXPECTED_WIKI_TOOL_IDS, "gateway_models"].sort();

    expect([...toolNames].sort()).toEqual(expected);
    expect(toolNames.has("carrier_dispatch")).toBe(false);
    expect(toolNames.has("carrier_jobs")).toBe(false);
    expect(
      runtime.mcpRegistry.getAllAgentTools()
        .filter((spec) => EXPECTED_WIKI_TOOL_IDS.includes(spec.id as typeof EXPECTED_WIKI_TOOL_IDS[number]))
        .map((spec) => ({ id: spec.id, parameters: spec.parameters })),
    ).toEqual(getWikiToolSpecs().map((spec) => ({ id: spec.id, parameters: spec.parameters })));
  });
});

async function listMcpTools(url: string, token: string): Promise<Set<string>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = await response.json() as McpToolListResponse;
  return new Set(body.result?.tools?.map((tool) => tool.name).filter((name): name is string => Boolean(name)));
}
