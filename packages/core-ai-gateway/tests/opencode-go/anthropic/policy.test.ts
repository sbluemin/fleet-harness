import { describe, expect, it } from "vitest";

import {
  opencodeAnthropicHeaders,
  opencodeRequestBody,
} from "../../../src/index.js";
import type { AnthropicMessagesRequest } from "../../../src/index.js";

function request(overrides: Partial<AnthropicMessagesRequest> = {}): AnthropicMessagesRequest {
  return {
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1024,
    ...overrides,
  };
}

describe("opencode go anthropic policy", () => {
  it("rewrites the model and expands eager tools", () => {
    const body = opencodeRequestBody(request({
      model: "client-model",
      tools: [{
        name: "Read",
        input_schema: { type: "object", properties: {} },
        defer_loading: true,
      }],
    }), "minimax-m2.5");
    expect(body.model).toBe("minimax-m2.5");
    expect(body.tools).toEqual([{ name: "Read", input_schema: { type: "object", properties: {} } }]);
  });

  it("strips effort from output_config but keeps the other fields", () => {
    const next = opencodeRequestBody(
      request({ output_config: { effort: "high", reasoning_effort: "low" } }),
      "minimax-m2.5",
    );
    expect(next.output_config).toEqual({ reasoning_effort: "low" });
  });

  it("drops output_config entirely when it only carried effort", () => {
    const next = opencodeRequestBody(
      request({ output_config: { effort: "high" } }),
      "minimax-m2.5",
    );
    expect(next.output_config).toBeUndefined();
  });

  it("passes the body through untouched when there is no output_config", () => {
    const body = request();
    expect(opencodeRequestBody(body, "minimax-m2.5")).toEqual({ ...body, model: "minimax-m2.5" });
  });

  it("builds Anthropic wire headers with defaults and forwarding", () => {
    expect(opencodeAnthropicHeaders({}, "k")).toEqual({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": "k",
    });
    expect(opencodeAnthropicHeaders({
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
