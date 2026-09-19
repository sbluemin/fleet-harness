import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isHostSessionToolAllowed } from "@fleet-console/agent-runtime/fleet";
import { createFleetCliRuntime, type FleetCliRuntime } from "../../cli/runtime/runtime.js";

interface McpToolListResponse {
  readonly result?: {
    readonly tools?: ReadonlyArray<{ readonly name?: string }>;
  };
}

describe("fleet-cli gateway MCP composition", () => {
  let runtime: FleetCliRuntime | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await runtime?.cleanup();
    runtime = undefined;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it("exposes only the Gateway server without injecting Codex Wiki into a fleet session", async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "fleet-cli-runtime-"));
    runtime = await createFleetCliRuntime({ dataDir });
    const endpoint = await runtime.dedicatedMcpSession.getEndpoint();
    const tokens = await runtime.dedicatedMcpSession.issueSessionToken({
      label: "gateway-host",
      cwd: process.cwd(),
      includeTool: (toolId) => isHostSessionToolAllowed(toolId),
    });

    expect(new Set(endpoint.servers.map((server) => new URL(server.url).origin)).size).toBe(1);
    expect(new Set(endpoint.servers.map((server) => new URL(server.url).pathname)).size).toBe(endpoint.servers.length);
    expect(endpoint.servers.map((server) => server.name)).toEqual(["fleet-ai-gateway"]);
    expect(tokens.map((token) => token.name)).toEqual(["fleet-ai-gateway"]);
    expect(await listMcpTools(endpoint.servers[0]!.url, tokens[0]!.token)).toEqual(new Set([]));
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
