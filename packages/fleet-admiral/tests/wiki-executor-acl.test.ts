import { describe, expect, it } from "vitest";

import { createMcpToolRegistry, type AgentToolSpec } from "@dotobokuri/core-agent";

import {
  GLOBAL_READONLY_WIKI_TOOL_IDS,
  HOST_ONLY_PLAN_TOOL_IDS,
  OHIO_ONLY_PLAN_TOOL_IDS,
  getExecutorMcpTools,
  isHostOnlyPlanTool,
  isOhioOnlyPlanTool,
  isHostOnlyWikiTool,
} from "../src/tools.js";

const ALL_WIKI_TOOL_IDS = [
  "wiki_briefing",
  "wiki_drydock",
  "wiki_ingest",
  "wiki_orient",
  "wiki_patch_edit",
  "wiki_patch_queue",
  "wiki_compile_source",
  "wiki_query",
  "wiki_read",
  "wiki_resolve",
  "wiki_schema_list",
  "wiki_schema_read",
  "wiki_schema_create",
];

function fakeSpec(id: string): AgentToolSpec {
  return {
    id,
    tag: id,
    title: id,
    description: "",
    promptSnippet: "",
    whenToUse: [],
    whenNotToUse: [],
    usageGuidelines: [],
    parameters: {},
    execute: async () => ({ content: [], isError: false }),
  };
}

// getExecutorMcpTools가 참조하는 최소 CarrierRuntime 형태만 흉내낸 stub.
function stubCarrierRuntime(carrierId: string, allowedExecutorTools: string[]) {
  return {
    registry: {
      getState: () => ({
        modes: new Map([[carrierId, { config: { carrierMetadata: { allowedExecutorTools } } }]]),
      }),
    },
  } as unknown as Parameters<typeof getExecutorMcpTools>[1];
}

describe("host-only executor ACL hard-enforcement", () => {
  it("classifies host-only vs global read-only Wiki tools", () => {
    for (const id of GLOBAL_READONLY_WIKI_TOOL_IDS) {
      expect(isHostOnlyWikiTool(id)).toBe(false);
    }
    for (const id of ["wiki_ingest", "wiki_drydock", "wiki_patch_edit", "wiki_compile_source", "wiki_query", "wiki_schema_list", "wiki_schema_read", "wiki_schema_create", "wiki_patch_queue"]) {
      expect(isHostOnlyWikiTool(id)).toBe(true);
    }
    // Non-Wiki tools are never affected by the Wiki denylist.
    expect(isHostOnlyWikiTool("plan_read")).toBe(false);
    expect(isHostOnlyWikiTool("carrier_dispatch")).toBe(false);
    expect(isHostOnlyWikiTool("carrier_jobs")).toBe(false);
  });

  it("classifies exactly plan_write and plan_verify as host-only Plan tools", () => {
    expect([...HOST_ONLY_PLAN_TOOL_IDS].sort()).toEqual(["plan_verify", "plan_write"]);
    expect([...OHIO_ONLY_PLAN_TOOL_IDS]).toEqual(["plan_mark_tasks"]);
    expect(isHostOnlyPlanTool("plan_write")).toBe(true);
    expect(isHostOnlyPlanTool("plan_verify")).toBe(true);
    expect(isHostOnlyPlanTool("plan_read")).toBe(false);
    expect(isHostOnlyPlanTool("plan_mark_tasks")).toBe(false);
    expect(isOhioOnlyPlanTool("plan_mark_tasks")).toBe(true);
    expect(isOhioOnlyPlanTool("plan_read")).toBe(false);
  });

  it("never grants a host-only Wiki tool to a Carrier even when persona metadata lists it", () => {
    const registry = createMcpToolRegistry();
    // Mirror registerWikiToolSpec: every Wiki tool is an agent tool; only the read-only four
    // are also registered as global executor tools.
    for (const id of ALL_WIKI_TOOL_IDS) {
      const spec = fakeSpec(id);
      registry.registerAgentTool(spec);
      if (GLOBAL_READONLY_WIKI_TOOL_IDS.has(id)) registry.registerExecutorTool(spec);
    }

    // A hypothetical / custom persona that lists host-only Wiki tools in allowedExecutorTools.
    const carrierRuntime = stubCarrierRuntime("rogue", [
      "wiki_ingest",
      "wiki_patch_queue",
      "wiki_schema_create",
      "wiki_briefing",
    ]);

    const toolIds = getExecutorMcpTools(registry, carrierRuntime, "rogue").map((spec) => spec.id);

    // Host-only Wiki tools are filtered out despite being in the persona metadata union.
    expect(toolIds).not.toContain("wiki_ingest");
    expect(toolIds).not.toContain("wiki_patch_queue");
    expect(toolIds).not.toContain("wiki_schema_create");
    // A metadata-listed read-only Wiki tool still resolves.
    expect(toolIds).toContain("wiki_briefing");
    // Every surviving Wiki tool is read-only.
    for (const id of toolIds.filter((toolId) => toolId.startsWith("wiki_"))) {
      expect(GLOBAL_READONLY_WIKI_TOOL_IDS.has(id)).toBe(true);
    }
  });

  it("never grants host-only Plan tools through custom persona metadata", () => {
    const registry = createMcpToolRegistry();
    for (const id of ["plan_read", "plan_write", "plan_mark_tasks", "plan_verify"]) {
      registry.registerAgentTool(fakeSpec(id));
    }
    registry.registerExecutorTool(fakeSpec("plan_mark_tasks"), { allowedScopes: [] });

    const carrierRuntime = stubCarrierRuntime("rogue", [
      "plan_read",
      "plan_write",
      "plan_mark_tasks",
      "plan_verify",
    ]);
    const toolIds = getExecutorMcpTools(registry, carrierRuntime, "rogue").map((spec) => spec.id);

    expect(toolIds).toContain("plan_read");
    expect(toolIds).not.toContain("plan_mark_tasks");
    expect(toolIds).not.toContain("plan_write");
    expect(toolIds).not.toContain("plan_verify");

    const ohioToolIds = getExecutorMcpTools(
      registry,
      stubCarrierRuntime("ohio", ["plan_read", "plan_mark_tasks"]),
      "ohio",
    ).map((spec) => spec.id);
    expect(ohioToolIds).toContain("plan_read");
    expect(ohioToolIds).toContain("plan_mark_tasks");
  });
});
