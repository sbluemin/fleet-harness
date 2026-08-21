import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createFailureJournal,
  failureDetail,
} from "../../src/transport/failure-journal.js";
import type { GatewayFailureRecord } from "../../src/transport/failure-journal.js";

function record(overrides: Partial<GatewayFailureRecord> = {}): GatewayFailureRecord {
  return {
    timestamp: "2026-08-21T11:44:05.746Z",
    phase: "post_commit",
    model: "xai--grok-4.6",
    provider: "xai",
    errorType: "api_error",
    code: "UND_ERR_SOCKET",
    detail: "fetch failed (UND_ERR_SOCKET)",
    elapsedMs: 38_749,
    upstreamInFlight: 42,
    upstreamQueued: 6,
    ...overrides,
  };
}

describe("failureDetail", () => {
  it("collapses a multi-line message onto one field", () => {
    expect(failureDetail("upstream said\n  no\n\nagain")).toBe("upstream said no again");
  });

  it("bounds a long message", () => {
    const detail = failureDetail("x".repeat(4000));
    expect(detail.length).toBe(512);
    expect(detail.endsWith("…")).toBe(true);
  });
});

describe("failure journal", () => {
  it("appends one JSON line per failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-journal-"));
    const filePath = join(dir, "nested", "failures.jsonl");
    const journal = createFailureJournal({ filePath });

    journal.write(record());
    journal.write(record({ phase: "pre_commit", status: 500 }));
    await journal.flush();

    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      phase: "post_commit",
      code: "UND_ERR_SOCKET",
      upstreamInFlight: 42,
    });
    expect(JSON.parse(lines[1]!)).toMatchObject({ phase: "pre_commit", status: 500 });
  });

  it("writes owner-only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-journal-"));
    const filePath = join(dir, "failures.jsonl");
    const journal = createFailureJournal({ filePath });
    journal.write(record());
    await journal.flush();

    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("rotates at the byte budget and keeps one backup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-journal-"));
    const filePath = join(dir, "failures.jsonl");
    const journal = createFailureJournal({ filePath, maxBytes: 400 });

    for (let i = 0; i < 6; i += 1) journal.write(record({ elapsedMs: i }));
    await journal.flush();

    await expect(stat(`${filePath}.1`)).resolves.toBeTruthy();
    expect((await stat(filePath)).size).toBeLessThanOrEqual(400);
  });

  it("never throws at the caller when the target is unwritable", async () => {
    // A regular file standing where the journal wants a directory fails the same way on every
    // host. An absolute system path such as /proc does not: it is missing on macOS and can hang
    // the mkdir probe on a Linux runner.
    const dir = await mkdtemp(join(tmpdir(), "fleet-journal-"));
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory");
    const journal = createFailureJournal({ filePath: join(blocker, "failures.jsonl") });
    expect(() => journal.write(record())).not.toThrow();
    await expect(journal.flush()).resolves.toBeUndefined();
  });
});
