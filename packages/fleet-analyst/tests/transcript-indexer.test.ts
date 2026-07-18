import { appendFile, mkdtemp, readFile, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TranscriptIndexer } from "../src/transcript-indexer.js";

const fixtures = new URL("./fixtures/", import.meta.url);

describe("TranscriptIndexer", () => {
  it("indexes Claude user, assistant blocks, tool result, unknown, and ignores malformed input", async () => {
    const file = await copyFixture("claude-session.jsonl");
    const indexer = new TranscriptIndexer(file);
    await indexer.refresh();

    expect(indexer.all.map((event) => [event.kind, event.summary, event.targetPath])).toEqual([
      ["message", "Inspect the change", undefined],
      ["message", "I will inspect the implementation.", undefined],
      ["message", "Need locate the changed file.", undefined],
      ["file", "Read", "src/example.ts"],
      ["tool", "export const value = 1;", undefined],
      ["message", "harmless unknown", undefined],
    ]);
    expect(indexer.outline()).toMatchObject({ eventCount: 6, fileTouchCount: 1, stages: ["user", "assistant"] });
  });

  it("maps Codex rollout records defensively", async () => {
    const indexer = new TranscriptIndexer(await copyFixture("codex-rollout.jsonl"));
    await indexer.refresh();
    expect(indexer.all).toHaveLength(3);
    expect(indexer.all[0]).toMatchObject({ summary: "Started analysis", stage: "assistant" });
    expect(indexer.all[1]).toMatchObject({ kind: "file", targetPath: "README.md" });
  });

  it("keeps references stable across appends and resets them after source truncation", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "analyst-")), "capture.jsonl");
    await writeFile(file, '{"type":"assistant","message":{"content":"first"}}\n');
    const indexer = new TranscriptIndexer(file);
    await indexer.refresh();
    await appendFile(file, '{"type":"assistant","message":{"content":"second"}}\n');
    await indexer.refresh();
    expect(indexer.all.map((event) => event.ref)).toEqual(["e1", "e2"]);

    await truncate(file, 0);
    await appendFile(file, '{"type":"assistant","message":{"content":"replacement"}}\n');
    await indexer.refresh();
    expect(indexer.all).toHaveLength(1);
    expect(indexer.all[0]).toMatchObject({ ref: "e1", summary: "replacement" });
  });

  it("shares concurrent refresh work without indexing records twice", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "analyst-")), "capture.jsonl");
    await writeFile(file, [
      '{"type":"assistant","message":{"content":"first"}}',
      '{"type":"assistant","message":{"content":"second"}}',
      "",
    ].join("\n"));
    const indexer = new TranscriptIndexer(file, { maxReadBytes: 16 });

    const first = indexer.refresh();
    const second = indexer.refresh();
    expect(first).toBe(second);
    await Promise.all([first, second]);

    expect(indexer.all.map((event) => event.summary)).toEqual(["first", "second"]);
  });

  it("resets when a same-size rewrite breaks the continuity sentinel", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "analyst-")), "capture.jsonl");
    const original = '{"type":"assistant","message":{"content":"first"}}\n';
    const replacement = '{"type":"assistant","message":{"content":"other"}}\n';
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
    await writeFile(file, original);
    const indexer = new TranscriptIndexer(file);
    await indexer.refresh();

    await writeFile(file, replacement);
    await indexer.refresh();

    expect(indexer.all).toEqual([expect.objectContaining({ ref: "e1", summary: "other" })]);
  });

  it("walks multiple read chunks to EOF in one refresh", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "analyst-")), "capture.jsonl");
    const records = Array.from({ length: 12 }, (_, index) => JSON.stringify({ type: "assistant", message: { content: `event-${index}` } }));
    await writeFile(file, `${records.join("\n")}\n`);
    const indexer = new TranscriptIndexer(file, { maxReadBytes: 31 });

    await indexer.refresh();

    expect(indexer.all.map((event) => event.summary)).toEqual(records.map((_, index) => `event-${index}`));
  });

  it("preserves UTF-8 records split across byte-sized chunks", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "analyst-")), "capture.jsonl");
    await writeFile(file, `${JSON.stringify({ type: "assistant", message: { content: "분석 완료" } })}\n`);
    const indexer = new TranscriptIndexer(file, { maxReadBytes: 1 });

    await indexer.refresh();

    expect(indexer.all).toEqual([expect.objectContaining({ summary: "분석 완료", offset: 0 })]);
  });

  it("jumps to a bounded tail and marks the skipped range in the outline", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "analyst-")), "capture.jsonl");
    const tailRecord = JSON.stringify({ type: "assistant", message: { content: "tail-event" } });
    await writeFile(file, `${"x".repeat(32 * 1024 * 1024 + 1)}\n${tailRecord}\n`);
    const indexer = new TranscriptIndexer(file, { maxReadBytes: 160 });

    await indexer.refresh();

    expect(indexer.all.length).toBeGreaterThan(0);
    expect(indexer.all.at(-1)?.summary).toBe("tail-event");
    expect(indexer.outline()).toMatchObject({
      gaps: [{ startOffset: 0, endOffset: expect.any(Number), skippedBytes: expect.any(Number) }],
    });
  });
});

async function copyFixture(name: string): Promise<string> {
  const file = join(await mkdtemp(join(tmpdir(), "analyst-")), name);
  await writeFile(file, await readFile(new URL(name, fixtures)));
  return file;
}
