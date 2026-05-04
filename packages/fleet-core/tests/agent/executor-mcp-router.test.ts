import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  startMcpServer,
  stopMcpServer,
} from "../../src/admiral/_shared/mcp.js";
import {
  clearAllTools,
  getToolsForSession,
} from "../../src/admiral/agent/internal/tool-snapshot.js";
import {
  installExecutorToolCallRouter,
  registerExecutorSessionTools,
  cleanupExecutorSession,
} from "../../src/admiral/agent/internal/mcp-router.js";
import {
  registerAgentTool,
  clearAllDefaultTools,
  clearAllExtraTools,
  invoke,
  EXECUTOR_MCP_TOOL_IDS,
  getExecutorMcpTools,
} from "../../src/admiral/agent/tools.js";
import type { AgentToolSpec } from "../../src/admiral/agent/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

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

async function mcpToolsCall(
  url: string,
  token: string,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("executor MCP whitelist (tools.ts)", () => {
  beforeEach(() => {
    clearAllDefaultTools();
    clearAllExtraTools();
  });

  it("EXECUTOR_MCP_TOOL_IDS에 carrier_jobs가 포함된다", () => {
    expect(EXECUTOR_MCP_TOOL_IDS).toContain("carrier_jobs");
  });

  it("getExecutorMcpTools()는 carrier_jobs 스펙만 반환한다", () => {
    const specs = getExecutorMcpTools();
    const ids = specs.map((s) => s.id);
    expect(ids).toContain("carrier_jobs");
    for (const id of ids) {
      expect(EXECUTOR_MCP_TOOL_IDS as readonly string[]).toContain(id);
    }
  });

  it("getExecutorMcpTools()는 화이트리스트 외 도구(carrier_dispatch 등)를 반환하지 않는다", () => {
    const specs = getExecutorMcpTools();
    const ids = specs.map((s) => s.id);
    expect(ids).not.toContain("carrier_dispatch");
    expect(ids).not.toContain("carrier_squadron");
    expect(ids).not.toContain("carrier_taskforce");
  });
});

describe("executor MCP router (mcp-router.ts)", () => {
  beforeEach(() => {
    clearAllTools();
    clearAllDefaultTools();
    clearAllExtraTools();
  });

  afterAll(async () => {
    await stopMcpServer();
  });

  it("self-invoke 성공 경로: 도구 실행 결과가 MCP 응답으로 반환된다", async () => {
    const url = await startMcpServer();
    const token = "exec-router-success";
    const spec = makeToolSpec("exec_ok", () => ({
      content: [{ type: "text", text: "success-value" }],
      isError: false,
    }));
    registerAgentTool(spec);
    registerExecutorSessionTools(token, [spec]);
    installExecutorToolCallRouter(token, { cwd: process.cwd() });

    const body = await mcpToolsCall(url, token, "exec_ok");

    expect(body.result).toEqual({
      content: [{ type: "text", text: "success-value" }],
      isError: false,
    });
    cleanupExecutorSession(token);
  });

  it("self-invoke 실패 경로: 도구 execute 오류가 isError=true로 반환된다", async () => {
    const url = await startMcpServer();
    const token = "exec-router-failure";
    const spec = makeToolSpec("exec_throws", () => {
      throw new Error("deliberate-failure");
    });
    registerAgentTool(spec);
    registerExecutorSessionTools(token, [spec]);
    installExecutorToolCallRouter(token, { cwd: process.cwd() });

    const body = await mcpToolsCall(url, token, "exec_throws");

    expect(body.result).toBeDefined();
    const result = body.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("deliberate-failure");
    cleanupExecutorSession(token);
  });

  it("알 수 없는 도구 호출은 isError=true로 반환된다", async () => {
    // executor router는 invoke()를 그대로 호출하므로 invoke() 직접 검증이 동등한 증명
    const result = await invoke("completely_unknown_tool", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown tool");
  });

  it("cleanupExecutorSession 후 세션 tools가 제거된다", () => {
    const token = "exec-router-cleanup-tools";
    const spec = makeToolSpec("cleanup_spec", () => "ok");
    registerAgentTool(spec);
    registerExecutorSessionTools(token, [spec]);

    expect(getToolsForSession(token).length).toBeGreaterThan(0);
    cleanupExecutorSession(token);
    expect(getToolsForSession(token)).toHaveLength(0);
  });

  it("cleanupExecutorSession 후 tools/call은 router 미등록 에러를 반환한다", async () => {
    const url = await startMcpServer();
    const token = "exec-router-cleanup-router";
    const spec = makeToolSpec("router_guard_tool", () => "ok");
    registerAgentTool(spec);
    registerExecutorSessionTools(token, [spec]);
    installExecutorToolCallRouter(token, { cwd: process.cwd() });
    cleanupExecutorSession(token);

    // tools는 제거됐으나 MCP 서버가 아직 이 token을 모르면 401이 나올 수 있음
    // tools가 없어도 tools/list를 위해 새 token으로 등록 후 router만 빠진 상태 테스트
    const specB = makeToolSpec("router_guard_b", () => "ok");
    registerExecutorSessionTools(token, [specB]); // tools는 재등록, router는 없음
    const body = await mcpToolsCall(url, token, "router_guard_b");
    expect((body.error as Record<string, unknown> | undefined)?.code).toBe(-32000);
    cleanupExecutorSession(token);
  });
});
