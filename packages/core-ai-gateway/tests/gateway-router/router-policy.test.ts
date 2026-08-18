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

const SHELL_FIRST = "Do your work through the Bash tool wherever it can accomplish the job: read"
  + " files with cat, head, or sed -n, search with grep and find, and make file changes with sed,"
  + " heredocs, or short scripts, rather than using the dedicated Read, Edit, or Write tools. Fall"
  + " back to a dedicated tool only when Bash genuinely cannot do the job.";

function requestFor(): AnthropicMessagesRequest {
  return {
    model: "irrelevant",
    max_tokens: 128,
    messages: [
      { role: "user", content: "Find the failing test." },
      { role: "user", content: `Listing tail\n\nWhile bypass permissions mode is active:\n\n${SHELL_FIRST}\n\ntail` },
    ],
    tools: [
      { name: "Read", input_schema: { type: "object", properties: {} } },
      { name: "Grep", input_schema: { type: "object", properties: {} } },
      { name: "Glob", input_schema: { type: "object", properties: {} } },
      { name: "WebSearch", input_schema: { type: "object", properties: {} } },
    ],
  } as unknown as AnthropicMessagesRequest;
}

function shapedFor(provider: GatewayProvider): {
  readonly tools: readonly string[];
  readonly keepsShellFirst: boolean;
} {
  const target = findGatewayModel(SAMPLE_MODEL[provider]);
  if (!target) throw new Error(`${provider}: sample model left the catalog`);
  const shaped = applyGatewayRequestPolicy(requestFor(), target, new Set<string>());
  return {
    tools: (shaped.tools ?? []).map((tool) => String((tool as { name?: unknown }).name)),
    keepsShellFirst: JSON.stringify(shaped.messages).includes("Do your work through the Bash tool"),
  };
}

describe("gateway request policy", () => {
  it("gives every catalog provider a policy that declares its own name", () => {
    for (const provider of GATEWAY_PROVIDERS) {
      const policy = resolveGatewayRequestPolicy(provider);
      expect(policy, `${provider} has no policy`).toBeDefined();
      expect(policy.provider).toBe(provider);
    }
  });

  // 도구 보류와 셸 우선 지시문은 한 결정의 양면이다. 한쪽만 바뀌면 모델은 검색할
  // 도구가 없는데 셸을 쓰라는 말도 못 듣거나, 쓰지 말라고 들은 카탈로그를 받는다.
  it.each([
    ["cursor", ["Read", "Grep", "Glob"], false],
    ["xai", ["Read", "Grep", "Glob"], false],
    ["opencode", ["Read", "Grep", "Glob"], false],
    ["codex", ["Read"], true],
    ["kimi", ["Read", "Grep", "Glob", "WebSearch"], true],
  ] as const)("shapes a %s request", (provider, tools, keepsShellFirst) => {
    const shaped = shapedFor(provider);

    expect(shaped.tools).toEqual(tools);
    expect(shaped.keepsShellFirst).toBe(keepsShellFirst);
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
