import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TranscriptIndexer } from "../src/transcript-indexer.js";

describe("TranscriptIndexer", () => {
  it("indexes safely, supplies stable references, and refreshes appends", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "analyst-")), "capture.jsonl");
    await writeFile(file, '{"type":"tool_use","path":"src/a.ts","timestamp":"now"}\nnot json\n');
    const indexer = new TranscriptIndexer(file); await indexer.refresh();
    expect(indexer.all).toHaveLength(1); expect(indexer.all[0]?.ref).toBe("e1"); expect(indexer.outline().fileTouchCount).toBe(1);
    await appendFile(file, '{"type":"assistant","message":{"content":"done"}}\n'); await indexer.refresh();
    expect(indexer.all.map(event => event.ref)).toEqual(["e1", "e2"]);
  });
});
