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
});

async function copyFixture(name: string): Promise<string> {
  const file = join(await mkdtemp(join(tmpdir(), "analyst-")), name);
  await writeFile(file, await readFile(new URL(name, fixtures)));
  return file;
}
