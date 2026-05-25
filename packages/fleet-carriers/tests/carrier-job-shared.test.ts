import { describe, expect, beforeEach, afterEach, it, vi } from "vitest";

import { getActiveBackgroundJobCount as getActiveBackgroundJobCountFromRoot } from "../src/index.js";
import { serializeJobArchive } from "../src/jobs/archive.js";
import {
  toMessageArchiveBlock,
  toThoughtArchiveBlock,
  toToolCallArchiveBlock,
  redactSecrets,
} from "../src/jobs/archive.js";
import {
  acquireJobPermit,
  configureDetachedJobCap,
  listActiveJobs,
  resetJobConcurrencyForTest,
} from "../src/jobs/lifecycle.js";
import {
  cancelJob,
  hasJobCancelControllers,
  registerJobAbortController,
  resetJobCancelRegistryForTest,
  unregisterJobAbortControllers,
} from "../src/jobs/lifecycle.js";
import { buildCarrierJobId, parseCarrierJobId } from "../src/jobs/types.js";
import {
  appendBlock,
  createJobArchive,
  finalizeJobArchive,
  getFinalized,
  hasJobArchive,
  resetJobArchivesForTest,
} from "../src/jobs/archive.js";
import type { CarrierJobRecord, CarrierJobSummary } from "../src/jobs/types.js";
import {
  CARRIER_JOB_TTL_MS,
  CARRIER_JOBS_FULL_RESULT_BYTE_CAP,
  CARRIER_JOBS_GLOBAL_BYTE_CAP,
  CARRIER_JOBS_PER_SUBOP_BYTE_CAP,
} from "../src/jobs/types.js";
import {
  configureJobSummaryCache,
  getJobSummary,
  listJobSummaries,
  putJobSummary,
  resetJobSummaryCacheForTest,
} from "../src/jobs/dispatch.js";
import * as jobBarrel from "../src/index.js";

