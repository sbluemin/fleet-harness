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

describe("stripAnsi", () => {
  it("removes ANSI CSI sequences", () => {
    expect(stripAnsi("\x1B[32mhello\x1B[0m")).toBe("hello");
  });

  it("removes OSC sequences", () => {
    expect(stripAnsi("\x1B]0;title\x07world")).toBe("world");
  });

  it("passes plain text through", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });
});

describe("createJob", () => {
  it("returns a uuid-format jobId", () => {
    const id = createJob("project", "theater1");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns null when a job is already active for same scope+theater", () => {
    const id1 = createJob("project", "theater1");
    const id2 = createJob("project", "theater1");
    expect(id1).not.toBeNull();
    expect(id2).toBeNull();
  });

  it("allows simultaneous jobs for different scopes", () => {
    const id1 = createJob("project", "theater1");
    const id2 = createJob("global", "theater1");
    expect(id1).not.toBeNull();
    expect(id2).not.toBeNull();
  });

  it("starts with empty lines (warmup injected via onBootstrap)", () => {
    const id = createJob("project", "t1")!;
    const result = getJobResult(id, 0)!;
    expect(result.lines).toHaveLength(0);
  });
});

describe("appendChunk + finishJob + getJobResult", () => {
  it("accumulates lines and advances cursor", () => {
    const id = createJob("project", "t2")!;
    appendChunk(id, "line1\nline2\n");
    const r1 = getJobResult(id, 0)!;
    expect(r1.lines).toHaveLength(2);
    expect(r1.nextCursor).toBe(2);

    appendChunk(id, "line3\n");
    const r2 = getJobResult(id, 2)!;
    expect(r2.lines).toEqual(["line3"]);
    expect(r2.nextCursor).toBe(3);
  });

  it("strips ANSI from appended chunks", () => {
    const id = createJob("project", "t3")!;
    appendChunk(id, "\x1B[32mgreen text\x1B[0m\n");
    const r = getJobResult(id, 0)!;
    expect(r.lines[0]).toBe("green text");
  });

  it("caps lines at MAX_LINES with truncation marker", () => {
    const id = createJob("project", "t4")!;
    const bigChunk = Array.from({ length: 2010 }, (_, i) => `line${i}`).join("\n") + "\n";
    appendChunk(id, bigChunk);
    const r = getJobResult(id, 0)!;
    expect(r.lines[r.lines.length - 1]).toBe("… (output truncated)");
    expect(r.lines.length).toBeLessThanOrEqual(2001);
  });

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

  it("returns null for unknown jobId", () => {
    expect(getJobResult("does-not-exist", 0)).toBeNull();
  });

  it("handles partial lines (no trailing newline)", () => {
    const id = createJob("project", "t8")!;
    appendChunk(id, "partial");
    appendChunk(id, " line\n");
    const r = getJobResult(id, 0)!;
    expect(r.lines[0]).toBe("partial line");
  });

  it("warmup line injected via appendChunk shows in result", () => {
    const id = createJob("project", "t9")!;
    appendChunk(id, "Preparing skills CLI (first run may take a moment)…\n");
    const r = getJobResult(id, 0)!;
    expect(r.lines[0]).toContain("Preparing skills CLI");
  });
});
