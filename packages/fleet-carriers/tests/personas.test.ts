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
  "carrier_jobs",
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
  it("chronicle은 wiki 도구 7종과 carrier_jobs를 정확히 선언", () => {
    expect(CHRONICLE_METADATA.allowedExecutorTools).toEqual(EXPECTED_CHRONICLE_EXECUTOR_TOOLS);
  });

  it("모든 기본 persona가 carrier_jobs를 명시 선언", () => {
    for (const persona of DEFAULT_PERSONAS) {
      expect(persona.meta.allowedExecutorTools).toContain("carrier_jobs");
    }
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

describe("Kirov and Ohio parallel execution contract", () => {
  it("Kirov requires one plan SSoT plus an Execution Topology and Dispatch Manifest", () => {
    const template = (KIROV_METADATA.principles ?? []).find((principle) =>
      principle.startsWith("The .fleet/plans/*.md file MUST contain this exact default Markdown template"),
    ) ?? "";

    expect(KIROV_METADATA.summary).toContain("one executable .fleet/plans/*.md plan_file SSoT");
    expect(KIROV_METADATA.outputFormat).toContain("**Execution Topology**");
    expect(KIROV_METADATA.outputFormat).toContain("**Dispatch Manifest**");
    expect(KIROV_METADATA.permissions).toContain(
      "MUST honor exact provided .fleet/plans/*.md paths. Keep one plan_file as the execution SSoT: Success means creating or updating that executable plan_file unless the Admiral explicitly requests draft-only work. Do not create split plan files for parallel lanes.",
    );
    expect(KIROV_METADATA.principles).toContain(
      "Execution Topology is mandatory for every plan. It MUST declare Execution mode: Sequential | Parallel, shared mutable resources, ordered waves, and stable Wave/Lane IDs; a lane may be marked parallel only when its exact non-overlapping write set and read dependencies prove it is safe to run concurrently.",
    );
    expect(KIROV_METADATA.principles).toContain(
      "Dispatch Manifest is mandatory for every plan. For each parallel lane, declare: stable Wave/Lane ID; exact non-overlapping write set; read dependencies; dependency/start condition; eligible concurrent lanes; integration gate; handoff; and rollback unit. It MUST also state that full-plan Ohio invocation (execution_scope omitted or all) is allowed sequentially only for Sequential or absent Execution Topology; Parallel requires exact Lane IDs, makes full-plan invocation unavailable as an alternative dispatch path, and never combines it with lane jobs. If disjoint lanes cannot be proven safe, mark the work sequential rather than calling it parallel.",
    );
    expect(template).toContain("# Execution Topology, - Execution mode: Sequential | Parallel, - Shared mutable resources:");
    expect(template).toContain("# Waves, ## Wave N — <name>, ### Lane WN-X — <name>");
    expect(template).toContain("- Exact write set:, - Read dependencies:, - Dependency/start condition:");
    expect(template).toContain("- Eligible concurrent lanes: (use \"none\" for serialized work), - Integration gate:, - Handoff:, - Rollback unit:");
    expect(template.indexOf("# Waves")).toBeLessThan(template.indexOf("# Dispatch Manifest"));
    expect(template).toContain("# Dispatch Manifest, - Full-plan Ohio invocation (execution_scope omitted or all): allowed sequentially only when Execution mode is Sequential or Execution Topology is absent; for Parallel, dispatch exact Lane IDs only and never combine a full-plan invocation with lane jobs");
    expect(template).toContain("- Lane WN-X — <name>: exact write set, read dependencies, dependency/start condition, eligible concurrent lanes, integration gate, handoff, and rollback unit summary for dispatch");
  });

  it("Ohio accepts only manifest-declared execution scopes and preserves unscoped sequential execution", () => {
    expect(OHIO_METADATA.requestBlocks).toContainEqual({
      tag: "execution_scope",
      hint: "Optional: for legacy plans without Execution Topology or plans marked Execution mode: Sequential, omitted or `all` executes the full plan sequentially. For Execution mode: Parallel, provide one exact Wave/Lane ID declared by the Dispatch Manifest; omitted or `all` is rejected. Never combine a full-plan invocation with scoped-lane Ohio invocation(s).",
      required: false,
    });
    expect(OHIO_METADATA.permissions).toContain(
      "MUST read the plan's Execution Topology before resolving execution_scope. For legacy plans without Execution Topology or plans marked Execution mode: Sequential, omitted scope or `all` executes the full plan sequentially. For Execution mode: Parallel, require one exact Dispatch Manifest Wave/Lane ID and reject omitted or `all` scope rather than silently serializing available parallelism. A full-plan invocation (omitted or `all`) MUST NEVER be used alongside scoped-lane Ohio invocation(s).",
    );
    expect(OHIO_METADATA.principles).toContain(
      "Read Execution Topology before resolving execution_scope. For legacy plans without Execution Topology or Execution mode: Sequential, omitted scope or `all` retains full-plan sequential compatibility. For Execution mode: Parallel, require one exact manifest-declared Wave/Lane ID and reject omitted or `all` scope rather than silently serializing available parallelism. Never use a full-plan invocation alongside scoped-lane Ohio invocation(s).",
    );
    expect(OHIO_METADATA.principles).toContain(
      "For a lane scope, change only that lane's declared write set. Never edit plan_file or execute another lane. Before execution, satisfy the lane's dependency/start condition and required predecessor integration gates; after execution, satisfy that lane's own QA/integration gate before reporting it eligible to release downstream work.",
    );
    expect(OHIO_METADATA.outputFormat).toContain("**Execution scope** — `all` or the exact Wave/Lane ID executed");
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
