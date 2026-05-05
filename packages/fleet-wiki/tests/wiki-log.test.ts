import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { appendLog, formatLogEntry, parseLog } from "../src/log.js";
import { approvePatch, enqueuePatch, parsePatch, rejectPatch } from "../src/patch.js";
import { getLogFile, resolveMemoryPaths } from "../src/paths.js";
import { buildIngestToolConfig } from "../src/tools/ingest.js";
import { readPatchFile } from "../src/store.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("wiki log", () => {
  it("formats log entries with deterministic headers and bullets", async () => {
    const text = formatLogEntry({
      timestamp: "2026-05-05T12:34:56.789Z",
      event: "patch enqueued",
      payload: {
        target: "wiki/foo.md",
        patch_id: "patch-1",
        proposer: "tool:wiki_ingest",
      },
    });

    expect(text).toContain("## 2026-05-05T12:34:56.789Z — patch enqueued");
    expect(text).toContain("- patch_id: `patch-1`");
    expect(text).toContain("- proposer: `tool:wiki_ingest`");
    expect(text).toContain("- target: `wiki/foo.md`");
  });

  it("sorts payload keys deterministically", async () => {
    const text = formatLogEntry({
      timestamp: "2026-05-05T12:34:56.789Z",
      event: "patch rejected",
      payload: {
        z_key: "z",
        a_key: "a",
        m_key: "m",
      },
    });

    expect(text.indexOf("- a_key: `a`")).toBeLessThan(text.indexOf("- m_key: `m`"));
    expect(text.indexOf("- m_key: `m`")).toBeLessThan(text.indexOf("- z_key: `z`"));
  });

  it("parses appended log entries in order", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await appendLog(paths, "patch enqueued", { patch_id: "one", warning_count: 0 }, new Date("2026-05-05T00:00:00.000Z"));
    await appendLog(paths, "patch approved", { patch_id: "one", result: "accepted" }, new Date("2026-05-05T00:00:01.000Z"));

    const entries = await parseLog(paths);

    expect(entries).toHaveLength(2);
    expect(entries[0]?.event).toBe("patch enqueued");
    expect(entries[0]?.payload.patch_id).toBe("one");
    expect(entries[1]?.event).toBe("patch approved");
    expect(entries[1]?.payload.result).toBe("accepted");
  });

  it("preserves all headers during concurrent append", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await Promise.all(Array.from({ length: 10 }, (_, index) => appendLog(
      paths,
      "patch enqueued",
      { patch_id: `patch-${index}` },
      new Date(`2026-05-05T00:00:${String(index).padStart(2, "0")}.000Z`),
    )));

    const logContent = await readFile(getLogFile(paths), "utf8");
    const headerCount = (logContent.match(/^## /gm) ?? []).length;

    expect(headerCount).toBe(10);
    expect(logContent).not.toContain("## ##");
    expect(logContent).not.toContain("\n- patch_id: `patch-0`## ");
  });

  it("logs patch enqueue after queue creation", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/alpha.md"\nsummary: "Alpha"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"alpha","title":"Alpha","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"hello"}`);

    await enqueuePatch(patch, paths);
    const logContent = await readFile(getLogFile(paths), "utf8");

    expect(logContent).toContain("— patch enqueued");
    expect(logContent).toContain("- target: `wiki/alpha.md`");
  });

  it("logs index rebuilt before patch approved on approve", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/alpha.md"\nsummary: "Alpha"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"alpha","title":"Alpha","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"hello"}`);
    const patchId = await enqueuePatch(patch, paths);

    await approvePatch(patchId, paths);
    const logContent = await readFile(getLogFile(paths), "utf8");

    expect(logContent).toContain("— index rebuilt");
    expect(logContent).toContain("— patch approved");
    expect(logContent.indexOf("— index rebuilt")).toBeLessThan(logContent.indexOf("— patch approved"));
  });

  it("logs patch rejected without mutating wiki or index", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);
    const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/reject.md"\nsummary: "Reject"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"reject","title":"Reject","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"hello"}`);
    const patchId = await enqueuePatch(patch, paths);

    await rejectPatch(patchId, "nope", paths);
    const logContent = await readFile(getLogFile(paths), "utf8");

    expect(logContent).toContain("— patch rejected");
    expect(logContent).toContain("- reason: `nope`");
    await expect(readPatchFile(path.join(paths.wikiDir, "reject.md"))).rejects.toThrow();
    await expect(readPatchFile(path.join(paths.wikiDir, "index.md"))).rejects.toThrow();
  });

  it("logs raw source added before patch enqueued during ingest", async () => {
    const root = await makeTempRoot();
    const tool = buildIngestToolConfig();

    await tool.execute("test", {
      id: "alpha",
      title: "Alpha",
      source: "source material",
      source_type: "inline",
      tags: ["one"],
      body: "This is a sufficiently long wiki body that easily clears the minimum length threshold for ingestion validation and keeps enough extra words to satisfy the strict test fixture requirements.",
      proposer: "tool:wiki_ingest",
    }, undefined, undefined, { cwd: root });

    const logContent = await readFile(path.join(root, ".fleet/knowledge/log.md"), "utf8");

    expect(logContent).toContain("— raw source added");
    expect(logContent).toContain("— patch enqueued");
    expect(logContent.indexOf("— raw source added")).toBeLessThan(logContent.indexOf("— patch enqueued"));
  });
  it("survives multiline payload values without corrupting the log", async () => {
    const root = await makeTempRoot();
    const paths = resolveMemoryPaths(root);

    await appendLog(paths, "patch enqueued", {
      target: "wiki/multiline.md",
      title: "Alpha\nBreak\rWith back`tick",
      reason: "evil\\payload",
    });
    await appendLog(paths, "drydock run", { ok: true, issue_count: 0 });

    const entries = await parseLog(paths);

    expect(entries).toHaveLength(2);
    const [first] = entries;
    expect(first.event).toBe("patch enqueued");
    expect(first.payload.title).toBe("Alpha\nBreak\nWith back`tick");
    expect(first.payload.reason).toBe("evil\\payload");

    const raw = await readFile(getLogFile(paths), "utf8");
    for (const line of raw.split("\n")) {
      if (line.startsWith("- ")) {
        expect(line.split("\n")).toHaveLength(1);
      }
    }
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-log-"));
  cleanupPaths.push(root);
  return root;
}