beforeEach(() => {
  resetJobArchivesForTest();
  resetJobSummaryCacheForTest();
  resetJobConcurrencyForTest();
  resetJobCancelRegistryForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("carrier job id", () => {
  it("exposes job APIs through the carrier root and job barrel", () => {
    expect(getActiveBackgroundJobCountFromRoot()).toBe(0);
    expect(jobBarrel.getActiveBackgroundJobCount()).toBe(0);
  });

  it("builds and parses allowed prefixed IDs", () => {
    expect(buildCarrierJobId("sortie", "abc")).toBe("sortie:abc");
    expect(parseCarrierJobId(`squad${"ron"}:call-1`)).toBeNull();
    expect(parseCarrierJobId("taskforce:call:with:colon")).toEqual({
      kind: "taskforce",
      toolCallId: "call:with:colon",
    });
  });

  it("rejects invalid prefixes and empty base IDs", () => {
    expect(parseCarrierJobId("invalid:abc")).toBeNull();
    expect(parseCarrierJobId("sortie:")).toBeNull();
    expect(() => buildCarrierJobId("sortie", "")).toThrow(/toolCallId/);
  });
});

describe("job stream archive", () => {
  it("stores blocks and keeps finalized full results readable within TTL", () => {
    createJobArchive("sortie:1", 1000);
    appendBlock("sortie:1", toMessageArchiveBlock("genesis", "\u001b[31mhello\u001b[0m\u0007", undefined, 1001), 1001);
    finalizeJobArchive("sortie:1", "done", 1002);

    const first = getFinalized("sortie:1", 1003);
    expect(first?.blocks[0]?.text).toBe("hello");
    expect(getFinalized("sortie:1", 1004)?.blocks[0]?.text).toBe("hello");
  });

  it("does not invalidate active archives before finalization", () => {
    createJobArchive("sortie:1", 1000);
    appendBlock("sortie:1", toMessageArchiveBlock("genesis", "still running", undefined, 1001), 1001);

    expect(getFinalized("sortie:1", 1002)).toBeNull();
    expect(hasJobArchive("sortie:1", 1003)).toBe(true);
  });

  it("preserves head and tail blocks when oversized archives are truncated", () => {
    createJobArchive("sortie:1", 1000);
    const huge = "x".repeat(24_000);
    for (let i = 0; i < 400; i++) {
      appendBlock("sortie:1", toMessageArchiveBlock("genesis", `${i}:${huge}`, String(i), 1001 + i), 1001 + i);
    }
    finalizeJobArchive("sortie:1", "done", 2000);

    const archive = getFinalized("sortie:1", 2001);
    expect(archive?.truncated).toBe(true);
    expect(archive?.blocks.length).toBeGreaterThan(2);
    expect(archive?.blocks[0]?.text).toContain("0:");
    expect(archive?.blocks.some((block) => block.text === "[truncated]")).toBe(true);
    expect(archive?.blocks.at(-1)?.text).toContain("399:");
    expect(archive?.totalBytes).toBeGreaterThan(0);
    expect(archive?.totalBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it("does not store tool call blocks in the archive", () => {
    createJobArchive("sortie:1", 1000);
    appendBlock("sortie:1", toToolCallArchiveBlock("genesis", "Read", "in_progress", "first", "tool-1", "main", 1001), 1001);
    appendBlock("sortie:1", toToolCallArchiveBlock("genesis", "Read", "completed", "second", "tool-1", "main", 1002), 1002);
    finalizeJobArchive("sortie:1", "done", 1003);

    const archive = getFinalized("sortie:1", 1004);
    expect(archive?.blocks).toHaveLength(0);
    expect(archive?.blocks.some((block) => block.kind === "tool_call")).toBe(false);
  });

  it("skips tool calls even when they have no tool call ID", () => {
    createJobArchive("sortie:1", 1000);
    appendBlock("sortie:1", toToolCallArchiveBlock("genesis", "Read", "in_progress", "first", undefined, "main", 1001), 1001);
    appendBlock("sortie:1", toToolCallArchiveBlock("genesis", "Read", "completed", "second", undefined, "main", 1002), 1002);
    finalizeJobArchive("sortie:1", "done", 1003);

    const archive = getFinalized("sortie:1", 1004);
    expect(archive?.blocks).toHaveLength(0);
  });

  it("merges consecutive text blocks for the same source and label", () => {
    createJobArchive("sortie:1", 1000);
    appendBlock("sortie:1", toMessageArchiveBlock("genesis", "hello ", "main", 1001), 1001);
    appendBlock("sortie:1", toMessageArchiveBlock("genesis", "world", "main", 1002), 1002);
    finalizeJobArchive("sortie:1", "done", 1003);

    const archive = getFinalized("sortie:1", 1004);
    expect(archive?.blocks).toHaveLength(1);
    expect(archive?.blocks[0]?.text).toBe("hello world");
  });

  it("excludes thought blocks from the archive", () => {
    createJobArchive("sortie:1", 1000);
    appendBlock("sortie:1", toThoughtArchiveBlock("genesis", "think ", "main", 1001), 1001);
    appendBlock("sortie:1", toThoughtArchiveBlock("genesis", "more", "main", 1002), 1002);
    finalizeJobArchive("sortie:1", "done", 1003);

    const archive = getFinalized("sortie:1", 1004);
    expect(archive?.blocks).toHaveLength(0);
  });

  it("stores text but excludes thought blocks", () => {
    createJobArchive("sortie:1", 1000);
    appendBlock("sortie:1", toMessageArchiveBlock("genesis", "text", "main", 1001), 1001);
    appendBlock("sortie:1", toThoughtArchiveBlock("genesis", "thought", "main", 1002), 1002);
    finalizeJobArchive("sortie:1", "done", 1003);

    const archive = getFinalized("sortie:1", 1004);
    expect(archive?.blocks).toHaveLength(1);
    expect(archive?.blocks[0]?.text).toBe("text");
  });

  it("does not merge across carrier or label boundaries", () => {
    createJobArchive("sortie:1", 1000);
    appendBlock("sortie:1", toMessageArchiveBlock("genesis", "a", "one", 1001), 1001);
    appendBlock("sortie:1", toMessageArchiveBlock("genesis", "b", "two", 1002), 1002);
    appendBlock("sortie:1", toMessageArchiveBlock("sentinel", "c", "two", 1003), 1003);
    finalizeJobArchive("sortie:1", "done", 1004);

    const archive = getFinalized("sortie:1", 1005);
    expect(archive?.blocks).toHaveLength(3);
  });

  it("redacts secrets split across merged text chunks", () => {
    createJobArchive("sortie:1", 1000);
    appendBlock("sortie:1", toMessageArchiveBlock("genesis", "AKIAABCDEF", "main", 1001), 1001);
    appendBlock("sortie:1", toMessageArchiveBlock("genesis", "GHIJKLMNOP", "main", 1002), 1002);
    finalizeJobArchive("sortie:1", "done", 1003);

    const archive = getFinalized("sortie:1", 1004);
    expect(archive?.blocks).toHaveLength(1);
    expect(archive?.blocks[0]?.text).toBe("[REDACTED:aws_access_key]");
    expect(archive?.blocks[0]?.text).not.toContain("AKIAABCDEFGHIJKLMNOP");
  });

  it("redacts generic secrets split across merged text chunks", () => {
    createJobArchive("sortie:1", 1000);
    appendBlock("sortie:1", toMessageArchiveBlock("genesis", "API_TOKEN=super-", "main", 1001), 1001);
    appendBlock("sortie:1", toMessageArchiveBlock("genesis", "secret-value", "main", 1002), 1002);
    finalizeJobArchive("sortie:1", "done", 1003);

    const archive = getFinalized("sortie:1", 1004);
    expect(archive?.blocks[0]?.text).toBe("[REDACTED:generic_secret]");
    expect(archive?.blocks[0]?.text).not.toContain("super-secret-value");
    expect(archive?.blocks[0]?.text).not.toContain("secret-value");
  });

  it("redacts JWT and GitHub tokens split across merged text chunks", () => {
    createJobArchive("sortie:1", 1000);
    appendBlock("sortie:1", toMessageArchiveBlock("genesis", "eyJ", "jwt", 1001), 1001);
    appendBlock("sortie:1", toMessageArchiveBlock("genesis", "header.eyJpayload.signature", "jwt", 1002), 1002);
    appendBlock("sortie:1", toMessageArchiveBlock("genesis", "ghp_", "github", 1003), 1003);
    appendBlock("sortie:1", toMessageArchiveBlock("genesis", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ", "github", 1004), 1004);
    finalizeJobArchive("sortie:1", "done", 1005);

    const archive = getFinalized("sortie:1", 1006);
    expect(archive?.blocks[0]?.text).toBe("[REDACTED:jwt]");
    expect(archive?.blocks[1]?.text).toBe("[REDACTED:github_token]");
  });

  it("redacts PEM private keys split across merged text chunks", () => {
    createJobArchive("sortie:1", 1000);
    appendBlock("sortie:1", toMessageArchiveBlock("genesis", "-----BEGIN PRIVATE KEY-----\nabc", "pem", 1001), 1001);
    appendBlock("sortie:1", toMessageArchiveBlock("genesis", "\ndef\n-----END PRIVATE KEY-----", "pem", 1002), 1002);
    finalizeJobArchive("sortie:1", "done", 1003);

    const archive = getFinalized("sortie:1", 1004);
    expect(archive?.blocks[0]?.text).toBe("[REDACTED:pem_private_key]");
  });

  it("keeps redaction idempotent", () => {
    expect(redactSecrets("[REDACTED:generic_secret]")).toBe("[REDACTED:generic_secret]");
  });

  it("preserves truncated marker between head and tail during serialization", () => {
    createJobArchive("sortie:1", 1000);
    for (let i = 0; i < 2105; i++) {
      appendBlock("sortie:1", toMessageArchiveBlock("genesis", `block-${i}`, String(i), 1000 + i), 1000 + i);
    }
    finalizeJobArchive("sortie:1", "done", 4000);

    const archive = getFinalized("sortie:1", 4001);
    const markdown = serializeJobArchive(archive!);
    expect(markdown.indexOf("block-0")).toBeLessThan(markdown.indexOf("[truncated]"));
    expect(markdown.indexOf("[truncated]")).toBeLessThan(markdown.indexOf("block-2104"));
  });

  it("does not store tool call raw output secrets", () => {
    createJobArchive("sortie:1", 1000);
    appendBlock("sortie:1", toToolCallArchiveBlock("genesis", "Read", "in_progress", "pending", "tool-1", "main", 1001), 1001);
    appendBlock("sortie:1", toToolCallArchiveBlock("genesis", "Read", "completed", "AKIAABCDEFGHIJKLMNOP", "tool-1", "main", 1002), 1002);
    finalizeJobArchive("sortie:1", "done", 1003);

    const archive = getFinalized("sortie:1", 1004);
    expect(archive?.blocks).toHaveLength(0);
  });

  it("keeps totalBytes in sync with stored block bytes", () => {
    createJobArchive("sortie:1", 1000);
    appendBlock("sortie:1", toMessageArchiveBlock("genesis", "hello ", "main", 1001), 1001);
    appendBlock("sortie:1", toMessageArchiveBlock("genesis", "world", "main", 1002), 1002);
    appendBlock("sortie:1", toToolCallArchiveBlock("genesis", "Read", "completed", "ok", "tool-1", "main", 1003), 1003);
    finalizeJobArchive("sortie:1", "done", 1004);

    const archive = getFinalized("sortie:1", 1005);
    const expectedBytes = archive?.blocks.reduce((total, block) => total + Buffer.byteLength(JSON.stringify(block), "utf8"), 0);
    expect(archive?.totalBytes).toBe(expectedBytes);
  });

  it("defers secret redaction until archive append", () => {
    const block = toMessageArchiveBlock("genesis", "API_TOKEN=super-secret", undefined, 1000);
    expect(block.text).toBe("API_TOKEN=super-secret");

    createJobArchive("sortie:1", 1000);
    appendBlock("sortie:1", block, 1001);
    finalizeJobArchive("sortie:1", "done", 1002);

    const archive = getFinalized("sortie:1", 1003);
    expect(archive?.blocks[0]?.text).toBe("[REDACTED:generic_secret]");
  });

  it("expires archives after the 3h TTL", () => {
    createJobArchive("sortie:1", 1000);
    expect(hasJobArchive("sortie:1", 1000 + CARRIER_JOB_TTL_MS - 1)).toBe(true);
    expect(hasJobArchive("sortie:1", 1000 + CARRIER_JOB_TTL_MS)).toBe(false);
  });

  it("serializes only text block content without headers or metadata", () => {
    const archive = createJobArchive("taskforce:1", 1000);
    appendBlock("taskforce:1", toMessageArchiveBlock("genesis", "message", "codex", 1002), 1002);
    appendBlock("taskforce:1", toThoughtArchiveBlock("genesis", "thinking", "claude", 1001), 1001);

    const markdown = serializeJobArchive(archive);
    expect(markdown).toContain("message");
    expect(markdown).not.toContain("thinking");
    expect(markdown).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("does not include archive metadata header in serialized output", () => {
    const archive = createJobArchive("sortie:no-header", 1000);
    appendBlock("sortie:no-header", toMessageArchiveBlock("genesis", "payload", undefined, 1001), 1001);
    finalizeJobArchive("sortie:no-header", "done", 1002);

    const markdown = serializeJobArchive(getFinalized("sortie:no-header", 1003)!);
    expect(markdown).not.toContain("Carrier Job Archive");
    expect(markdown).not.toContain("Job ID:");
    expect(markdown).not.toContain("Finalized:");
    expect(markdown).toContain("payload");
  });

  it("caps serialized output to maxBytes with head/tail preservation", () => {
    const archive = createJobArchive("sortie:capped", 1000);
    for (let i = 0; i < 100; i++) {
      appendBlock("sortie:capped", toMessageArchiveBlock("genesis", `block-${i}-${"x".repeat(60)}`, String(i), 1000 + i), 1000 + i);
    }
    finalizeJobArchive("sortie:capped", "done", 2000);

    const full = serializeJobArchive(getFinalized("sortie:capped", 2001)!);
    const capped = serializeJobArchive(getFinalized("sortie:capped", 2001)!, { maxBytes: 1000 });

    expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(1000);
    expect(Buffer.byteLength(full, "utf8")).toBeGreaterThan(1000);
    expect(capped).toContain("block-0-");
    expect(capped).toContain("block-99-");
    expect(capped).toContain("[truncated");
  });

  it("returns full output when maxBytes cap is not exceeded", () => {
    const archive = createJobArchive("sortie:small", 1000);
    appendBlock("sortie:small", toMessageArchiveBlock("genesis", "short", undefined, 1001), 1001);
    finalizeJobArchive("sortie:small", "done", 1002);

    const full = serializeJobArchive(getFinalized("sortie:small", 1003)!);
    const capped = serializeJobArchive(getFinalized("sortie:small", 1003)!, { maxBytes: 100_000 });

    expect(capped).toBe(full);
    expect(capped).not.toContain("[truncated");
  });

  it("applies independent per-sub-op caps with section headers and grouped truncation markers", () => {
    createJobArchive("taskforce:cap", 1000);
    appendBlock(
      "taskforce:cap",
      toMessageArchiveBlock("genesis", `alpha-${"y".repeat(35_000)}`, "subtask 0: alpha", 1001),
      1001,
    );
    appendBlock(
      "taskforce:cap",
      toMessageArchiveBlock("genesis", `beta-${"y".repeat(35_000)}`, "subtask 1: beta", 1002),
      1002,
    );
    finalizeJobArchive("taskforce:cap", "done", 3000);

    const archive = getFinalized("taskforce:cap", 3001)!;
    const capped = serializeJobArchive(archive, {
      perSubOpMaxBytes: CARRIER_JOBS_PER_SUBOP_BYTE_CAP,
      maxBytes: CARRIER_JOBS_GLOBAL_BYTE_CAP,
    });

    expect(capped).toContain("── subtask 0: alpha ──");
    expect(capped).toContain("── subtask 1: beta ──");
    expect(capped).toMatch(/\[truncated \d+ chars in subtask 0: alpha]/);
    expect(capped).toMatch(/\[truncated \d+ chars in subtask 1: beta]/);
    expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(CARRIER_JOBS_GLOBAL_BYTE_CAP);
  });

  it("byte-slices a single merged oversized text block with UTF-8-safe head, char marker, and tail", () => {
    const mid = `${"µ".repeat(9500)}${"a".repeat(4000)}`;
    createJobArchive("taskforce:utf8-slice", 1000);
    appendBlock(
      "taskforce:utf8-slice",
      toMessageArchiveBlock("genesis", `BEGIN-${mid}-END`, "subtask 0: slice", 1001),
      1001,
    );
    finalizeJobArchive("taskforce:utf8-slice", "done", 2000);

    const archive = getFinalized("taskforce:utf8-slice", 2001)!;
    const capped = serializeJobArchive(archive, {
      perSubOpMaxBytes: CARRIER_JOBS_PER_SUBOP_BYTE_CAP,
      maxBytes: CARRIER_JOBS_GLOBAL_BYTE_CAP,
    });

    expect(capped).toContain("── subtask 0: slice ──");
    expect(capped).toMatch(/\[truncated \d+ chars in subtask 0: slice]/);
    expect(capped).toContain("BEGIN-");
    expect(capped).toContain("-END");
    expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(CARRIER_JOBS_GLOBAL_BYTE_CAP);
    expect(capped).not.toContain("\uFFFD");
  });

  it("keeps UTF-8 valid for per-sub-op slice when payload mixes µ, Hangul, and emoji", () => {
    const core = `${"µ".repeat(6500)}${"가".repeat(1800)}${"😀".repeat(400)}`;
    createJobArchive("taskforce:unicode-mix", 1000);
    appendBlock(
      "taskforce:unicode-mix",
      toMessageArchiveBlock("genesis", `ST|${core}|ED`, "subtask 0: mix", 1001),
      1001,
    );
    finalizeJobArchive("taskforce:unicode-mix", "done", 2000);

    const archive = getFinalized("taskforce:unicode-mix", 2001)!;
    const capped = serializeJobArchive(archive, {
      perSubOpMaxBytes: CARRIER_JOBS_PER_SUBOP_BYTE_CAP,
      maxBytes: CARRIER_JOBS_GLOBAL_BYTE_CAP,
    });

    expect(capped).not.toContain("\uFFFD");
    expect(capped).toContain("ST|");
    expect(capped).toContain("|ED");
    expect(capped).toMatch(/\[truncated \d+ chars in subtask 0: mix]/);
  });

  it("uses legacy block truncation marker for single-block sortie cap (no char slicing)", () => {
    createJobArchive("sortie:large-single", 1000);
    appendBlock(
      "sortie:large-single",
      toMessageArchiveBlock("genesis", `BEGIN-${"가".repeat(7800)}-END`, undefined, 1001),
      1001,
    );
    finalizeJobArchive("sortie:large-single", "done", 2000);

    const archive = getFinalized("sortie:large-single", 2001)!;
    const capped = serializeJobArchive(archive, { maxBytes: CARRIER_JOBS_FULL_RESULT_BYTE_CAP });

    expect(capped).toMatch(/\[truncated 1 blocks\]/);
    expect(capped).not.toMatch(/\[truncated \d+ chars/);
    expect(capped).not.toContain("\uFFFD");
  });

  it("shows empty-group placeholder for labeled channels with no text payload", () => {
    createJobArchive("taskforce:empty", 1000);
    appendBlock("taskforce:empty", toMessageArchiveBlock("genesis", "", "subtask 0: quiet", 1001), 1001);
    appendBlock("taskforce:empty", toMessageArchiveBlock("genesis", "hello", "subtask 1: loud", 1002), 1002);
    finalizeJobArchive("taskforce:empty", "done", 1003);

    const archive = getFinalized("taskforce:empty", 1004)!;
    const text = serializeJobArchive(archive, {
      perSubOpMaxBytes: CARRIER_JOBS_PER_SUBOP_BYTE_CAP,
      maxBytes: CARRIER_JOBS_GLOBAL_BYTE_CAP,
    });

    expect(text).toContain("── subtask 0: quiet ──");
    expect(text).toContain("(no archived output for subtask 0: quiet)");
    expect(text).toContain("── subtask 1: loud ──");
    expect(text).toContain("hello");
  });
});

describe("summary LRU cache", () => {
  it("supports read-many summary reads", () => {
    const summary = buildSummary("sortie:1", 1000);
    putJobSummary(summary, 1000);

    expect(getJobSummary("sortie:1", 1001)?.summary).toBe("done");
    expect(getJobSummary("sortie:1", 1002)?.summary).toBe("done");
  });

  it("expires summaries after the 3h TTL", () => {
    putJobSummary(buildSummary("sortie:1", 1000), 1000);
    expect(getJobSummary("sortie:1", 1000 + CARRIER_JOB_TTL_MS - 1)).not.toBeNull();
    expect(getJobSummary("sortie:1", 1000 + CARRIER_JOB_TTL_MS)).toBeNull();
  });

  it("runs eviction hook for LRU overflow", () => {
    const evicted: string[] = [];
    configureJobSummaryCache(1, (jobId) => evicted.push(jobId));

    putJobSummary(buildSummary("sortie:1", 1000), 1000);
    putJobSummary(buildSummary("sortie:2", 1001), 1001);

    expect(evicted).toEqual(["sortie:1"]);
    expect(listJobSummaries(1002).map((entry) => entry.jobId)).toEqual(["sortie:2"]);
  });
});

describe("concurrency guard", () => {
  it("accepts multiple active jobs for the same carrier", () => {
    const first = acquireJobPermit(buildRecord("sortie:1", ["genesis"]));
    expect(first.accepted).toBe(true);

    const second = acquireJobPermit(buildRecord("sortie:2", ["genesis"]));
    expect(second.accepted).toBe(true);

    if (first.accepted) first.release({ status: "done", finishedAt: 2000 });
    expect(listActiveJobs().map((job) => job.jobId)).toEqual(["sortie:2"]);

    if (second.accepted) second.release({ status: "done", finishedAt: 2001 });
    expect(listActiveJobs()).toEqual([]);
  });

  it("rejects the sixth detached job by global cap", () => {
    configureDetachedJobCap(5);
    for (let i = 0; i < 5; i++) {
      expect(acquireJobPermit(buildRecord(`sortie:${i}`, [`carrier-${i}`])).accepted).toBe(true);
    }

    expect(acquireJobPermit(buildRecord("sortie:6", ["carrier-6"]))).toEqual({
      accepted: false,
      error: "concurrency limit",
    });
  });

  it("keeps the global cap as the only concurrency rejection path", () => {
    configureDetachedJobCap(1);
    expect(acquireJobPermit(buildRecord("sortie:1", ["genesis"])).accepted).toBe(true);

    expect(acquireJobPermit(buildRecord("sortie:2", ["genesis"]))).toEqual({
      accepted: false,
      error: "concurrency limit",
    });
  });

  it("releases carrier and global permits", () => {
    const permit = acquireJobPermit(buildRecord("sortie:1", ["genesis"]));
    expect(permit.accepted).toBe(true);
    if (permit.accepted) permit.release({ status: "done", finishedAt: 2000 });

    expect(listActiveJobs()).toEqual([]);
    expect(acquireJobPermit(buildRecord("sortie:2", ["genesis"])).accepted).toBe(true);
  });
});

describe("cancel registry", () => {
  it("cancels by job ID and unregisters cleanly", () => {
    const controller = new AbortController();
    registerJobAbortController("sortie:1", controller);

    expect(hasJobCancelControllers("sortie:1")).toBe(true);
    expect(cancelJob("sortie:1")).toEqual({ cancelled: true, status: "cancelled" });
    expect(controller.signal.aborted).toBe(true);

    unregisterJobAbortControllers("sortie:1");
    expect(cancelJob("sortie:1")).toEqual({ cancelled: false, status: "not_found" });
  });
});

function buildSummary(jobId: string, startedAt: number): CarrierJobSummary {
  return {
    jobId,
    tool: "carrier_genesis",
    status: "done",
    summary: "done",
    startedAt,
    finishedAt: startedAt,
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
