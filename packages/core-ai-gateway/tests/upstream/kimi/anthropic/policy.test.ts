import { describe, expect, it } from "vitest";

import {
  KIMI_MESSAGES_URL,
  kimiAnthropicHeaders,
  kimiRequestBody,
} from "../../../../src/index.js";
import type { AnthropicMessagesRequest } from "../../../../src/index.js";

function request(overrides: Partial<AnthropicMessagesRequest> = {}): AnthropicMessagesRequest {
  return {
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1024,
    ...overrides,
  };
}

describe("kimi anthropic policy", () => {
  it("owns the Kimi messages endpoint", () => {
    expect(KIMI_MESSAGES_URL).toBe("https://api.kimi.com/coding/v1/messages");
  });

  it("rewrites the model and expands eager tools", () => {
    const body = kimiRequestBody(request({
      model: "client-model",
      tools: [{
        name: "Read",
        input_schema: { type: "object", properties: {} },
        defer_loading: true,
      }],
    }), "k3");
    expect(body.model).toBe("k3");
    expect(body.tools).toEqual([{ name: "Read", input_schema: { type: "object", properties: {} } }]);
  });

  it("clamps the wider Claude ladder onto K3's three native tiers", () => {
    expect(kimiRequestBody(request({ output_config: { effort: "low" } }), "k3").output_config)
      .toEqual({ effort: "low" });
    expect(kimiRequestBody(request({ output_config: { effort: "medium" } }), "k3").output_config)
      .toEqual({ effort: "low" });
    expect(kimiRequestBody(request({ output_config: { effort: "xhigh" } }), "k3").output_config)
      .toEqual({ effort: "high" });
    expect(kimiRequestBody(request({ output_config: { effort: "max" } }), "k3").output_config)
      .toEqual({ effort: "max" });
  });

  it("passes the body through untouched when no effort is configured", () => {
    const next = kimiRequestBody(request({ output_config: { reasoning_effort: "high" } }), "k3");
    expect(next.output_config).toEqual({ reasoning_effort: "high" });
  });

  it("builds Anthropic wire headers with defaults and forwarding", () => {
    expect(kimiAnthropicHeaders({}, "k")).toEqual({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": "k",
    });
    expect(kimiAnthropicHeaders({
      "anthropic-version": "2024-10-22",
      "anthropic-beta": "tools-2025-01-01",
      "user-agent": "claude-code/2.x",
    }, "k")).toEqual({
      "content-type": "application/json",
      "anthropic-version": "2024-10-22",
      "x-api-key": "k",
      "anthropic-beta": "tools-2025-01-01",
      "user-agent": "claude-code/2.x",
    });
  });
});
