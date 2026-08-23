import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_MESSAGES_URL,
  anthropicNativeHeaders,
} from "../../../src/index.js";

describe("anthropic native passthrough policy", () => {
  it("owns the native Anthropic messages endpoint", () => {
    expect(ANTHROPIC_MESSAGES_URL).toBe("https://api.anthropic.com/v1/messages");
  });

  it("defaults anthropic-version and always sets content-type", () => {
    expect(anthropicNativeHeaders({})).toEqual({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    });
  });

  it("preserves the caller's anthropic-version", () => {
    expect(anthropicNativeHeaders({ "anthropic-version": "2024-10-22" })).toMatchObject({
      "anthropic-version": "2024-10-22",
    });
  });

  it("forwards authorization, x-api-key, anthropic-beta, and user-agent without replacing them", () => {
    expect(anthropicNativeHeaders({
      authorization: "Bearer sk-ant-caller",
      "x-api-key": "sk-ant-x",
      "anthropic-beta": "tools-2025-01-01",
      "user-agent": "claude-code/2.x",
    })).toEqual({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      authorization: "Bearer sk-ant-caller",
      "x-api-key": "sk-ant-x",
      "anthropic-beta": "tools-2025-01-01",
      "user-agent": "claude-code/2.x",
    });
  });

  it("ignores non-string values for forwarded headers", () => {
    expect(anthropicNativeHeaders({
      authorization: undefined,
      "x-api-key": 42,
      "anthropic-beta": null,
    })).toEqual({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    });
  });
});
