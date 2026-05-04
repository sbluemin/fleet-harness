import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { admiral } from "@sbluemin/fleet-core";
import { CARRIER_RESULT_CUSTOM_TYPE } from "../../src/jobs.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const { PROTOCOL_PREAMBLE } = admiral.prompts;
const { CARRIER_OPERATIONS_POLICY } = admiral.protocols.standingOrders;
const { buildCarrierDispatchToolSpec } = admiral.carrier;
const { CARRIER_JOBS_DOCTRINE, buildCarrierJobsSchema } = admiral.carrierJobs;
const { SQUADRON_DOCTRINE, buildSquadronSchema } = admiral.squadron;
const { TASKFORCE_DOCTRINE, buildTaskForceSchema } = admiral.taskforce;

describe("carrier prompt doctrine", () => {
  it("contains fire-and-forget doctrine and carrier_jobs TTL-based read-many guidance", () => {
    expect(PROTOCOL_PREAMBLE).toContain("[carrier:result]");
    expect(PROTOCOL_PREAMBLE).toContain("carrier_jobs");
    expect(PROTOCOL_PREAMBLE).toContain("repeated lookups");
    expect(PROTOCOL_PREAMBLE).toContain("Do not poll, wait-check, or call carrier_jobs merely to see whether the job is done");
    expect(PROTOCOL_PREAMBLE).toContain("stop tool use and wait passively for the [carrier:result] follow-up push");
    expect(PROTOCOL_PREAMBLE).toContain("carrier_jobs is only a fallback path when the push is missing or an explicit lookup is required");
    expect(CARRIER_OPERATIONS_POLICY.prompt).toContain("Lookup/control detached carrier jobs");
  });

  it("carrier_dispatch tool unifies all carriers under a single spec", () => {
    const dispatchSpec = buildCarrierDispatchToolSpec();
    expect(dispatchSpec.id).toBe("carrier_dispatch");
    expect(dispatchSpec.tag).toBe("carrier_dispatch");
    expect(SQUADRON_DOCTRINE.id).toBe("carrier_squadron");
    expect(TASKFORCE_DOCTRINE.id).toBe("carrier_taskforce");
    expect(CARRIER_JOBS_DOCTRINE.id).toBe("carrier_jobs");
    expect(CARRIER_JOBS_DOCTRINE.usageGuidelines.join("\n")).not.toContain("Available Carriers");
    expect(CARRIER_JOBS_DOCTRINE.usageGuidelines.join("\n")).toContain("finalized-only");
    expect(CARRIER_JOBS_DOCTRINE.whenNotToUse.join("\n")).toContain("Do not poll, wait-check, or call carrier_jobs merely to see whether a launched job is done");
    expect(CARRIER_JOBS_DOCTRINE.usageGuidelines.join("\n")).toContain("follow-up push");
  });

  it("keeps carrier_jobs as fallback or explicit lookup only across async carrier tools", () => {
    const dispatchSpec = buildCarrierDispatchToolSpec();
    const dispatchManifests = [dispatchSpec, SQUADRON_DOCTRINE, TASKFORCE_DOCTRINE];

    for (const manifest of dispatchManifests) {
      const text = JSON.stringify(manifest);
      expect(text).toContain("carrier_jobs is fallback/explicit lookup only");
      expect(text).toContain("Do not poll, wait-check, or call carrier_jobs merely to see whether the job is done");
      expect(text).toContain("stop tool use and wait passively");
    }

    const jobsText = JSON.stringify(CARRIER_JOBS_DOCTRINE);
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
    const dispatchSpec = buildCarrierDispatchToolSpec();
    const schemaKeys = [
      Object.keys((dispatchSpec.parameters as any).properties),
      Object.keys((buildSquadronSchema(["genesis"]) as any).properties),
      Object.keys((buildTaskForceSchema(["genesis"]) as any).properties),
      Object.keys((buildCarrierJobsSchema() as any).properties),
    ].flat();
    const manifestText = [
      JSON.stringify(dispatchSpec),
      JSON.stringify(SQUADRON_DOCTRINE),
      JSON.stringify(TASKFORCE_DOCTRINE),
      JSON.stringify(CARRIER_JOBS_DOCTRINE),
    ].join("\n");

    expect(schemaKeys).not.toEqual(expect.arrayContaining(["max_wait_ms", "wait", "mode"]));
    expect(manifestText).not.toMatch(/max_wait_ms|temporary-client|queue policy|fallback mode/i);
    const combined = `${schemaKeys.join("\n")}\n${manifestText}`;
    expect(combined).toContain("job_id");
    expect(combined).toContain("accepted");
  });
});
