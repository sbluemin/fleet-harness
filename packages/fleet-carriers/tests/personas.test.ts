import { beforeEach, describe, expect, it } from "vitest";
import type { CarrierMetadata } from "../src/index.js";
import {
  CARRIER_JOBS_SELF_CALL_HINT,
  PRIOR_JOBS_REQUEST_HINT,
  GENESIS_DEFAULTS,
  GENESIS_METADATA,
  NIMITZ_DEFAULTS,
  NIMITZ_METADATA,
  SENTINEL_DEFAULTS,
  SENTINEL_METADATA,
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
  "genesis",
  "sentinel",
  "vanguard",
] as const;

const EXPECTED_DEFAULTS = {
  genesis: { slot: 2, defaultModel: "sonnet", defaultEffort: "medium" },
  nimitz: { slot: 1, defaultModel: "opus[1m]", defaultEffort: "max" },
  sentinel: { slot: 3, defaultModel: "sonnet", defaultEffort: "max" },
  vanguard: { slot: 4, defaultModel: "haiku", defaultEffort: "low" },
} as const;

const ALL_PERSONAS: readonly PersonaCase[] = [
  { name: "genesis", meta: GENESIS_METADATA },
  { name: "nimitz", meta: NIMITZ_METADATA },
  { name: "sentinel", meta: SENTINEL_METADATA },
  { name: "vanguard", meta: VANGUARD_METADATA },
];

const DEFAULT_PERSONAS = [
  { defaults: NIMITZ_DEFAULTS, meta: NIMITZ_METADATA },
  { defaults: GENESIS_DEFAULTS, meta: GENESIS_METADATA },
  { defaults: SENTINEL_DEFAULTS, meta: SENTINEL_METADATA },
  { defaults: VANGUARD_DEFAULTS, meta: VANGUARD_METADATA },
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
  it("모든 기본 persona가 carrier_jobs를 명시 선언", () => {
    for (const persona of DEFAULT_PERSONAS) {
      expect(persona.meta.allowedExecutorTools).toContain("carrier_jobs");
    }
  });
});

describe("Task Force capability defaults", () => {
  it("only nimitz and vanguard source-own the capability marker", () => {
    const capable = DEFAULT_PERSONAS
      .filter((persona) => persona.defaults.taskForceCapable === true)
      .map((persona) => persona.defaults.id);

    expect(capable).toEqual(["nimitz", "vanguard"]);
  });
});

describe("allowedBuiltinExternalMcpServers", () => {
  it("vanguard만 grep_app builtin external MCP를 명시 허용", () => {
    expect(VANGUARD_METADATA.allowedBuiltinExternalMcpServers).toEqual(["grep_app"]);
  });

  it("나머지 carrier는 builtin external MCP를 열지 않는다", () => {
    for (const { name, meta } of ALL_PERSONAS) {
      if (name === "vanguard") continue;
      expect(meta.allowedBuiltinExternalMcpServers ?? []).toHaveLength(0);
    }
  });
});

