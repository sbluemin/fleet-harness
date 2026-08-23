import { describe, expect, it } from "vitest";

import { omitClaudeWebSearchTools } from "../../../../src/downstream/harness/claude-code/context.js";

const READ = {
  name: "Read",
  input_schema: { type: "object", properties: {} },
};

const WEB_SEARCH_CLIENT = {
  name: "WebSearch",
  input_schema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

const WEB_SEARCH_NATIVE = {
  type: "web_search_20250305",
  name: "web_search",
};

describe("omitClaudeWebSearchTools", () => {
  it("drops Claude Code's WebSearch helper and Anthropic's hosted web_search", () => {
    const request = {
      tools: [READ, WEB_SEARCH_CLIENT, WEB_SEARCH_NATIVE],
    };

    const result = omitClaudeWebSearchTools(request);

    expect(result.changed).toBe(true);
    expect(result.request.tools).toEqual([READ]);
    expect(request.tools).toHaveLength(3);
  });

  it("omits the tools key when every definition was a web search tool", () => {
    const result = omitClaudeWebSearchTools({ tools: [WEB_SEARCH_CLIENT] });

    expect(result.changed).toBe(true);
    expect(result.request).not.toHaveProperty("tools");
  });

  it("leaves a request without web search byte-for-byte intact", () => {
    const request = { tools: [READ], tool_choice: { type: "auto" as const } };

    const result = omitClaudeWebSearchTools(request);

    expect(result.changed).toBe(false);
    expect(result.request).toBe(request);
  });

  it("resets a tool_choice that named the omitted web search tool", () => {
    const result = omitClaudeWebSearchTools({
      tools: [READ, WEB_SEARCH_CLIENT],
      tool_choice: { type: "tool", name: "WebSearch", disable_parallel_tool_use: true },
    });

    expect(result.changed).toBe(true);
    expect(result.request.tools).toEqual([READ]);
    expect(result.request.tool_choice).toEqual({
      type: "auto",
      disable_parallel_tool_use: true,
    });
  });

  it("resets a Web Search tool_choice even when the catalog has no matching definition", () => {
    const result = omitClaudeWebSearchTools({
      tools: [READ],
      tool_choice: { type: "tool", name: "WebSearch", disable_parallel_tool_use: true },
    });

    expect(result.changed).toBe(true);
    expect(result.request.tools).toEqual([READ]);
    expect(result.request.tool_choice).toEqual({
      type: "auto",
      disable_parallel_tool_use: true,
    });
  });

  it("does not touch messages, including prior WebSearch tool_use history", () => {
    const messages = [{
      role: "assistant" as const,
      content: [{ type: "tool_use", id: "call_1", name: "WebSearch", input: { query: "x" } }],
    }];
    const request = { tools: [WEB_SEARCH_CLIENT], messages };

    const result = omitClaudeWebSearchTools(request);

    expect(result.request.messages).toBe(messages);
  });
});
