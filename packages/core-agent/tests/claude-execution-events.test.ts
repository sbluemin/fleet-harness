import { describe, expect, it } from "vitest";

import {
  createClaudeExecutionEventDecoder,
  type ClaudeExecutionEventDecoder,
} from "../src/claude/index.js";
import type { ClaudeGatewayMessage } from "../src/claude/index.js";

describe("createClaudeExecutionEventDecoder", () => {
  it("emits text and thinking only from non-empty content_block_delta payloads", () => {
    const decoder = createClaudeExecutionEventDecoder();
    expect(decoder.decode(textDelta("hi"))).toEqual([{ kind: "text", text: "hi" }]);
    expect(decoder.decode(thinkingDelta("hmm"))).toEqual([{ kind: "thinking", text: "hmm" }]);
    expect(decoder.decode(textDelta(""))).toEqual([]);
    expect(decoder.decode(thinkingDelta(""))).toEqual([]);
    expect(decoder.decode(delta("input_json_delta", { partial_json: "{" }))).toEqual([]);
  });

  it("starts tools from assistant tool_use blocks and falls the name back to tool", () => {
    const decoder = createClaudeExecutionEventDecoder();
    expect(decoder.decode({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "ignore" },
          { type: "tool_use", id: "t1", name: "WebSearch", input: { query: "fleet" } },
          { type: "tool_use", id: "t2", input: { path: "a.ts" } },
          { type: "tool_use", name: "orphan", input: 3 },
        ],
      },
    })).toEqual([
      { kind: "tool-start", id: "t1", name: "WebSearch", input: { query: "fleet" } },
      { kind: "tool-start", id: "t2", name: "tool", input: { path: "a.ts" } },
      { kind: "tool-start", name: "orphan", input: 3 },
    ]);
  });

  it("ends tools from user tool_result blocks and correlates the remembered name", () => {
    const decoder = createClaudeExecutionEventDecoder();
    decoder.decode({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "WebFetch", input: { url: "https://x" } }] },
    });
    expect(decoder.decode({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", is_error: false },
          { type: "tool_result", tool_use_id: "missing", is_error: true },
          { type: "tool_result", is_error: 1 },
        ],
      },
    })).toEqual([
      { kind: "tool-end", id: "t1", name: "WebFetch", isError: false },
      { kind: "tool-end", id: "missing", isError: true },
      { kind: "tool-end", isError: false },
    ]);
  });

  it("does not leak tool names across decoder instances", () => {
    const first = createClaudeExecutionEventDecoder();
    first.decode({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "WebSearch", input: {} }] },
    });
    const second = createClaudeExecutionEventDecoder();
    expect(second.decode({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] },
    })).toEqual([{ kind: "tool-end", id: "t1", isError: false }]);
  });

  it("maps a result message, taking only a string result as detail", () => {
    const decoder = createClaudeExecutionEventDecoder();
    expect(decoder.decode({ type: "result", is_error: false })).toEqual([
      { kind: "result", isError: false, source: "message" },
    ]);
    expect(decoder.decode({ type: "result", is_error: true, result: "denied" })).toEqual([
      { kind: "result", isError: true, detail: "denied", source: "message" },
    ]);
    expect(decoder.decode({ type: "result", is_error: true, result: { nested: true } })).toEqual([
      { kind: "result", isError: true, source: "message" },
    ]);
  });

  it("returns nothing for malformed and unrelated shapes", () => {
    const decoder = createClaudeExecutionEventDecoder();
    const malformed: unknown[] = [
      null,
      undefined,
      "stream_event",
      { type: "system", subtype: "init", session_id: "child" },
      { type: "rate_limit_event" },
      { type: "stream_event" },
      { type: "stream_event", event: null },
      { type: "stream_event", event: { type: "content_block_start" } },
      { type: "stream_event", event: { type: "content_block_delta", delta: null } },
      { type: "assistant" },
      { type: "assistant", message: { content: "not-an-array" } },
      { type: "assistant", message: { content: [null, "x"] } },
      { type: "user", message: { content: [{ type: "text", text: "hi" }] } },
      { type: "user" },
    ];
    for (const value of malformed) {
      expect(decodeUnknown(decoder, value), JSON.stringify(value)).toEqual([]);
    }
  });
});

function decodeUnknown(decoder: ClaudeExecutionEventDecoder, value: unknown): unknown {
  return decoder.decode(value as ClaudeGatewayMessage);
}

function textDelta(text: string): ClaudeGatewayMessage {
  return delta("text_delta", { text });
}

function thinkingDelta(thinking: string): ClaudeGatewayMessage {
  return delta("thinking_delta", { thinking });
}

function delta(type: string, payload: Record<string, unknown>): ClaudeGatewayMessage {
  return { type: "stream_event", event: { type: "content_block_delta", delta: { type, ...payload } } };
}
