import { findGatewayModel, type GatewayModel } from "@dotobokuri/core-ai-gateway";
import { describe, expect, it } from "vitest";

import { EMBEDDED_AI_GATEWAY_ASSETS } from "../src/agent-cli/assets.generated.js";
import { buildGatewayLoadout } from "../src/ai-gateway/model-loadout.js";

/**
 * delegation의 온디맨드 심층 doctrine. SKILL.md 본문은 케이스 라우터로 남고,
 * 페이로드 판독·좌석 배정·표면 선택·런 스켈레톤은 사례가 살아 있을 때만 로드된다.
 */
const EXPECTED_DELEGATION_REFERENCES = [
  "loadout-reading.md",
  "seat-assignment.md",
  "decide.md",
  "implementation.md",
  "research.md",
  "review.md",
  "surfaces-and-flight.md",
] as const;

function resourceBody(relativePath: string): string {
  const asset = EMBEDDED_AI_GATEWAY_ASSETS.find((entry) => entry.relativePath === relativePath);
  expect(asset, `${relativePath} must be embedded`).toBeDefined();
  return asset!.content;
}

function catalogModel(id: string): GatewayModel {
  const found = findGatewayModel(id);
  if (!found) throw new Error(`missing catalog model: ${id}`);
  return found;
}

describe("Gateway policy resources", () => {
  it("keeps normalized quality evidence only at an exposed measured effort", () => {
    const model = catalogModel("codex--gpt-5.6-sol");
    const measured = model.benchmark!;
    const exposed = buildGatewayLoadout({
      exposed: [model],
      effortExposure: { [model.id]: [measured.effort] },
    });
    expect(exposed.providers.codex?.models[0]?.constraints.benchmark).toEqual(measured);

    const unmeasured = buildGatewayLoadout({
      exposed: [model],
      effortExposure: { [model.id]: ["low"] },
    });
    expect(unmeasured.providers.codex?.models[0]?.constraints.effortLadder).toEqual(["low"]);
    expect(unmeasured.providers.codex?.models[0]?.constraints.benchmark).toBeUndefined();
  });

  it("embeds the routing policies as MCP resources", () => {
    expect(EMBEDDED_AI_GATEWAY_ASSETS.map((entry) => entry.relativePath)).toEqual([
      "routing.md",
      ...EXPECTED_DELEGATION_REFERENCES,
      "professional-pushback.md",
    ].sort());
  });

  // 퇴역한 계약(핀 강제 게이트·agentType 금지·prefix 복사 규칙·Standing Orders)은
  // 어느 reference에도 되살아나면 안 된다 — 라이브 Workflow 계약과 즉시 모순된다.
  it.each(EXPECTED_DELEGATION_REFERENCES)("keeps retired dispatch-gate contracts out of %s", (relativePath) => {
    const content = resourceBody(relativePath);
    expect(content).not.toContain("claude-gateway--");
    expect(content).not.toContain("workflow-guard");
    expect(content).not.toContain("Model Pin Gate");
    expect(content).not.toContain("forbidden in dynamic workflow scripts");
    expect(content).not.toContain("Standing Order");
    expect(content).not.toContain("ultracode");
  });
});