describe("persona defaults", () => {
  it("각 persona 파일이 예상 4개 carrier 기본값을 소유", () => {
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

describe("Vanguard local and remote reconnaissance contract", () => {
  it("keeps the settled identity, routing, tools, and request contract", () => {
    expect(VANGUARD_DEFAULTS).toEqual({
      id: "vanguard",
      displayName: "Vanguard",
      slot: 4,
      taskForceCapable: true,
      agent: {
        dispatch: {
          defaultCliType: "claude",
          defaultModel: "haiku",
          defaultEffort: "low",
        },
      },
    });
    expect(VANGUARD_METADATA.title).toBe("Reconnaissance Specialist");
    expect(VANGUARD_METADATA.summary).toBe("Read-only codebase intelligence — explores local and remote repositories, traces symbols, searches public code and web sources, and deep-dives unfamiliar implementations.");
    expect(VANGUARD_METADATA.whenToUse).toEqual([
      "local or remote codebase reconnaissance — exploration, multi-file scanning, symbol tracing",
      "upstream or external repository investigation through APIs, public code search, or temporary clones",
      "API and SDK usage examples, web research, and external knowledge gathering",
      "preparation for host planning or heavier operations (Nimitz, Genesis) requiring code intelligence first",
    ]);
    expect(VANGUARD_METADATA.whenNotToUse).toEqual([
      "ANY code modification or file editing (→genesis)",
      "architecture, product, or trade-off decisions (→nimitz)",
    ]);
    expect(VANGUARD_METADATA.requestBlocks).toEqual([
      { tag: "objective", required: true, hint: "What codebase intelligence is needed — question to answer, behavior to trace, or target to locate." },
      { tag: "search_space", required: false, hint: "Local directories or files, repository references or URLs, and domains to inspect." },
      { tag: "hints", required: false, hint: "Known symbols, paths, branches or tags, keywords, file patterns, or prior findings to narrow the scan." },
      { tag: "constraints", required: false, hint: "Source or version requirements, time limits, and areas or sources to exclude." },
      { tag: "depth", required: false, hint: "'quick' for surface scan, 'thorough' for exhaustive. Default: 'medium'." },
    ]);
    expect(VANGUARD_METADATA.allowedExecutorTools).toEqual(["carrier_jobs"]);
    expect(VANGUARD_METADATA.allowedBuiltinExternalMcpServers).toEqual(["grep_app"]);
  });

  it("keeps the settled permissions, evidence rules, and output fields", () => {
    expect(VANGUARD_METADATA.permissions).toEqual([
      "CRITICAL: Analysis-only. NEVER modify user or project files, write code, commit, push, or execute mutating commands against an analyzed source.",
      "Full access to read local codebases and execute read-only commands for exploration.",
      "MUST use grep_app for public code search only; MUST NOT query secrets, internal code, or private repo content.",
      "For GitHub sources, may use gh CLI for read-only API interactions; for other sources, use available read-only APIs, web access, or a temporary clone.",
      "CRITICAL: When cloning, MUST use an OS-native temporary directory (e.g., mktemp -d). NEVER clone into the current working directory or any project path. MUST clean up the cloned directory after analysis.",
      "Choose the least invasive evidence path that satisfies the requested depth: existing local source, read-only API or public search, then temporary clone.",
      "If the request fails (timeout/rate limit/connection error), retry up to 3 times before reporting failure.",
    ]);
    expect(VANGUARD_METADATA.principles).toEqual([
      CARRIER_JOBS_SELF_CALL_HINT,
      "For local sources, use absolute file paths with line references; for remote sources, name the repository or source reference and use source-relative paths with line references whenever available.",
      "Keep local and remote evidence clearly labeled.",
    ]);
    for (const field of ["**Thoroughness**", "**Findings**", "**Confidence level**"]) {
      expect(VANGUARD_METADATA.outputFormat).toContain(field);
    }
    expect(VANGUARD_METADATA.outputFormat).toContain("Identify every source used.");
    expect(VANGUARD_METADATA.outputFormat).toContain("Keep each code snippet under 20 lines.");
    expect(VANGUARD_METADATA.outputFormat).toContain("**Source overview**");
    expect(VANGUARD_METADATA.outputFormat).toContain("**Key observations**");
    expect(VANGUARD_METADATA.outputFormat).toContain("Never recommend application, infer intent, or suggest follow-up actions");
  });
});

describe("Nimitz and Genesis surviving contracts", () => {
  it("keeps Nimitz strategic and read-only", () => {
    expect(NIMITZ_METADATA.title).toBe("Strategic Command & Judgment");
    expect(NIMITZ_METADATA.requestBlocks).toEqual([
      expect.objectContaining({ tag: "context", required: true }),
      expect.objectContaining({ tag: "problem", required: true }),
      expect.objectContaining({ tag: "constraints", required: false }),
      expect.objectContaining({ tag: "artifacts", required: false }),
    ]);
    expect(NIMITZ_METADATA.allowedExecutorTools).toEqual(["carrier_jobs"]);
    expect(NIMITZ_METADATA.outputFormat).toContain("**Bottom line**");
    expect(NIMITZ_METADATA.outputFormat).toContain("**Action plan** — Numbered strategic next actions for the host.");
    expect(NIMITZ_METADATA.outputFormat).toContain("Never decompose into implementation tasks, waves, or delivery checklists.");
    expect(NIMITZ_METADATA.outputFormat).not.toContain("Numbered implementation steps.");
  });

  it("Genesis keeps required objective and scope", () => {
    expect(GENESIS_DEFAULTS.agent.dispatch).toEqual({
      defaultCliType: "claude",
      defaultModel: "sonnet",
      defaultEffort: "medium",
    });
    expect(GENESIS_METADATA.requestBlocks).toContainEqual({
      tag: "objective",
      hint: "What needs to be built or achieved. Be specific about the desired end state.",
      required: true,
    });
    expect(GENESIS_METADATA.requestBlocks).toContainEqual({
      tag: "scope",
      hint: "Which modules, directories, or subsystems are in play.",
      required: true,
    });
    expect(GENESIS_METADATA.allowedExecutorTools).toEqual(["carrier_jobs"]);
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
