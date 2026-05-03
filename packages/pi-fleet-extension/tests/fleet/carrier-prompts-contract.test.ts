import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { admiral } from "@sbluemin/fleet-core";
import { CARRIER_RESULT_CUSTOM_TYPE } from "../../src/jobs.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const { PROTOCOL_PREAMBLE } = admiral.prompts;
const { DELEGATION_POLICY } = admiral.protocols.standingOrders;
const { buildCarrierToolManifest, buildCarrierToolSchema } = admiral.carrier;
const { CARRIER_JOBS_MANIFEST, buildCarrierJobsSchema } = admiral.carrierJobs;
const { SQUADRON_MANIFEST, buildSquadronSchema } = admiral.squadron;
const { TASKFORCE_MANIFEST, buildTaskForceSchema } = admiral.taskforce;

describe("carrier prompt doctrine", () => {
  it("contains fire-and-forget doctrine and carrier_jobs TTL-based read-many guidance", () => {
    expect(PROTOCOL_PREAMBLE).toContain("[carrier:result]");
    expect(PROTOCOL_PREAMBLE).toContain("carrier_jobs");
    expect(PROTOCOL_PREAMBLE).toContain("repeated lookups");
    expect(PROTOCOL_PREAMBLE).toContain("Do not poll, wait-check, or call carrier_jobs merely to see whether the job is done");
    expect(PROTOCOL_PREAMBLE).toContain("stop tool use and wait passively for the [carrier:result] follow-up push");
    expect(PROTOCOL_PREAMBLE).toContain("carrier_jobs is only a fallback path when the push is missing or an explicit lookup is required");
    expect(DELEGATION_POLICY.prompt).toContain("Lookup/control detached carrier jobs");
  });

  it("keeps one manifest per carrier tool and carrier_jobs has no roster", () => {
    // 개별 캐리어 도구 매니페스트 검증 — 샘플 캐리어 "genesis"로 확인
    const genesisManifest = buildCarrierToolManifest("genesis", "Genesis", {
      title: "Chief Engineer",
      summary: "Implementation specialist",
      category: "operations",
      whenToUse: ["implementation tasks"],
      whenNotToUse: ["strategic decisions"],
      permissions: [],
      requestBlocks: [],
      outputFormat: "",
    });
    expect(genesisManifest.id).toBe("carrier_genesis");
    expect(SQUADRON_MANIFEST.id).toBe("carrier_squadron");
    expect(TASKFORCE_MANIFEST.id).toBe("carrier_taskforce");
    expect(CARRIER_JOBS_MANIFEST.id).toBe("carrier_jobs");
    expect(CARRIER_JOBS_MANIFEST.usageGuidelines.join("\n")).not.toContain("Available Carriers");
    expect(CARRIER_JOBS_MANIFEST.usageGuidelines.join("\n")).toContain("finalized-only");
    expect(CARRIER_JOBS_MANIFEST.whenNotToUse.join("\n")).toContain("Do not poll, wait-check, or call carrier_jobs merely to see whether a launched job is done");
    expect(CARRIER_JOBS_MANIFEST.usageGuidelines.join("\n")).toContain("follow-up push");
  });

  it("keeps carrier_jobs as fallback or explicit lookup only across async carrier tools", () => {
    const sampleMetadata = {
      title: "Chief Engineer",
      summary: "Implementation specialist",
      category: "operations" as const,
      whenToUse: ["implementation tasks"],
      whenNotToUse: ["strategic decisions"],
      permissions: [] as string[],
      requestBlocks: [] as Array<{ tag: string; hint: string; required: boolean }>,
      outputFormat: "",
    };
    const genesisManifest = buildCarrierToolManifest("genesis", "Genesis", sampleMetadata);
    const dispatchManifests = [genesisManifest, SQUADRON_MANIFEST, TASKFORCE_MANIFEST];

    for (const manifest of dispatchManifests) {
      const text = JSON.stringify(manifest);
      expect(text).toContain("carrier_jobs is fallback/explicit lookup only");
      expect(text).toContain("Do not poll, wait-check, or call carrier_jobs merely to see whether the job is done");
      expect(text).toContain("stop tool use and wait passively");
    }

    const jobsText = JSON.stringify(CARRIER_JOBS_MANIFEST);
    expect(jobsText).toContain("not a polling tool");
    expect(jobsText).toContain("fallback channel for missing pushes or explicit lookups");
    expect(jobsText).toContain("stop tool use and wait passively");
  });

  it("registers the hidden carrier result custom renderer contract", async () => {
    const fs = await import("node:fs");
    const indexSource = fs.readFileSync(join(testDir, "..", "..", "src", "boot.ts"), "utf8");
    expect(CARRIER_RESULT_CUSTOM_TYPE).toBe("carrier-result");
    expect(indexSource).toContain("registerJob(ctx)");
  });

  it("does not expose wait/mode/fallback queue schema knobs", () => {
    const schemaKeys = [
      Object.keys((buildCarrierToolSchema() as any).properties),
      Object.keys((buildSquadronSchema(["genesis"]) as any).properties),
      Object.keys((buildTaskForceSchema(["genesis"]) as any).properties),
      Object.keys((buildCarrierJobsSchema() as any).properties),
    ].flat();
    const sampleMetadata = {
      title: "Chief Engineer",
      summary: "Implementation specialist",
      category: "operations" as const,
      whenToUse: ["implementation tasks"],
      whenNotToUse: ["strategic decisions"],
      permissions: [] as string[],
      requestBlocks: [] as Array<{ tag: string; hint: string; required: boolean }>,
      outputFormat: "",
    };
    const genesisManifest = buildCarrierToolManifest("genesis", "Genesis", sampleMetadata);
    const manifestText = [
      JSON.stringify(genesisManifest),
      JSON.stringify(SQUADRON_MANIFEST),
      JSON.stringify(TASKFORCE_MANIFEST),
      JSON.stringify(CARRIER_JOBS_MANIFEST),
    ].join("\n");

    expect(schemaKeys).not.toEqual(expect.arrayContaining(["max_wait_ms", "wait", "mode"]));
    expect(manifestText).not.toMatch(/max_wait_ms|temporary-client|queue policy|fallback mode/i);
    const combined = `${schemaKeys.join("\n")}\n${manifestText}`;
    expect(combined).toContain("job_id");
    expect(combined).toContain("accepted");
  });
});
