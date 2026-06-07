import { describe, expect, it, vi } from "vitest";

import { createExecutorSessionManager, type AgentToolSpec, type McpRouterRuntime } from "../src/index.js";

describe("executor session token cleanup", () => {
  it("releases only the requested label tokens", () => {
    const runtime = makeRuntime([makeTool("first_tool")]);
    const session = createExecutorSessionManager({
      runtimes: [{ name: "first", runtime }],
    });
    const first = session.issueSessionToken({ label: "executor:first", cwd: process.cwd() });
    const second = session.issueSessionToken({ label: "executor:second", cwd: process.cwd() });

    session.releaseSessionToken("executor:first");
    session.releaseSessionToken("executor:first");

    expect(runtime.server.setOnToolCallArrived).toHaveBeenCalledWith(first[0]?.token, null);
    expect(runtime.snapshotStore.removeToolsForSession).toHaveBeenCalledWith(first[0]?.token);
    expect(runtime.server.setOnToolCallArrived).not.toHaveBeenCalledWith(second[0]?.token, null);
  });

  it("cleans up previously issued runtime tokens when a later runtime registration fails", () => {
    const firstRuntime = makeRuntime([makeTool("first_tool")]);
    const secondRuntime = makeRuntime([makeTool("second_tool")]);
    secondRuntime.snapshotStore.registerToolsForSession = vi.fn(() => {
      throw new Error("registration failed");
    });

    const session = createExecutorSessionManager({
      runtimes: [
        { name: "first", runtime: firstRuntime },
        { name: "second", runtime: secondRuntime },
      ],
    });

    expect(() => session.issueSessionToken({ label: "executor:test", cwd: process.cwd() })).toThrow("registration failed");

    expect(firstRuntime.server.setOnToolCallArrived).toHaveBeenCalledWith(expect.any(String), null);
    expect(firstRuntime.snapshotStore.removeToolsForSession).toHaveBeenCalledWith(expect.any(String));
    expect(firstRuntime.server.clearPendingForSession).toHaveBeenCalledWith(expect.any(String));
  });
});

function makeRuntime(tools: readonly AgentToolSpec[]): McpRouterRuntime {
  return {
    registry: {
      getAllAgentTools: () => [...tools],
      invoke: vi.fn(),
    },
    server: {
      start: vi.fn(async () => "http://127.0.0.1:1/mcp"),
      setOnToolCallArrived: vi.fn(),
      clearPendingForSession: vi.fn(),
      resolveNextToolCall: vi.fn(),
    },
    snapshotStore: {
      registerToolsForSession: vi.fn(),
      removeToolsForSession: vi.fn(),
    },
  } as unknown as McpRouterRuntime;
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
