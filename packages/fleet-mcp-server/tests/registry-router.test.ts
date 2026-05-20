import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  EXECUTOR_MCP_TOOL_IDS,
  cleanupExecutorSession,
  clearAllDefaultTools,
  clearAllExtraTools,
  clearAllTools,
  getExecutorMcpToolsForCarrier,
  getToolsForSession,
  installExecutorToolCallRouter,
  invoke,
  registerAgentTool,
  registerExecutorSessionTools,
  registerExecutorTool,
  startMcpServer,
  stopMcpServer,
} from "../src/index.js";
import type { AgentToolSpec } from "../src/index.js";

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

describe("executor MCP whitelist", () => {
  beforeEach(() => {
    clearAllDefaultTools();
    clearAllExtraTools();
  });

  it("EXECUTOR_MCP_TOOL_IDS에 carrier_jobs가 포함된다", () => {
    expect(EXECUTOR_MCP_TOOL_IDS).toContain("carrier_jobs");
  });

  it("기본 global scope에서 도구를 반환하지 않는다", () => {
    const specs = getExecutorMcpToolsForCarrier();
    expect(specs.map((s) => s.id)).toEqual([]);
  });

  it("carrier-scoped 도구와 metadata-declared 도구를 lazy union한다", () => {
    registerChronicleWikiTools();
    registerAgentTool(makeToolSpec("carrier_jobs", () => "jobs-ok"));

    const chronicleIds = getExecutorMcpToolsForCarrier("chronicle", ["carrier_jobs"])
      .map((s) => s.id);
    const otherIds = getExecutorMcpToolsForCarrier("genesis", ["carrier_jobs"])
      .map((s) => s.id);

    expect(WIKI_EXECUTOR_TOOL_IDS.every((id) => chronicleIds.includes(id))).toBe(true);
    expect(chronicleIds).toContain("carrier_jobs");
    expect(otherIds).toEqual(["carrier_jobs"]);
  });

  it("registerExecutorTool(spec)는 옵션 없이 global scope에 도구를 등록한다", () => {
    registerExecutorTool(makeToolSpec("global_tool", () => "global-ok"));

    const ids = getExecutorMcpToolsForCarrier().map((s) => s.id);

    expect(ids).toEqual(["global_tool"]);
  });

  it("duplicate tag를 거부한다", () => {
    registerAgentTool(makeToolSpec("tag_a", () => "a"));

    expect(() => {
      registerAgentTool({ ...makeToolSpec("tag_b", () => "b"), tag: "tag_a" });
    }).toThrow(/already registered/);
  });
});

describe("executor MCP router", () => {
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
});
