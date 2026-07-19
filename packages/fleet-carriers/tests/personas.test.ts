import { beforeEach, describe, expect, it } from "vitest";
import type { CarrierMetadata } from "../src/index.js";
import {
  CARRIER_JOBS_SELF_CALL_HINT,
  PRIOR_JOBS_REQUEST_HINT,
  CHRONICLE_DEFAULTS,
  CHRONICLE_METADATA,
  GENESIS_DEFAULTS,
  GENESIS_METADATA,
  KIROV_DEFAULTS,
  KIROV_METADATA,
  NIMITZ_DEFAULTS,
  NIMITZ_METADATA,
  OHIO_DEFAULTS,
  OHIO_METADATA,
  SENTINEL_DEFAULTS,
  SENTINEL_METADATA,
  TEMPEST_DEFAULTS,
  TEMPEST_METADATA,
  VANGUARD_DEFAULTS,
  VANGUARD_METADATA,
  clearRegisteredCarriers,
  createCarrierRegistry,
  getRegisteredCarrierConfig,
  getRegisteredOrder,
  registerDefaultCarriers,
} from "../src/index.js";

interface PersonaCase {
  readonly name: string;
  readonly meta: CarrierMetadata;
}

const EXPECTED_IDS = [
  "nimitz",
  "kirov",
  "genesis",
  "ohio",
  "sentinel",
  "vanguard",
  "tempest",
  "chronicle",
] as const;

const EXPECTED_DEFAULTS = {
  genesis: { slot: 3, defaultModel: "sonnet", defaultEffort: "medium" },
  kirov: { slot: 2, defaultModel: "opus[1m]", defaultEffort: "xhigh" },
  nimitz: { slot: 1, defaultModel: "opus[1m]", defaultEffort: "max" },
  sentinel: { slot: 5, defaultModel: "sonnet", defaultEffort: "max" },
  vanguard: { slot: 6, defaultModel: "haiku", defaultEffort: "low" },
  tempest: { slot: 7, defaultModel: "sonnet", defaultEffort: "medium" },
  chronicle: { slot: 8, defaultModel: "sonnet", defaultEffort: "low" },
  ohio: { slot: 4, defaultModel: "sonnet", defaultEffort: "low" },
} as const;

const EXPECTED_CHRONICLE_EXECUTOR_TOOLS = [
  "wiki_briefing",
  "wiki_drydock",
  "wiki_ingest",
  "wiki_orient",
  "wiki_query",
  "wiki_read",
  "wiki_resolve",
  "wiki_schema_list",
  "wiki_schema_read",
  "carrier_jobs",
  "plan_read",
] as const;

const ALL_PERSONAS: readonly PersonaCase[] = [
  { name: "chronicle", meta: CHRONICLE_METADATA },
  { name: "genesis", meta: GENESIS_METADATA },
  { name: "kirov", meta: KIROV_METADATA },
  { name: "nimitz", meta: NIMITZ_METADATA },
  { name: "ohio", meta: OHIO_METADATA },
  { name: "sentinel", meta: SENTINEL_METADATA },
  { name: "tempest", meta: TEMPEST_METADATA },
  { name: "vanguard", meta: VANGUARD_METADATA },
];

const DEFAULT_PERSONAS = [
  { defaults: NIMITZ_DEFAULTS, meta: NIMITZ_METADATA },
  { defaults: KIROV_DEFAULTS, meta: KIROV_METADATA },
  { defaults: GENESIS_DEFAULTS, meta: GENESIS_METADATA },
  { defaults: OHIO_DEFAULTS, meta: OHIO_METADATA },
  { defaults: SENTINEL_DEFAULTS, meta: SENTINEL_METADATA },
  { defaults: VANGUARD_DEFAULTS, meta: VANGUARD_METADATA },
  { defaults: TEMPEST_DEFAULTS, meta: TEMPEST_METADATA },
  { defaults: CHRONICLE_DEFAULTS, meta: CHRONICLE_METADATA },
] as const;

describe("CARRIER_JOBS_SELF_CALL_HINT", () => {
  it("carrier_jobs full lookup과 summary fallback 서명을 포함", () => {
    expect(CARRIER_JOBS_SELF_CALL_HINT).toContain('format:"full"');
    expect(CARRIER_JOBS_SELF_CALL_HINT).toContain('format:"summary"');
  });

  for (const { name, meta } of ALL_PERSONAS) {
    it(`${name} persona principles에 self-call hint 포함`, () => {
      expect(meta.principles).toContain(CARRIER_JOBS_SELF_CALL_HINT);
    });
  }
});

describe("PRIOR_JOBS_REQUEST_HINT", () => {
  it("공유 prior_jobs 로스터 힌트가 full lookup과 summary fallback을 포함", () => {
    expect(PRIOR_JOBS_REQUEST_HINT).toContain('format:"full"');
    expect(PRIOR_JOBS_REQUEST_HINT).toContain('format:"summary"');
  });
});

