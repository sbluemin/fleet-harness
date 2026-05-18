import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  startMcpServer,
  stopMcpServer,
} from "@sbluemin/fleet-mcp-server";
import {
  clearAllTools,
  getToolsForSession,
} from "@sbluemin/fleet-mcp-server";
import {
  installExecutorToolCallRouter,
  registerExecutorSessionTools,
  cleanupExecutorSession,
} from "@sbluemin/fleet-mcp-server";
import {
  registerAgentTool,
  registerExecutorTool,
  clearAllDefaultTools,
  clearAllExtraTools,
  invoke,
  EXECUTOR_MCP_TOOL_IDS,
  getExecutorMcpTools,
  registerFleetCoreDefaultAgentTools,
} from "../../src/admiral/agent/tools.js";
import type { AgentToolSpec } from "@sbluemin/fleet-core";
import {
  clearRegisteredCarriers,
  registerCarrier,
} from "../../src/admiral/carrier/framework.js";
import type { CarrierMetadata } from "../../src/admiral/carrier/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const WIKI_EXECUTOR_TOOL_IDS = [
  "wiki_briefing",
  "wiki_drydock",
  "wiki_ingest",
  "wiki_orient",
  "wiki_query",
  "wiki_read",
  "wiki_resolve",
] as const;

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

function makeCarrierMetadata(allowedExecutorTools?: readonly string[]): CarrierMetadata {
  return {
    title: "Test Carrier",
    summary: "Test carrier metadata",
    category: "operations",
    whenToUse: [],
    whenNotToUse: [],
    requestBlocks: [],
    allowedExecutorTools,
    permissions: [],
    outputFormat: "",
  };
}

function registerTestCarrier(id: string, allowedExecutorTools?: readonly string[]): void {
  registerCarrier({
    id,
    cliType: "claude",
    defaultCliType: "claude",
    slot: 99,
    displayName: id,
    color: "",
    carrierMetadata: makeCarrierMetadata(allowedExecutorTools),
  });
}

function registerChronicleWikiTools(): void {
  for (const id of WIKI_EXECUTOR_TOOL_IDS) {
    registerExecutorTool(makeToolSpec(id, () => `${id}-ok`), { allowedCarriers: ["chronicle"] });
  }
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
    clearRegisteredCarriers();
    registerFleetCoreDefaultAgentTools();
  });

  it("EXECUTOR_MCP_TOOL_IDS에 carrier_jobs가 포함된다", () => {
    expect(EXECUTOR_MCP_TOOL_IDS).toContain("carrier_jobs");
  });

  it("getExecutorMcpTools()는 기본 global scope에서 도구를 반환하지 않는다", () => {
    const specs = getExecutorMcpTools();
    const ids = specs.map((s) => s.id);
    expect(ids).toEqual([]);
  });

  it("getExecutorMcpTools()는 화이트리스트 외 도구(carrier_dispatch 등)를 반환하지 않는다", () => {
    const specs = getExecutorMcpTools();
    const ids = specs.map((s) => s.id);
    expect(ids).not.toContain("carrier_dispatch");
    expect(ids).not.toContain("carrier_squadron");
    expect(ids).not.toContain("carrier_taskforce");
  });

  it("chronicle 호출 시 tool-centric wiki 도구 7개를 반환한다", () => {
    registerChronicleWikiTools();

    const ids = getExecutorMcpTools("chronicle").map((s) => s.id);

    expect(WIKI_EXECUTOR_TOOL_IDS.every((id) => ids.includes(id))).toBe(true);
    expect(ids).not.toContain("carrier_jobs");
  });

  it("비-chronicle 호출 시 명시 metadata가 없으면 도구를 반환하지 않는다", () => {
    // 이 테스트는 tool-centric 패턴(allowedCarriers)을 검증.
    // 실제 fleet-wiki는 순수 읽기 도구 4종(briefing/orient/read/resolve)을 글로벌 등록하여 비-chronicle도 접근 가능하고,
    // 쓰기·stage 가능 도구 3종(drydock/ingest/query)은 chronicle 전용으로 제한함.
    registerChronicleWikiTools();

    const ids = getExecutorMcpTools("genesis").map((s) => s.id);

    expect(ids).toEqual([]);
    expect(WIKI_EXECUTOR_TOOL_IDS.some((id) => ids.includes(id))).toBe(false);
  });

  it("carrierId가 없으면 전역 도구만 반환한다", () => {
    registerChronicleWikiTools();

    const ids = getExecutorMcpTools().map((s) => s.id);

    expect(ids).toEqual([]);
  });

  it("registerExecutorTool(spec)는 옵션 없이 global scope에 도구를 등록한다", () => {
    registerExecutorTool(makeToolSpec("global_tool", () => "global-ok"));

    const ids = getExecutorMcpTools().map((s) => s.id);

    expect(ids).toEqual(["global_tool"]);
  });

  it("metadata-declared registered tools를 lazy union한다", () => {
    registerTestCarrier("metadata_carrier", ["carrier_jobs", "metadata_tool"]);
    registerAgentTool(makeToolSpec("metadata_tool", () => "metadata-ok"));

    const ids = getExecutorMcpTools("metadata_carrier").map((s) => s.id);

    expect(ids).toEqual(["carrier_jobs", "metadata_tool"]);
  });

  it("metadata-declared unknown tool IDs는 spec 등록 전까지 무시한다", () => {
    registerTestCarrier("metadata_carrier", ["carrier_jobs", "metadata_tool", "missing_metadata_tool"]);
    registerAgentTool(makeToolSpec("metadata_tool", () => "metadata-ok"));

    const ids = getExecutorMcpTools("metadata_carrier").map((s) => s.id);

    expect(ids).toEqual(["carrier_jobs", "metadata_tool"]);
    expect(ids).not.toContain("missing_metadata_tool");
  });

  it("target carrier가 아니면 metadata-declared tools를 상속하지 않는다", () => {
    registerTestCarrier("metadata_carrier", ["carrier_jobs", "metadata_tool"]);
    registerTestCarrier("other_carrier");
    registerAgentTool(makeToolSpec("metadata_tool", () => "metadata-ok"));

    const ids = getExecutorMcpTools("other_carrier").map((s) => s.id);

    expect(ids).toEqual([]);
  });
});

describe("executor MCP router (mcp-router.ts)", () => {
  beforeEach(() => {
    clearAllTools();
    clearAllDefaultTools();
    clearAllExtraTools();
    clearRegisteredCarriers();
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
    installExecutorToolCallRouter(token, { cwd: process.cwd() }, invoke);

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
    installExecutorToolCallRouter(token, { cwd: process.cwd() }, invoke);

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
    installExecutorToolCallRouter(token, { cwd: process.cwd() }, invoke);
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
