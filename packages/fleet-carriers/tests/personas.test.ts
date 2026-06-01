import { beforeEach, describe, expect, it } from "vitest";
import type { CarrierMetadata } from "../src/index.js";
import {
  CARRIER_JOBS_SELF_CALL_HINT,
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
      expect(persona.defaults.defaultModel).toBe(EXPECTED_DEFAULTS[id].defaultModel);
      expect(persona.defaults.defaultEffort).toBe(EXPECTED_DEFAULTS[id].defaultEffort);
    }
  });

  for (const persona of DEFAULT_PERSONAS) {
    it(`${persona.defaults.id} requestBlocks 구조가 유효하고 prior_jobs를 명시 포함`, () => {
      const tags = persona.meta.requestBlocks.map((block) => block.tag);
      expect(new Set(tags).size).toBe(tags.length);
      expect(tags).toContain("prior_jobs");
      for (const block of persona.meta.requestBlocks) {
        expect(block.hint.trim().length).toBeGreaterThan(0);
      }
    });
  }
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
      expect(config?.subagent?.defaultModel).toBe(expected?.defaults.defaultModel);
      expect(config?.subagent?.defaultEffort).toBe(expected?.defaults.defaultEffort);
    }
  });
});
