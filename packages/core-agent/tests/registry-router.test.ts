import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupExecutorSession,
  createMcpToolRegistry,
  createMcpToolSnapshotStore,
  installExecutorToolCallRouter,
  registerExecutorSessionTools,
} from "../src/index.js";
import type { AgentToolSpec, McpRouterRuntime } from "../src/index.js";

const SCOPED_EXECUTOR_TOOL_IDS = [
  "scoped_read",
  "scoped_write",
] as const;

let whitelistRegistry = createMcpToolRegistry();
let routerRuntime: McpRouterRuntime;

function makeToolSpec(id: string, execute: (args: unknown) => unknown): AgentToolSpec {
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
    async execute(args) {
      return execute(args);
    },
  };
}

function registerScopedTools(): void {
  for (const id of SCOPED_EXECUTOR_TOOL_IDS) {
    whitelistRegistry.registerExecutorTool(makeToolSpec(id, () => `${id}-ok`), { allowedScopes: ["scope_a"] });
  }
}

describe("executor MCP whitelist", () => {
  beforeEach(() => {
    whitelistRegistry = createMcpToolRegistry();
  });

  it("기본 global scope에서 도구를 반환하지 않는다", () => {
    const specs = whitelistRegistry.getExecutorMcpToolsForScope();
    expect(specs.map((s) => s.id)).toEqual([]);
  });

  it("scope-scoped 도구와 metadata-declared 도구를 lazy union한다", () => {
    registerScopedTools();
    whitelistRegistry.registerAgentTool(makeToolSpec("metadata_tool", () => "metadata-ok"));

    const scopeAIds = whitelistRegistry.getExecutorMcpToolsForScope("scope_a", ["metadata_tool"])
      .map((s) => s.id);
    const otherIds = whitelistRegistry.getExecutorMcpToolsForScope("scope_b", ["metadata_tool"])
      .map((s) => s.id);

    expect(SCOPED_EXECUTOR_TOOL_IDS.every((id) => scopeAIds.includes(id))).toBe(true);
    expect(scopeAIds).toContain("metadata_tool");
    expect(otherIds).toEqual(["metadata_tool"]);
  });

  it("executor-only 도구를 host agent 도구 목록에 노출하지 않는다", () => {
    registerScopedTools();

    expect(whitelistRegistry.getAllAgentTools()).toEqual([]);
    expect(whitelistRegistry.getExecutorMcpToolsForScope("scope_a").map((tool) => tool.id))
      .toEqual(SCOPED_EXECUTOR_TOOL_IDS);
  });

  it("같은 spec을 host와 executor에 명시적으로 공유할 수 있다", () => {
    const shared = makeToolSpec("shared_read", () => "ok");
    whitelistRegistry.registerAgentTool(shared);
    whitelistRegistry.registerExecutorTool(shared);

    expect(whitelistRegistry.getAllAgentTools().map((tool) => tool.id)).toEqual(["shared_read"]);
    expect(whitelistRegistry.getExecutorMcpToolsForScope().map((tool) => tool.id)).toEqual(["shared_read"]);
  });

  it("registerExecutorTool(spec)는 옵션 없이 global scope에 도구를 등록한다", () => {
    whitelistRegistry.registerExecutorTool(makeToolSpec("global_tool", () => "global-ok"));

    const ids = whitelistRegistry.getExecutorMcpToolsForScope().map((s) => s.id);

    expect(ids).toEqual(["global_tool"]);
  });

  it("duplicate tag를 거부한다", () => {
    whitelistRegistry.registerAgentTool(makeToolSpec("tag_a", () => "a"));

    expect(() => {
      whitelistRegistry.registerAgentTool({ ...makeToolSpec("tag_b", () => "b"), tag: "tag_a" });
    }).toThrow(/already registered/);
  });
});

describe("executor MCP router", () => {
  beforeEach(() => {
    const registry = createMcpToolRegistry();
    const snapshotStore = createMcpToolSnapshotStore();
    routerRuntime = {
      registry,
      server: {
        start: vi.fn(async () => "http://127.0.0.1:1/mcp"),
        setOnToolCallArrived: vi.fn(),
        resolveNextToolCall: vi.fn(),
        clearPendingForSession: vi.fn(),
      },
      snapshotStore,
    };
  });

  it("알 수 없는 도구 호출은 isError=true로 반환된다", async () => {
    const result = await routerRuntime.registry.invoke("completely_unknown_tool", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown tool");
  });

  it("cleanupExecutorSession 후 세션 tools가 제거된다", () => {
    const token = "exec-router-cleanup-tools";
    const spec = makeToolSpec("cleanup_spec", () => "ok");
    routerRuntime.registry.registerAgentTool(spec);
    registerExecutorSessionTools(routerRuntime, token, [spec]);

    expect(routerRuntime.snapshotStore.getToolsForSession(token).length).toBeGreaterThan(0);
    cleanupExecutorSession(routerRuntime, token);
    expect(routerRuntime.snapshotStore.getToolsForSession(token)).toHaveLength(0);
  });

});
