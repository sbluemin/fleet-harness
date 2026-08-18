import { describe, expect, it } from "vitest";

import {
  applyGatewayRequestPolicy,
  resolveGatewayRequestPolicy,
} from "../../src/gateway-router/router-policy.js";
import { GATEWAY_PROVIDERS, findGatewayModel } from "../../src/models.js";
import type { GatewayProvider } from "../../src/models.js";
import type { AnthropicMessagesRequest } from "../../src/anthropic/protocol.js";

/** One catalog model per provider, so every policy runs against a real target. */
const SAMPLE_MODEL: Readonly<Record<GatewayProvider, string>> = {
  codex: "claude-gateway--codex--gpt-5.6-sol",
  cursor: "claude-gateway--cursor--grok-4.5",
  kimi: "claude-gateway--kimi--k3",
  opencode: "claude-gateway--opencode--minimax-m3[1m]",
  xai: "claude-gateway--xai--grok-4.6",
};

function requestFor(): AnthropicMessagesRequest {
  return {
    model: "irrelevant",
    max_tokens: 128,
    messages: [{ role: "user", content: "Find the failing test." }],
    tools: [
      { name: "Read", input_schema: { type: "object", properties: {} } },
      { name: "Grep", input_schema: { type: "object", properties: {} } },
      { name: "Glob", input_schema: { type: "object", properties: {} } },
      { name: "WebSearch", input_schema: { type: "object", properties: {} } },
    ],
  } as unknown as AnthropicMessagesRequest;
}

function toolsFor(provider: GatewayProvider): readonly string[] {
  const target = findGatewayModel(SAMPLE_MODEL[provider]);
  if (!target) throw new Error(`${provider}: sample model left the catalog`);
  const shaped = applyGatewayRequestPolicy(requestFor(), target, new Set<string>());
  return (shaped.tools ?? []).map((tool) => String((tool as { name?: unknown }).name));
}

describe("gateway request policy", () => {
  it("gives every catalog provider a policy that declares its own name", () => {
    for (const provider of GATEWAY_PROVIDERS) {
      const policy = resolveGatewayRequestPolicy(provider);
      expect(policy, `${provider} has no policy`).toBeDefined();
      expect(policy.provider).toBe(provider);
    }
  });

  // 어느 공급자가 무엇을 받는지가 여기 한 표에 모인다. 정책을 바꾸면 이 표가 먼저 진다.
  it.each([
    ["cursor", ["Read", "Grep", "Glob"]],
    ["xai", ["Read", "Grep", "Glob"]],
    ["opencode", ["Read", "Grep", "Glob"]],
    ["codex", ["Read"]],
    ["kimi", ["Read", "Grep", "Glob", "WebSearch"]],
  ] as const)("shapes a %s request", (provider, tools) => {
    expect(toolsFor(provider)).toEqual(tools);
  });

  it("downgrades a tool_choice pinned to a tool the policy withheld", () => {
    const target = findGatewayModel(SAMPLE_MODEL.codex)!;
    const request = { ...requestFor(), tool_choice: { type: "tool", name: "Grep" } };

    const shaped = applyGatewayRequestPolicy(
      request as unknown as AnthropicMessagesRequest,
      target,
      new Set<string>(),
    );

    expect(shaped.tool_choice).toEqual({ type: "auto" });
  });

  it("leaves a request the policy had nothing to change identical", () => {
    const target = findGatewayModel(SAMPLE_MODEL.kimi)!;
    const request = {
      model: "irrelevant",
      max_tokens: 8,
      messages: [{ role: "user", content: "Hello" }],
    } as unknown as AnthropicMessagesRequest;

    expect(applyGatewayRequestPolicy(request, target, new Set<string>())).toBe(request);
  });

  it("carries a withheld skill across requests on the same connection", () => {
    const target = findGatewayModel(SAMPLE_MODEL.codex)!;
    const withheldSkills = new Set<string>();
    const oversized = {
      model: "irrelevant",
      max_tokens: 8,
      messages: [{
        role: "user",
        content: `Base directory for this skill: /skills/huge\n${"x".repeat(4_000_000)}`,
      }],
    } as unknown as AnthropicMessagesRequest;

    applyGatewayRequestPolicy(oversized, target, withheldSkills);

    expect([...withheldSkills]).toEqual(["huge"]);
  });
});
