import { describe, expect, beforeEach, it } from "vitest";

import { registerJobAbortController, resetJobCancelRegistryForTest } from "@sbluemin/fleet-infra/job";
import { acquireJobPermit, resetJobConcurrencyForTest } from "@sbluemin/fleet-infra/job";
import { serializeJobArchive } from "@sbluemin/fleet-infra/job";
import {
  appendBlock,
  createJobArchive,
  finalizeJobArchive,
  getFinalized,
  resetJobArchivesForTest,
} from "@sbluemin/fleet-infra/job";
import { toMessageArchiveBlock } from "@sbluemin/fleet-infra/job";
import type { CarrierJobRecord, CarrierJobSummary } from "@sbluemin/fleet-infra/job";
import { CARRIER_JOBS_FULL_RESULT_BYTE_CAP } from "@sbluemin/fleet-infra/job";
import { putJobSummary, resetJobSummaryCacheForTest } from "@sbluemin/fleet-infra/job";
import { dispatchCarrierJobsAction } from "../../src/admiral/carrier-jobs/index.js";
import { buildCarrierJobsSchema, CARRIER_JOBS_DOCTRINE } from "../../src/admiral/carrier-jobs/prompts.js";

beforeEach(() => {
  resetJobArchivesForTest();
  resetJobSummaryCacheForTest();
  resetJobConcurrencyForTest();
  resetJobCancelRegistryForTest();
});

