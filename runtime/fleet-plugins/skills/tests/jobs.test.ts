import { afterEach, describe, expect, it } from "vitest";

import { stripAnsi } from "../server/cli.js";
import {
  appendChunk,
  createJob,
  finishJob,
  getActiveKeysForTest,
  getJobResult,
  getJobsMapForTest,
  isJobActive,
} from "../server/jobs.js";

function clearAllJobs(): void {
  getJobsMapForTest().clear();
  getActiveKeysForTest().clear();
}

afterEach(() => {
  clearAllJobs();
});

describe("createJob", () => {

  it("returns null when a job is already active for same scope+theater", () => {
    const id1 = createJob("project", "theater1");
    const id2 = createJob("project", "theater1");
    expect(id1).not.toBeNull();
    expect(id2).toBeNull();
  });
});

describe("appendChunk + finishJob + getJobResult", () => {

  it("sets status to done on exitCode 0", () => {
    const id = createJob("project", "t5")!;
    finishJob(id, 0);
    const r = getJobResult(id, 0)!;
    expect(r.status).toBe("done");
    expect(r.exitCode).toBe(0);
  });

  it("sets status to error on non-zero exitCode", () => {
    const id = createJob("project", "t6")!;
    finishJob(id, 1);
    const r = getJobResult(id, 0)!;
    expect(r.status).toBe("error");
    expect(r.exitCode).toBe(1);
  });

  it("frees active key on finish so new job can start", () => {
    const id = createJob("project", "t7")!;
    expect(isJobActive("project", "t7")).toBe(true);
    finishJob(id, 0);
    expect(isJobActive("project", "t7")).toBe(false);
    const id2 = createJob("project", "t7");
    expect(id2).not.toBeNull();
  });
});
