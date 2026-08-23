import { describe, expect, it } from "vitest";

import {
  applyGatewayRequestPolicy,
  resolveGatewayRequestPolicy,
} from "../../src/router/request-policy.js";
import { GATEWAY_PROVIDERS, findGatewayModel } from "../../src/models.js";
import type { GatewayProvider } from "../../src/models.js";
import type { AnthropicMessagesRequest } from "../../src/downstream/wire/anthropic-messages/protocol.js";

/**
 * One catalog model per provider, so every policy runs against a real target.
 *
 * Bare catalog ids: a provider policy is decided by the upstream it shapes for, and
 * the downstream harness that published the id has already been resolved away by the
 * time the router asks a policy anything.
 */
const SAMPLE_MODEL: Readonly<Record<GatewayProvider, string>> = {
  antigravity: "antigravity--gemini-3.7-flash",
  codex: "codex--gpt-5.6-sol",
  cursor: "cursor--grok-4.5",
  kimi: "kimi--k3",
  opencode: "opencode--minimax-m3",
  xai: "xai--grok-4.6",
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
    ["codex", ["Read", "Grep", "Glob"]],
    ["kimi", ["Read", "Grep", "Glob", "WebSearch"]],
  ] as const)("shapes a %s request", (provider, tools) => {
    expect(toolsFor(provider)).toEqual(tools);
  });

  it("downgrades a tool_choice pinned to a tool the policy withheld", () => {
    const target = findGatewayModel(SAMPLE_MODEL.codex)!;
    const request = { ...requestFor(), tool_choice: { type: "tool", name: "WebSearch" } };

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
  // Every gateway provider must declare the strip. A provider added without it fails here
  // rather than quietly forwarding Anthropic's identity and telemetry to a third party.
  it.each(GATEWAY_PROVIDERS)("strips Anthropic client identity and billing for %s", (provider) => {
    const target = findGatewayModel(SAMPLE_MODEL[provider])!;
    const prompt = { type: "text", text: "You are an interactive agent." };
    const request = {
      model: "irrelevant",
      max_tokens: 8,
      messages: [{ role: "user", content: "Hello" }],
      system: [
        { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.239.707; cc_entrypoint=cli;" },
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
        prompt,
      ],
    } as unknown as AnthropicMessagesRequest;

    const shaped = applyGatewayRequestPolicy(request, target, new Set<string>());

    expect(shaped.system).toEqual([prompt]);
  });

  it("leaves a system prompt carrying no client metadata untouched", () => {
    const target = findGatewayModel(SAMPLE_MODEL.xai)!;
    const system = [{ type: "text", text: "You are a terse assistant." }];
    const request = {
      model: "irrelevant",
      max_tokens: 8,
      messages: [{ role: "user", content: "Hello" }],
      system,
    } as unknown as AnthropicMessagesRequest;

    expect(applyGatewayRequestPolicy(request, target, new Set<string>()).system).toBe(system);
  });
});
