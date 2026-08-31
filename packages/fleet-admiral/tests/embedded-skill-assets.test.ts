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
  "tokensPerTask",
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
  it("embeds exactly the two selected on-demand skills and the delegation references", () => {
    expect(EMBEDDED_AGENT_CLI_SKILL_ASSETS.map((entry) => entry.relativePath)).toEqual([
      "delegation/SKILL.md",
      ...EXPECTED_DELEGATION_REFERENCES,
      "professional-pushback/SKILL.md",
    ]);
  });

  it.each(EXPECTED_SKILLS)("keeps %s frontmatter aligned with its directory", (relativePath) => {
    const name = relativePath.split("/")[0]!;
    const content = skillBody(relativePath);
    expect(content).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---\\n`));
  });

  it("keeps Professional Pushback material, evidenced, and user-settled", () => {
    const content = skillBody("professional-pushback/SKILL.md");
    expect(content).toContain("State the objection plainly before executing");
    expect(content).toContain("concrete evidence or a checkable technical reason");
    expect(content).toContain("Match its force to the impact");
    expect(content).toContain("one actionable, clearly better alternative");
    expect(content).toContain("could materially change whether the objection holds");
    expect(content).toContain("treat it as settled even if they did not rebut the technical case");
    expect(content).toContain("do not add an unasked compromise");
    expect(content).toContain("previously unknown major failure mode");
    expect(content).toContain("equivalent trade-off");
    expect(content).not.toContain("Context Confidence");
    expect(content).not.toContain("assumption-audit");
  });

  it("keeps delegation focused on semantic execution-graph policy", () => {
    const content = skillBody("delegation/SKILL.md");
    expect(content).toContain("derive the smallest useful graph");
    expect(content).toContain("Dispatch only branches whose outputs can change the host's decision");
    expect(content).toContain("Keep decision and integration nodes on the host");
    expect(content).toContain("observable acceptance criterion");
    expect(content).toContain("Cancel branches whose information value has disappeared");
    expect(content).toContain("stop dispatching when the host has sufficient evidence to act");
    expect(content).toContain("propose branch may intentionally explore an open decision");
    expect(content).toContain("only reduces coverage");
    expect(content).toContain("Retry once only when the failure is plausibly transient");
    // 스킬은 로스터를 읽으라고만 말한다. 이름의 철자와 제약은 도구가 스스로 보고하므로
    // 여기에 옮겨 적으면 같은 사실이 두 곳에서 따로 늙는다.
    expect(content).toContain("call the Fleet MCP tool `gateway_models`");
    // 디스패치 게이트가 퇴역했으므로 정체성 선택의 의미 정책은 스킬이 홀로 진다: 무선택 상속의
    // 결과와 로스터 크기별 배분 규칙은 실으나, 핀 철자는 여전히 싣지 않는다.
    expect(content).toContain("No hook inspects a dispatch");
    expect(content).toContain("A dispatch that names no identity inherits the session's own model");
    expect(content).toContain("never fake variety by fusing providers or strengths into a single value");
    expect(content).not.toContain("a `meta.phases` entry's included");
    expect(content).not.toContain("agentTypes");
    expect(content).not.toContain("subagent_type");
    expect(content).not.toContain("modelId");
    expect(content).not.toContain("opts.model");
    expect(content).not.toContain("Pipeline by default");
    expect(content).not.toContain("Use a barrier only when");
    expect(content).not.toContain("workflow-implementing");
    expect(content).not.toContain("providerPriority");
  });

  it("keeps implementation and judgment on the host by default", () => {
    const content = skillBody("delegation/SKILL.md");
    expect(content).toContain("implementation normally is not");
    expect(content).toContain("Implementation delegation is an exception");
    expect(content).toContain("Implement directly on the host unless **all** of these are true");
    expect(content).toContain("inspect the actual diff");
    expect(content).toContain("Run results are inputs, not conversation turns");
  });

  it("keeps pin mechanics out of Professional Pushback", () => {
    const content = skillBody("professional-pushback/SKILL.md");
    expect(content).not.toContain("gateway_models");
    expect(content).not.toContain("subagent_type");
    expect(content).not.toContain("opts.model");
  });

  // 휘발성 랭킹 정책은 항상 로드되는 SKILL.md 본문이 아니라 온디맨드 references에 산다.
  it("keeps volatile ranking policy out of the delegation SKILL.md body", () => {
    const content = skillBody("delegation/SKILL.md");
    expect(content).not.toContain("providerPriority");
    expect(content).not.toContain("routingTieBandPoints");
    expect(content).not.toContain("usedPercent");
  });

  it("routes every delegation reference from the SKILL.md body", () => {
    const content = skillBody("delegation/SKILL.md");
    for (const reference of EXPECTED_DELEGATION_REFERENCES) {
      expect(content).toContain(reference.replace("delegation/", ""));
    }
  });

  it("keeps the references carrying the load-bearing doctrine", () => {
    const loadout = skillBody("delegation/references/loadout-reading.md");
    expect(loadout).toContain("Absence is never safety");
    expect(loadout).toContain("outranks arithmetic of your own");
    expect(loadout).toContain("one band, not an ordering");
    expect(loadout).toContain("serves no roster model by design");

    const seats = skillBody("delegation/references/seat-assignment.md");
    expect(seats).toContain("never filled from below the band");
    expect(seats).toContain("judge lineage against the subject");
    expect(seats).toContain("The task sets the branch count");
    expect(seats).toContain("Both measurements were closed tasks");

    const flight = skillBody("delegation/references/surfaces-and-flight.md");
    expect(flight).toContain("A receipt is not a result");
    expect(flight).toContain("return its failure as a value");
    expect(flight).toContain("Wiring is the only thing the staged surface buys");
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

  it("keeps every taught loadout field alive in both the references and the payload", () => {
    const references = EXPECTED_DELEGATION_REFERENCES
      .map((relativePath) => skillBody(relativePath))
      .join("\n");
    const serialized = JSON.stringify(representativeLoadout());
    for (const field of TAUGHT_LOADOUT_FIELDS) {
      expect(references, `references must still teach ${field}`).toContain(field);
      expect(serialized, `loadout payload must still carry ${field}`).toContain(`"${field}"`);
    }
  });
});
