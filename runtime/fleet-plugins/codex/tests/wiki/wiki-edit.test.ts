import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryPaths } from "../../server/wiki/paths.js";
import { readCurrentEntry, withWikiWriteLock, writeEntry } from "../../server/wiki/write.js";
import { listHistory } from "../../server/wiki/history.js";
import { buildEditToolConfig } from "../../server/wiki/tools/edit.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-edit-")); roots.push(root);
  const paths = createMemoryPaths(path.join(root, "knowledge"));
  await withWikiWriteLock(paths, () => writeEntry({ id: "alpha", title: "Alpha", body: "Exact original body", tags: [], created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z", version: 1 }, "wiki/alpha.md", paths, { actor: "test", tool: "test" }));
  const call = (params: Record<string, unknown>) => buildEditToolConfig().execute("", { entry_id: "alpha", ...params }, undefined, undefined, { paths });
  return { paths, call };
}

describe("wiki_edit", () => {
  it("does not write when base_hash mismatches", async () => {
    const { paths, call } = await fixture();
    const before = await readCurrentEntry(paths, "alpha");
    const log = await readFile(path.join(paths.root, "log.md"), "utf8");
    await expect(call({ title: "Changed", base_hash: "stale" })).rejects.toThrow(/stale base_hash/);
    expect((await readCurrentEntry(paths, "alpha"))?.markdown).toBe(before?.markdown);
    expect(await listHistory(paths, "alpha")).toEqual([]);
    expect(await readFile(path.join(paths.root, "log.md"), "utf8")).toBe(log);
  });

  it("serializes simultaneous edits against the same base so only one succeeds", async () => {
    const { paths, call } = await fixture();
    const hash = (await readCurrentEntry(paths, "alpha"))!.hash;
    const results = await Promise.allSettled([call({ title: "First", base_hash: hash }), call({ body_replace: { find: "original", replace: "corrected" }, base_hash: hash })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect((await readCurrentEntry(paths, "alpha"))?.entry.version).toBe(2);
    expect(await listHistory(paths, "alpha")).toHaveLength(1);
  });
});
