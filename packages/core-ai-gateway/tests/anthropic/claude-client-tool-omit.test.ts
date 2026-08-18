import { describe, expect, it } from "vitest";

import { omitClaudeClientTools } from "../../src/anthropic/claude-context.js";

/** Any pair of caller tool names; this helper knows names, never which ones matter. */
const SEARCH_TOOLS = ["Grep", "Glob"];

const READ = { name: "Read", input_schema: { type: "object", properties: {} } };
const GREP = { name: "Grep", input_schema: { type: "object", properties: {} } };
const GLOB = { name: "Glob", input_schema: { type: "object", properties: {} } };

describe("omitClaudeClientTools", () => {
  it("drops every named tool and leaves the rest in order", () => {
    const result = omitClaudeClientTools({ tools: [READ, GREP, GLOB] }, SEARCH_TOOLS);

    expect(result.changed).toBe(true);
    expect(result.request.tools).toEqual([READ]);
  });

  it("matches a server tool on its type as well as its name", () => {
    const hosted = { type: "web_search_20250305", name: "web_search" };

    const byType = omitClaudeClientTools({ tools: [READ, hosted] }, ["web_search_20250305"]);
    const byName = omitClaudeClientTools({ tools: [READ, hosted] }, ["web_search"]);

    expect(byType.request.tools).toEqual([READ]);
    expect(byName.request.tools).toEqual([READ]);
  });

  it("omits the tools key rather than sending an empty catalog", () => {
    const result = omitClaudeClientTools({ tools: [GREP] }, SEARCH_TOOLS);

    expect(result.changed).toBe(true);
    expect("tools" in result.request).toBe(false);
  });

  // 보류한 도구에 고정된 선택을 남기면, 모델이 볼 수 없는 도구에 요청이 묶인다.
  it("downgrades a pinned tool_choice and keeps its parallel-use flag", () => {
    const result = omitClaudeClientTools(
      { tools: [READ, GREP], tool_choice: { type: "tool", name: "Grep", disable_parallel_tool_use: true } },
      SEARCH_TOOLS,
    );

    expect(result.request.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("leaves an auto tool_choice and an unaffected catalog identical", () => {
    const request = { tools: [READ], tool_choice: { type: "auto" } };

    const result = omitClaudeClientTools(request, SEARCH_TOOLS);

    expect(result.changed).toBe(false);
    expect(result.request).toBe(request);
  });

  it("is a no-op when the caller named nothing", () => {
    const request = { tools: [READ, GREP] };

    const result = omitClaudeClientTools(request, []);

    expect(result.changed).toBe(false);
    expect(result.request).toBe(request);
  });
});