describe("allowedExecutorTools", () => {
  it("chronicle은 schema list/read를 포함한 executor 도구를 정확히 선언", () => {
    expect(CHRONICLE_METADATA.allowedExecutorTools).toEqual(EXPECTED_CHRONICLE_EXECUTOR_TOOLS);
    expect(CHRONICLE_METADATA.allowedExecutorTools).not.toContain("wiki_schema_create");
  });

  it("모든 기본 persona가 carrier_jobs를 명시 선언", () => {
    for (const persona of DEFAULT_PERSONAS) {
      expect(persona.meta.allowedExecutorTools).toContain("carrier_jobs");
    }
  });
});

describe("Chronicle routing metadata", () => {
  it("keeps governed-knowledge routing Wiki-neutral", () => {
    expect(CHRONICLE_METADATA.title).toBe("Chief Knowledge Officer");
    expect(CHRONICLE_METADATA.summary).toBe("Documentation and governed knowledge stewardship.");
    expect(CHRONICLE_METADATA.whenToUse).toEqual([
      "[Codebase Doc] documentation creation, update, or post-change .md audit (including AGENTS.md, README, CHANGELOG)",
      "[Codebase Doc] PR summaries, release notes, API specs (OpenAPI/Swagger), change-impact summaries, breaking-change reports, migration guides",
      "[Governed Knowledge] structured knowledge entry proposal or revision",
    ]);
    expect(CHRONICLE_METADATA.whenNotToUse).toEqual([
      "before implementation and verification are complete",
      "code modification (→genesis) or code review (→sentinel)",
      "architectural judgment (→nimitz) or release-scope planning decisions (→kirov)",
    ]);

    const routingFields = [
      CHRONICLE_METADATA.title,
      CHRONICLE_METADATA.summary,
      ...CHRONICLE_METADATA.whenToUse,
      ...CHRONICLE_METADATA.whenNotToUse,
    ].join("\n");
    expect(routingFields).not.toMatch(/wiki/i);
    expect(CHRONICLE_METADATA.allowedExecutorTools).toEqual(EXPECTED_CHRONICLE_EXECUTOR_TOOLS);
  });
});

describe("Task Force capability defaults", () => {
  it("only nimitz, vanguard, and tempest source-own the capability marker", () => {
    const capable = DEFAULT_PERSONAS
      .filter((persona) => persona.defaults.taskForceCapable === true)
      .map((persona) => persona.defaults.id);

    expect(capable).toEqual(["nimitz", "vanguard", "tempest"]);
  });
});

describe("allowedBuiltinExternalMcpServers", () => {
  it("tempest만 grep_app builtin external MCP를 명시 허용", () => {
    expect(TEMPEST_METADATA.allowedBuiltinExternalMcpServers).toEqual(["grep_app"]);
  });

  it("나머지 7개 carrier는 builtin external MCP를 열지 않는다", () => {
    for (const { name, meta } of ALL_PERSONAS) {
      if (name === "tempest") continue;
      expect(meta.allowedBuiltinExternalMcpServers ?? []).toHaveLength(0);
    }
  });
});

describe("persona defaults", () => {
  it("각 persona 파일이 예상 8개 carrier 기본값을 소유", () => {
    expect(DEFAULT_PERSONAS.map((persona) => persona.defaults.id)).toEqual(EXPECTED_IDS);
  });

  it("모든 기본 persona의 cli, slot, 모델, effort 기본값을 보존", () => {
    for (const persona of DEFAULT_PERSONAS) {
      const id = persona.defaults.id as keyof typeof EXPECTED_DEFAULTS;
      expect(persona.defaults.slot).toBe(EXPECTED_DEFAULTS[id].slot);
      expect(persona.defaults.agent.dispatch).toEqual({
        defaultCliType: "claude",
        defaultModel: EXPECTED_DEFAULTS[id].defaultModel,
        defaultEffort: EXPECTED_DEFAULTS[id].defaultEffort,
      });
    }
  });

  for (const persona of DEFAULT_PERSONAS) {
    it(`${persona.defaults.id} requestBlocks 구조가 유효하고 prior_jobs를 반복하지 않음`, () => {
      const tags = persona.meta.requestBlocks.map((block) => block.tag);
      expect(new Set(tags).size).toBe(tags.length);
      expect(tags).not.toContain("prior_jobs");
      for (const block of persona.meta.requestBlocks) {
        expect(block.hint.trim().length).toBeGreaterThan(0);
      }
    });
  }
});

