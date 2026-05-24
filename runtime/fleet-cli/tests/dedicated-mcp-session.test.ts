import { describe, expect, it, vi } from "vitest";

import type { AgentToolSpec, McpRouterRuntime } from "@dotobokuri/fleet-mcp-server";

const mcpMocks = vi.hoisted(() => ({
  cleanupExecutorSession: vi.fn(),
  installExecutorToolCallRouter: vi.fn(),
  registerExecutorSessionTools: vi.fn(),
}));

vi.mock("@dotobokuri/fleet-mcp-server", () => mcpMocks);

import { createDedicatedMcpSession } from "../src/admiral/mcp.js";

describe("dedicated MCP session token cleanup", () => {
  it("cleans up previously issued runtime tokens when a later runtime registration fails", () => {
    const firstRuntime = makeRuntime([makeTool("first_tool")]);
    const secondRuntime = makeRuntime([makeTool("second_tool")]);
    mcpMocks.registerExecutorSessionTools.mockImplementation(() => {
      if (mcpMocks.registerExecutorSessionTools.mock.calls.length === 2) {
        throw new Error("registration failed");
      }
    });

    const session = createDedicatedMcpSession({
      runtimes: [
        { name: "first", runtime: firstRuntime },
        { name: "second", runtime: secondRuntime },
      ],
    });

    expect(() => session.issueSessionToken({ label: "dedicated:test", cwd: process.cwd() })).toThrow("registration failed");

    expect(mcpMocks.cleanupExecutorSession).toHaveBeenCalledTimes(1);
    expect(mcpMocks.cleanupExecutorSession).toHaveBeenCalledWith(firstRuntime, expect.any(String));
  });
});

function makeRuntime(tools: readonly AgentToolSpec[]): McpRouterRuntime {
  return {
    registry: {
      getAllAgentTools: () => [...tools],
    },
    server: {},
    snapshotStore: {},
  } as McpRouterRuntime;
}

function makeTool(id: string): AgentToolSpec {
  return {
    id,
    tag: id,
    title: id,
    description: id,
    promptSnippet: id,
    whenToUse: [],
    whenNotToUse: [],
    usageGuidelines: [],
    parameters: {},
    async execute() {
      return {};
    },
  };
}
