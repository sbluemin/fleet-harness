import { findGatewayModel, type GatewayModel } from "@dotobokuri/core-ai-gateway";
import { describe, expect, it } from "vitest";

import { EMBEDDED_AGENT_CLI_SKILL_ASSETS } from "../src/agent-cli/assets.generated.js";
import { buildGatewayLoadout } from "../src/ai-gateway/model-loadout.js";

const EXPECTED_SKILLS = [
  "delegation/SKILL.md",
  "professional-pushback/SKILL.md",
] as const;

/**
 * delegation의 온디맨드 심층 doctrine. SKILL.md 본문은 케이스 라우터로 남고,
 * 페이로드 판독·좌석 배정·표면 선택·런 스켈레톤은 사례가 살아 있을 때만 로드된다.
 */
const EXPECTED_DELEGATION_REFERENCES = [
  "delegation/references/loadout-reading.md",
  "delegation/references/seat-assignment.md",
  "delegation/references/shape-decide.md",
  "delegation/references/shape-implementation.md",
  "delegation/references/shape-research.md",
  "delegation/references/shape-review.md",
  "delegation/references/surfaces-and-flight.md",
] as const;

/**
 * references가 판독법을 가르치는 라이브 페이로드 필드. 이 목록은 양방향 계약이다:
 * 각 이름은 reference 본문에 등장해야 하고(문서가 필드를 버리면 red), 대표 로드아웃의
 * 직렬화 결과에도 키로 존재해야 한다(페이로드가 필드를 버리면 red). 문서와 페이로드가
 * 서로 모르게 늙는 것을 막는 것이 목적이므로, 필드를 옮기거나 없앨 때 함께 고친다.
 */
const TAUGHT_LOADOUT_FIELDS = [
  "agentTypes",
  "amounts",
  "benchmark",
  "cadence",
  "capabilityClass",
  "caveat",
  "contextWindow",
  "effortLadder",
  "homolineage",
  "isAggregate",
  "modelId",
  "paceRatio",
  "pressure",
  "projectedExhaustionAt",
  "providerPriority",
  "quotaScope",
  "recoveryHalfLifeMs",
  "revision",
  "routingTieBandPoints",
  "sourceScores",
  "usedPercent",
] as const;

function skillBody(relativePath: string): string {
  const asset = EMBEDDED_AGENT_CLI_SKILL_ASSETS.find((entry) => entry.relativePath === relativePath);
  expect(asset, `${relativePath} must be embedded`).toBeDefined();
  return asset!.content;
}

function catalogModel(id: string): GatewayModel {
  const found = findGatewayModel(id);
  if (!found) throw new Error(`missing catalog model: ${id}`);
  return found;
}

const WEEK_MS = 7 * 24 * 3_600_000;
const READ_AT = Date.UTC(2026, 7, 31);

/**
 * 가르친 필드가 전부 실릴 수 있는 최대치 픽스처: 스코프 창(파생 지표 포함)과 합산 창,
 * 벤치·caveat·quotaScope를 가진 모델, contextWindow를 가진 모델, 지출 우선순위.
 */
function representativeLoadout() {
  return buildGatewayLoadout({
    exposed: [catalogModel("cursor--grok-4.5"), catalogModel("codex--gpt-5.6-sol")],
    providerPriority: ["cursor"],
    quota: {
      cursor: {
        status: "ok",
        fetchedAt: READ_AT,
        windows: [
          {
            id: "cycle",
            scope: "auto",
            usedPercent: 90,
            resetsAt: READ_AT + WEEK_MS / 2,
            period: { durationMs: WEEK_MS, durationBasis: "upstream", startsAt: READ_AT - WEEK_MS / 2 },
            amounts: { used: "450", limit: "500" },
          },
          { id: "cycle-total", usedPercent: 40, isAggregate: true },
        ],
      },
    },
    now: () => READ_AT,
  });
}

describe("embedded Fleet skills", () => {
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

  it("embeds exactly the two selected on-demand skills and the delegation references", () => {
    expect(EMBEDDED_AGENT_CLI_SKILL_ASSETS.map((entry) => entry.relativePath)).toEqual([
      "delegation/SKILL.md",
      ...EXPECTED_DELEGATION_REFERENCES,
      "professional-pushback/SKILL.md",
    ]);
  });

  // 퇴역한 계약(핀 강제 게이트·agentType 금지·prefix 복사 규칙·Standing Orders)은
  // 어느 reference에도 되살아나면 안 된다 — 라이브 Workflow 계약과 즉시 모순된다.
  it.each(EXPECTED_DELEGATION_REFERENCES)("keeps retired dispatch-gate contracts out of %s", (relativePath) => {
    const content = skillBody(relativePath);
    expect(content).not.toContain("claude-gateway--");
    expect(content).not.toContain("workflow-guard");
    expect(content).not.toContain("Model Pin Gate");
    expect(content).not.toContain("forbidden in dynamic workflow scripts");
    expect(content).not.toContain("Standing Order");
    expect(content).not.toContain("ultracode");
  });
});