describe("Kirov and Ohio TaskRef execution contract", () => {
  it("Kirov writes one lint-valid Fleet Plan and returns Lane-grouped TaskRefs", () => {
    const template = (KIROV_METADATA.principles ?? []).find((principle) =>
      principle.startsWith("The Plan submitted to plan_write MUST contain this exact default Markdown template"),
    ) ?? "";

    expect(KIROV_METADATA.summary).toContain("lint-valid Fleet Plans");
    expect(KIROV_METADATA.outputFormat).toContain("**Execution Topology**");
    expect(KIROV_METADATA.outputFormat).toContain("**Dispatch Manifest**");
    expect(KIROV_METADATA.outputFormat).toContain("**TaskRefs**");
    expect(KIROV_METADATA.requestBlocks).toContainEqual({
      tag: "plan_id",
      hint: "Required stable lowercase Plan identity. Kirov passes this logical id to plan_write and returns the resulting PlanRef; never accept or invent a filesystem path.",
      required: true,
    });
    expect(KIROV_METADATA.permissions).toContain(
      "Every Kirov dispatch with the required plan_id is a Plan-tool mission. Its primary completion goal is submitting one complete Markdown Plan to plan_write, correcting every deterministic lint error, and verifying the returned PlanRef with plan_read; analysis or a report alone is never completion.",
    );
    expect(KIROV_METADATA.allowedExecutorTools).toEqual(["carrier_jobs", "plan_read", "plan_write"]);
    expect(KIROV_METADATA.principles).toContain(
      "Execution Topology is mandatory for every plan. It MUST declare Execution mode: Sequential | Parallel, shared mutable resources, ordered waves, and stable Wave/Lane IDs; a lane may be marked parallel only when its exact non-overlapping write set and read dependencies prove it is safe to run concurrently.",
    );
    expect(KIROV_METADATA.principles).toContain(
      "Dispatch Manifest is mandatory for every plan. For each lane, declare: stable Wave/Lane ID; exact write set; read dependencies; dependency/start condition; eligible concurrent lanes; integration gate; handoff; and rollback unit. It MUST state that full-plan Ohio invocation is unavailable and that the host dispatches explicit same-Lane TaskRefs only. If disjoint lanes cannot be proven safe, mark the work sequential rather than calling it parallel.",
    );
    expect(template).toContain("# Execution Topology, - Execution mode: Sequential | Parallel, - Shared mutable resources:");
    expect(template).toContain("# Waves, ## Wave N — <name>, ### Lane WN-X — <name>");
    expect(template).toContain("- Exact write set:, - Read dependencies:, - Dependency/start condition:");
    expect(template).toContain("- Eligible concurrent lanes: (use \"none\" for serialized work), - Integration gate:, - Handoff:, - Rollback unit:");
    expect(template.indexOf("# Waves")).toBeLessThan(template.indexOf("# Dispatch Manifest"));
    expect(template).toContain("# Dispatch Manifest, - Full-plan Ohio invocation: unavailable; dispatch explicit same-Lane TaskRefs only");
    expect(template).toContain("- Lane WN-X — <name>: exact write set, read dependencies, dependency/start condition, eligible concurrent lanes, integration gate, handoff, and rollback unit summary for dispatch");
    expect(template).toContain("nested '- [ ] WN-X-TN — <step>' tasks");
  });

  it("Ohio accepts exactly one Plan/Lane TaskRef group and marks it through the Plan tool", () => {
    expect(OHIO_METADATA.requestBlocks).toContainEqual({
      tag: "task_refs",
      hint: "Required newline- or comma-delimited fully qualified TaskRefs from exactly one Plan and one Lane. Ohio calls plan_read once at dispatch start with the complete set and executes only the returned selected_tasks.",
      required: true,
    });
    expect(OHIO_METADATA.allowedExecutorTools).toEqual(["carrier_jobs", "plan_read", "plan_mark_tasks"]);
    expect(OHIO_METADATA.permissions).toContain(
      "MUST call plan_read exactly once at the start of each dispatch with the complete assigned TaskRef set. Re-read only after a Plan tool reports a Plan-state conflict or the host explicitly redirects; invalid, missing, cross-Plan, or cross-Lane TaskRefs are blockers.",
    );
    expect(OHIO_METADATA.principles).toContain(
      "Treat compact plan_context as the forest: its Objective, topology, current progress, global QA gates, acceptance criteria, documentation updates, and final review loop govern the mission. Treat lane_context and selected_tasks as the only executable scope and write authority.",
    );
    expect(OHIO_METADATA.permissions).toContain(
      "MUST call plan_mark_tasks with exactly the assigned TaskRefs only after every assigned task and the Lane QA/integration gate pass. Never edit Plan Markdown or checkbox state through filesystem tools.",
    );
    expect(OHIO_METADATA.outputFormat).toContain("**TaskRefs executed**");
    expect(OHIO_METADATA.outputFormat).toContain("**Lane**");
  });
});

describe("explicit default registration", () => {
  const registry = createCarrierRegistry();

  beforeEach(() => {
    clearRegisteredCarriers(registry);
  });

  it("registerDefaultCarriers()가 전달된 registry에 기본 carrier를 등록", () => {
    registerDefaultCarriers(registry);
    expect(getRegisteredOrder(registry)).toEqual(EXPECTED_IDS);
    for (const id of EXPECTED_IDS) {
      const config = getRegisteredCarrierConfig(registry, id);
      const expected = DEFAULT_PERSONAS.find((persona) => persona.defaults.id === id);
      expect(config?.carrierMetadata?.title).toBe(
        expected?.meta.title,
      );
      expect(config?.defaultCliType).toBe(expected?.defaults.agent.dispatch.defaultCliType);
    }
  });

});