describe("carrier_jobs tool", () => {
  it("has one action enum surface and no carrier roster", () => {
    const schema = buildCarrierJobsSchema() as any;
    const action = schema.properties.action;

    expect(action.enum).toEqual(["status", "result", "cancel", "list"]);
    expect(CARRIER_JOBS_DOCTRINE.id).toBe("carrier_jobs");
    expect(CARRIER_JOBS_DOCTRINE.usageGuidelines.join("\n")).toContain("never reads the Agent Panel stream-store");
  });

  it("lists active and recent jobs without full archive content", () => {
    acquireJobPermit(buildRecord("sortie:active", ["genesis"]));
    putJobSummary(buildSummary("sortie:done", 1000), 1000);
    createJobArchive("sortie:done", 1000);
    appendBlock("sortie:done", toMessageArchiveBlock("genesis", "full secret", undefined, 1001), 1001);

    const response = dispatchCarrierJobsAction({ action: "list" }, 1002);

    expect(response.ok).toBe(true);
    expect(response.active?.map((job) => job.jobId)).toEqual(["sortie:active"]);
    expect(response.recent?.map((job) => job.jobId)).toEqual(["sortie:done"]);
    expect(JSON.stringify(response)).not.toContain("full secret");
  });

  it("reports active status and availability metadata", () => {
    acquireJobPermit(buildRecord("sortie:active", ["genesis"]));
    createJobArchive("sortie:active", 1000);

    const response = dispatchCarrierJobsAction({ action: "status", job_id: "sortie:active" }, 1001);

    expect(response.ok).toBe(true);
    expect(response.status).toBe("active");
    expect(response.full_available).toBe(false);
    expect(response.summary_available).toBe(false);
  });

  it("keeps active notices as plain text for status, result, and cancel", () => {
    acquireJobPermit(buildRecord("sortie:active", ["genesis"]));
    createJobArchive("sortie:active", 1000);
    putJobSummary({
      jobId: "sortie:active",
      tool: "carrier_genesis",
      status: "active",
      summary: "running",
      startedAt: 1000,
      carriers: ["genesis"],
    }, 1000);

    const statusResponse = dispatchCarrierJobsAction({ action: "status", job_id: "sortie:active" }, 1001);
    const resultResponse = dispatchCarrierJobsAction({ action: "result", job_id: "sortie:active" }, 1001);
    const cancelResponse = dispatchCarrierJobsAction({ action: "cancel", job_id: "sortie:active" }, 1001);

    expect(statusResponse.notice).toContain("[carrier:result]");
    expect(resultResponse.notice).toContain("[carrier:result]");
    expect(cancelResponse.notice).toContain("[carrier:result]");
    expect(statusResponse.notice).not.toContain("<system-reminder>");
    expect(resultResponse.notice).not.toContain("<system-reminder>");
    expect(cancelResponse.notice).not.toContain("<system-reminder>");
  });

  it("rejects result reads for active jobs", () => {
    acquireJobPermit(buildRecord("sortie:active", ["genesis"]));
    createJobArchive("sortie:active", 1000);
    appendBlock("sortie:active", toMessageArchiveBlock("genesis", "running output", undefined, 1001), 1001);

    const active = dispatchCarrierJobsAction({ action: "result", job_id: "sortie:active" }, 1002);
    expect(active.ok).toBe(false);
    expect(active.error).toBe("job not finalized");
    expect(active.status).toBe("active");
    expect(active.retry_after).toBeDefined();
    expect(active.notice).toContain("[carrier:result]");
  });

  it("returns full archive repeatedly while TTL keeps it readable", () => {
    putJobSummary(buildSummary("sortie:done", 1000), 1000);
    createJobArchive("sortie:done", 1000);
    appendBlock("sortie:done", toMessageArchiveBlock("genesis", "chronological output", undefined, 1001), 1001);
    finalizeJobArchive("sortie:done", "done", 1002);

    const first = dispatchCarrierJobsAction({ action: "result", job_id: "sortie:done" }, 1003);
    const second = dispatchCarrierJobsAction({ action: "result", job_id: "sortie:done" }, 1004);

    expect(first.ok).toBe(true);
    expect(first.full_result).toContain("chronological output");
    expect(second.ok).toBe(true);
    expect(second.full_result).toContain("chronological output");
  });

  it("returns summary results without serializing full archive content", () => {
    putJobSummary(buildSummary("sortie:done", 1000), 1000);
    createJobArchive("sortie:done", 1000);
    appendBlock("sortie:done", toMessageArchiveBlock("genesis", "full secret", undefined, 1001), 1001);
    finalizeJobArchive("sortie:done", "done", 1002);

    const response = dispatchCarrierJobsAction({ action: "result", format: "summary", job_id: "sortie:done" }, 1003);

    expect(response.ok).toBe(true);
    expect(response.format).toBe("summary");
    expect(response.summary?.summary).toBe("completed");
    expect(response.full_available).toBe(true);
    expect(response.full_result).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain("full secret");
  });

  it("defaults result format to full for compatibility", () => {
    putJobSummary(buildSummary("sortie:done", 1000), 1000);
    createJobArchive("sortie:done", 1000);
    appendBlock("sortie:done", toMessageArchiveBlock("genesis", "chronological output", undefined, 1001), 1001);
    finalizeJobArchive("sortie:done", "done", 1002);

    const response = dispatchCarrierJobsAction({ action: "result", job_id: "sortie:done" }, 1003);

    expect(response.format).toBe("full");
    expect(response.full_result).toContain("chronological output");
  });

  it("keeps carrier_dispatch full_result serialization identical to the legacy single maxBytes cap", () => {
    putJobSummary(buildSummary("sortie:legacy-cap", 1000), 1000);
    createJobArchive("sortie:legacy-cap", 1000);
    appendBlock(
      "sortie:legacy-cap",
      toMessageArchiveBlock("genesis", "payload line", undefined, 1001),
      1001,
    );
    finalizeJobArchive("sortie:legacy-cap", "done", 1002);

    const archive = getFinalized("sortie:legacy-cap", 1003)!;
    const expected = serializeJobArchive(archive, { maxBytes: CARRIER_JOBS_FULL_RESULT_BYTE_CAP });
    const response = dispatchCarrierJobsAction({ action: "result", job_id: "sortie:legacy-cap" }, 1003);

    expect(response.full_result).toBe(expected);
    expect(response.full_result).not.toMatch(/^── /m);
  });

  it("returns taskforce full results by backend when summary was evicted (jobId prefix fallback)", () => {
    createJobArchive("taskforce:no-summary", 1000);
    appendBlock(
      "taskforce:no-summary",
      toMessageArchiveBlock("genesis", "solo output", "codex", 1001),
      1001,
    );
    finalizeJobArchive("taskforce:no-summary", "done", 2000);

    const response = dispatchCarrierJobsAction({ action: "result", job_id: "taskforce:no-summary" }, 2001);

    expect(response.ok).toBe(true);
    expect(response.summary_available).toBe(false);
    expect(response.full_result).toBeUndefined();
    expect(response.results).toEqual({
      codex: "solo output",
    });
    expect(Buffer.byteLength(response.results!.codex, "utf8")).toBeLessThanOrEqual(30_000);
  });

  it("returns taskforce full results as backend-keyed records", () => {
    putJobSummary(buildTaskForceSummary("taskforce:tf", 1000), 1000);
    createJobArchive("taskforce:tf", 1000);
    appendBlock(
      "taskforce:tf",
      toMessageArchiveBlock("genesis", "codex output", "codex", 1001),
      1001,
    );
    appendBlock(
      "taskforce:tf",
      toMessageArchiveBlock("genesis", "claude output", "claude", 1002),
      1002,
    );
    finalizeJobArchive("taskforce:tf", "done", 3000);

    const response = dispatchCarrierJobsAction({ action: "result", job_id: "taskforce:tf" }, 3001);

    expect(response.ok).toBe(true);
    expect(response.full_result).toBeUndefined();
    expect(response.results).toEqual({
      codex: "codex output",
      claude: "claude output",
    });
    expect(Buffer.byteLength(response.results!.codex, "utf8")).toBeLessThanOrEqual(30_000);
    expect(Buffer.byteLength(response.results!.claude, "utf8")).toBeLessThanOrEqual(30_000);
  });

  it("cancels by job ID without touching unrelated jobs", () => {
    const target = new AbortController();
    const other = new AbortController();
    registerJobAbortController("sortie:target", target);
    registerJobAbortController("sortie:other", other);

    const response = dispatchCarrierJobsAction({ action: "cancel", job_id: "sortie:target" });

    expect(response.cancelled).toBe(true);
    expect(target.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
  });

  it("returns structured not-found responses for valid missing jobs", () => {
    const response = dispatchCarrierJobsAction({ action: "cancel", job_id: "sortie:missing" });

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/not found/);
  });

  it("rejects invalid job ID prefixes", () => {
    const response = dispatchCarrierJobsAction({ action: "status", job_id: "invalid:bad" });

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/must start with/);
  });
});

function buildSummary(jobId: string, startedAt: number): CarrierJobSummary {
  return {
    jobId,
    tool: "carrier_genesis",
    status: "done",
    summary: "completed",
    startedAt,
    finishedAt: startedAt + 100,
    carriers: ["genesis"],
  };
}

function buildTaskForceSummary(jobId: string, startedAt: number): CarrierJobSummary {
  return {
    jobId,
    tool: "carrier_dispatch",
    status: "done",
    summary: "completed",
    startedAt,
    finishedAt: startedAt + 100,
    carriers: ["genesis"],
  };
}

function buildRecord(jobId: string, carriers: string[]): CarrierJobRecord {
  return {
    jobId,
    tool: "carrier_genesis",
    status: "active",
    startedAt: 1000,
    carriers,
  };
}
