import { describe, expect, it } from "vitest";
import { admiral, type CarrierMetadata } from "@sbluemin/fleet-core";
import {
  CARRIER_JOBS_SELF_CALL_HINT,
  CHRONICLE_METADATA,
  DEFAULT_CARRIER_PERSONAS,
  GENESIS_METADATA,
  KIROV_METADATA,
  NIMITZ_METADATA,
  OHIO_METADATA,
  SENTINEL_METADATA,
  TEMPEST_METADATA,
  VANGUARD_METADATA,
} from "../src/index.js";

interface PersonaCase {
  readonly name: string;
  readonly meta: CarrierMetadata;
}

const EXPECTED_IDS = [
  "genesis",
  "kirov",
  "nimitz",
  "sentinel",
  "vanguard",
  "tempest",
  "chronicle",
  "ohio",
] as const;

const EXPECTED_DEFAULTS = {
  genesis: { slot: 3, defaultModel: "sonnet", defaultEffort: "medium" },
  kirov: { slot: 2, defaultModel: "opus[1m]", defaultEffort: "xhigh" },
  nimitz: { slot: 1, defaultModel: "opus[1m]", defaultEffort: "max" },
  sentinel: { slot: 5, defaultModel: "sonnet", defaultEffort: "max" },
  vanguard: { slot: 6, defaultModel: "haiku", defaultEffort: "low" },
  tempest: { slot: 7, defaultModel: "haiku", defaultEffort: "medium" },
  chronicle: { slot: 8, defaultModel: "sonnet", defaultEffort: "medium" },
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
  it("chronicle만 7개 wiki tool ID를 정확히 선언하고 carrier_jobs는 열거하지 않음", () => {
    expect(CHRONICLE_METADATA.allowedExecutorTools).toEqual(EXPECTED_CHRONICLE_EXECUTOR_TOOLS);
    expect(CHRONICLE_METADATA.allowedExecutorTools).not.toContain("carrier_jobs");
  });

  it("chronicle 외 기본 persona는 allowedExecutorTools를 선언하지 않음", () => {
    for (const persona of DEFAULT_CARRIER_PERSONAS) {
      if (persona.options.id === "chronicle") continue;
      expect(persona.metadata.allowedExecutorTools ?? null).toBeNull();
    }
  });
});

describe("DEFAULT_CARRIER_PERSONAS", () => {
  it("예상 8개 carrier id를 같은 순서로 포함", () => {
    expect(DEFAULT_CARRIER_PERSONAS.map((persona) => persona.options.id)).toEqual(EXPECTED_IDS);
  });

  it("모든 기본 persona의 cli, slot, 모델, effort 기본값을 보존", () => {
    for (const persona of DEFAULT_CARRIER_PERSONAS) {
      const id = persona.options.id as keyof typeof EXPECTED_DEFAULTS;
      expect(persona.cli).toBe("claude");
      expect(persona.options.slot).toBe(EXPECTED_DEFAULTS[id].slot);
      expect(persona.options.defaultModel).toBe(EXPECTED_DEFAULTS[id].defaultModel);
      expect(persona.options.defaultEffort).toBe(EXPECTED_DEFAULTS[id].defaultEffort);
    }
  });

  for (const persona of DEFAULT_CARRIER_PERSONAS) {
    it(`${persona.options.id} requestBlocks 구조가 유효`, () => {
      const tags = persona.metadata.requestBlocks.map((block) => block.tag);
      expect(new Set(tags).size).toBe(tags.length);
      for (const block of persona.metadata.requestBlocks) {
        expect(block.hint.trim().length).toBeGreaterThan(0);
      }
    });
  }
});

describe("module-load self-registration", () => {
  it("@sbluemin/fleet-carriers import가 fleet-core carrier facade에 기본 carrier를 등록", () => {
    for (const id of EXPECTED_IDS) {
      const config = admiral.carrier.getRegisteredCarrierConfig(id);
      expect(config?.carrierMetadata?.title).toBe(
        DEFAULT_CARRIER_PERSONAS.find((persona) => persona.options.id === id)?.metadata.title,
      );
    }
  });
});
