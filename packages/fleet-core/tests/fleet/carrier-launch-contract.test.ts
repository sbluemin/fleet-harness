import { describe, expect, it, vi } from "vitest";

import { acquireJobPermit, resetJobConcurrencyForTest } from "../../src/infra/job/concurrency-guard.js";
import { formatLaunchResponseText, JOB_LAUNCH_NOTICE } from "../../src/infra/job/job-reminders.js";
import type { CarrierJobLaunchResponse, CarrierJobRecord, CarrierJobStatus } from "../../src/infra/job/job-types.js";

describe("carrier launch contract", () => {
  it("launch responses contain job_id and accepted but no synchronous payload fields", () => {
    const response: CarrierJobLaunchResponse = {
      job_id: "sortie:call-1",
      accepted: true,
    };

    expect(response).toMatchObject({ job_id: "sortie:call-1", accepted: true });
    expect(response).not.toHaveProperty("content");
    expect(response).not.toHaveProperty("summary");
    expect(response).not.toHaveProperty("full_result");
  });

  it("allows same-carrier permits until the global cap is reached", () => {
    resetJobConcurrencyForTest();
    const first = acquireJobPermit(buildRecord("sortie:first", ["genesis"]));
    expect(first.accepted).toBe(true);

    const second = acquireJobPermit(buildRecord("sortie:second", ["genesis"]));
    expect(second.accepted).toBe(true);

    for (let i = 0; i < 3; i++) {
      expect(acquireJobPermit(buildRecord(`sortie:${i}`, [`carrier-${i}`])).accepted).toBe(true);
    }
    expect(acquireJobPermit(buildRecord("sortie:cap", ["carrier-cap"]))).toEqual({
      accepted: false,
      error: "concurrency limit",
    });
  });

  it("prioritizes aborted over error and done for detached final status", () => {
    expect(computeFinalStatus([{ status: "done" }, { status: "aborted" }, { status: "error" }])).toBe("aborted");
    expect(computeFinalStatus([{ status: "done" }, { status: "error" }])).toBe("error");
    expect(computeFinalStatus([{ status: "done" }])).toBe("done");
  });

  it("uses aborted wording without completed wording for detached summaries", () => {
    for (const tool of ["carrier_genesis", "carrier_taskforce"]) {
      const summary = buildSummaryText(tool, "aborted", 1, 1);
      expect(summary).toContain("aborted");
      expect(summary).not.toContain("completed");
    }
  });

  it("does not schedule detached onUpdate polling timers", () => {
    vi.useFakeTimers();
    const onUpdate = vi.fn();

    launchDetachedWithoutOnUpdate(onUpdate);
    vi.advanceTimersByTime(1000);

    expect(onUpdate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("adds launch guidance only for accepted background jobs", () => {
    const accepted = formatLaunchResponseText({ job_id: "sortie:call-1", accepted: true }, true);
    expect(accepted.startsWith(JOB_LAUNCH_NOTICE)).toBe(true);
    expect(accepted).toContain("Job accepted");
    expect(accepted).toContain("carrier-completion follow-up push");
    expect(accepted).toContain("[carrier:result]");
    expect(accepted).toContain("DO NOT poll carrier_jobs");
    expect(accepted).toContain('{"job_id":"sortie:call-1","accepted":true}');
    expect(accepted).not.toContain("<system-reminder");
    expect(accepted).not.toMatch(/^<[^>\n]+>/);

    const rejected = formatLaunchResponseText({ job_id: "sortie:call-1", accepted: false, error: "concurrency limit" }, false);
    expect(rejected).toBe('{"job_id":"sortie:call-1","accepted":false,"error":"concurrency limit"}');
    expect(rejected).not.toMatch(/^<[^>\n]+>/);
  });
});

function computeFinalStatus(results: Array<{ status: "done" | "error" | "aborted" }>): CarrierJobStatus {
  if (results.some((result) => result.status === "aborted")) return "aborted";
  if (results.some((result) => result.status === "error")) return "error";
  return "done";
}

function buildSummaryText(tool: string, status: CarrierJobStatus, successCount: number, failureCount: number, error?: string): string {
  if (status === "aborted") return `${tool} aborted: ${successCount} done, ${failureCount} failed`;
  if (error) return `${tool} failed: ${error}`;
  return `${tool} completed: ${successCount} done, ${failureCount} failed`;
}

function launchDetachedWithoutOnUpdate(_onUpdate: () => void): CarrierJobLaunchResponse {
  return {
    job_id: "sortie:call-1",
    accepted: true,
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
