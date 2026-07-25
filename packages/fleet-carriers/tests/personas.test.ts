import { beforeEach, describe, expect, it } from "vitest";
import type { CarrierMetadata } from "../src/index.js";
import {
  CARRIER_JOBS_SELF_CALL_HINT,
  PRIOR_JOBS_REQUEST_HINT,
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
] as const;

const EXPECTED_DEFAULTS = {
  genesis: { slot: 3, defaultModel: "sonnet", defaultEffort: "medium" },
  kirov: { slot: 2, defaultModel: "opus[1m]", defaultEffort: "xhigh" },
  nimitz: { slot: 1, defaultModel: "opus[1m]", defaultEffort: "max" },
  sentinel: { slot: 5, defaultModel: "sonnet", defaultEffort: "max" },
  vanguard: { slot: 6, defaultModel: "haiku", defaultEffort: "low" },
  ohio: { slot: 4, defaultModel: "sonnet", defaultEffort: "low" },
} as const;

const ALL_PERSONAS: readonly PersonaCase[] = [
  { name: "genesis", meta: GENESIS_METADATA },
  { name: "kirov", meta: KIROV_METADATA },
  { name: "nimitz", meta: NIMITZ_METADATA },
  { name: "ohio", meta: OHIO_METADATA },
  { name: "sentinel", meta: SENTINEL_METADATA },
  { name: "vanguard", meta: VANGUARD_METADATA },
];

const DEFAULT_PERSONAS = [
  { defaults: NIMITZ_DEFAULTS, meta: NIMITZ_METADATA },
  { defaults: KIROV_DEFAULTS, meta: KIROV_METADATA },
  { defaults: GENESIS_DEFAULTS, meta: GENESIS_METADATA },
  { defaults: OHIO_DEFAULTS, meta: OHIO_METADATA },
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
  it("only nimitz, kirov, and vanguard source-own the capability marker", () => {
    const capable = DEFAULT_PERSONAS
      .filter((persona) => persona.defaults.taskForceCapable === true)
      .map((persona) => persona.defaults.id);

    expect(capable).toEqual(["nimitz", "kirov", "vanguard"]);
  });
});

describe("allowedBuiltinExternalMcpServers", () => {
  it("vanguard만 grep_app builtin external MCP를 명시 허용", () => {
    expect(VANGUARD_METADATA.allowedBuiltinExternalMcpServers).toEqual(["grep_app"]);
  });

  it("나머지 5개 carrier는 builtin external MCP를 열지 않는다", () => {
    for (const { name, meta } of ALL_PERSONAS) {
      if (name === "vanguard") continue;
      expect(meta.allowedBuiltinExternalMcpServers ?? []).toHaveLength(0);
    }
  });
});

describe("persona defaults", () => {
  it("각 persona 파일이 예상 6개 carrier 기본값을 소유", () => {
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
      slot: 6,
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
      "preparation for host planning or heavier operations (Nimitz, Genesis, Kirov audit) requiring code intelligence first",
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
    expect(VANGUARD_METADATA.allowedExecutorTools).toEqual(["carrier_jobs", "plan_read"]);
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

describe("Kirov assurance and Ohio TaskRef execution contract", () => {
  it("keeps Kirov optional, strictly read-only, and scoped to an existing host-authored PlanRef", () => {
    const principles = KIROV_METADATA.principles ?? [];

    expect(KIROV_METADATA.title).toBe("Plan Assurance & Audit");
    expect(KIROV_METADATA.summary).toContain("existing host-authored Fleet Plan");
    expect(KIROV_METADATA.requestBlocks).toEqual([
      expect.objectContaining({ tag: "plan_ref", required: true }),
      expect.objectContaining({ tag: "audit_focus", required: false }),
      expect.objectContaining({ tag: "context", required: false }),
      expect.objectContaining({ tag: "constraints", required: false }),
    ]);
    expect(KIROV_METADATA.requestBlocks.map((block) => block.tag)).not.toEqual(expect.arrayContaining(["plan_id", "goal"]));
    expect(KIROV_METADATA.allowedExecutorTools).toEqual(["carrier_jobs", "plan_read"]);
    expect(KIROV_METADATA.permissions.join("\n")).toContain("must never call plan_write");
    expect(KIROV_METADATA.permissions.join("\n")).toContain("MUST NOT write or edit source code, documentation, configuration");
    expect(KIROV_METADATA.permissions.join("\n")).toContain("MUST NOT make product, architecture");
    expect(KIROV_METADATA.outputFormat).toContain("PASS | REVISE | BLOCKED");
    for (const field of ["**PlanRef**", "**Findings**", "**Dispatch readiness**", "**Host action**"]) {
      expect(KIROV_METADATA.outputFormat).toContain(field);
    }
    expect(KIROV_METADATA.outputFormat).toContain("For PASS, explicitly report no findings.");
    expect(principles.join("\n")).toContain("affected Plan section, Lane, or TaskRef");
    expect(principles.join("\n")).toContain("optional assurance, not a planning prerequisite");
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
    expect(OHIO_METADATA.permissions.join("\n")).toContain("return every requested Plan wording, topology, ownership, or task change and every unresolved decision to the host");
    expect(OHIO_METADATA.outputFormat).toContain("**Host Plan action**");
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
