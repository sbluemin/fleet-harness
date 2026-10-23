import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemoryPaths, ensureMemoryRoot } from "../../host/wiki/paths.js";
import { deleteEntry, readCurrentEntry, restoreEntry, withWikiWriteLock, writeEntry } from "../../host/wiki/write.js";
import { listHistory, readHistory } from "../../host/wiki/history.js";
import { parseLog } from "../../host/wiki/log.js";
import { readWikiEntry, writeRawSourceEntry } from "../../host/wiki/store.js";
import { writeClaims, getClaimsFile } from "../../host/wiki/claims.js";
import { runDryDock } from "../../host/wiki/drydock.js";
import { buildIngestToolConfig } from "../../host/wiki/tools/ingest.js";
import type { WikiEntry } from "../../host/wiki/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { actor: "test:writer", tool: "test" };
const entry = (id = "alpha"): WikiEntry => ({ id, title: id, tags: [], created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z", version: 1, body: "Durable wiki knowledge. ".repeat(12) });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-write-")); roots.push(root);
  const paths = createMemoryPaths(path.join(root, "knowledge")); await ensureMemoryRoot(paths);
  return { root, paths, locked: <T>(fn: () => Promise<T>) => withWikiWriteLock(paths, fn) };
}

describe("direct wiki writes", () => {
  it("rejects traversal and symlink write targets", async () => {
    const { root, paths, locked } = await fixture();
    for (const target of ["wiki/../alpha.md", "wiki//alpha.md", "/wiki/alpha.md", "wiki\\alpha.md"]) {
      await expect(locked(() => writeEntry(entry(), target, paths, options))).rejects.toThrow();
    }
    const outside = path.join(root, "outside"); await mkdir(outside);
    await symlink(outside, path.join(paths.wikiDir, "escape"));
    await expect(locked(() => writeEntry(entry(), "wiki/escape/alpha.md", paths, options))).rejects.toThrow(/symlink/);
    expect(await readdir(outside)).toEqual([]);
  });

  it("snapshots overwritten bytes and restores at a new version, failing closed without history", async () => {
    const { paths, locked } = await fixture();
    await locked(() => writeEntry(entry(), "wiki/alpha.md", paths, options));
    const old = await readFile(path.join(paths.wikiDir, "alpha.md"), "utf8");
    const update = await locked(() => writeEntry({ ...entry(), body: "Replacement body" }, "wiki/alpha.md", paths, options));
    expect((await readHistory(paths, "alpha", update.history_ref!)).markdown).toBe(old);
    const restored = await locked(() => restoreEntry("alpha", update.history_ref!, paths, options));
    expect(restored.version).toBe(3);
    expect((await readWikiEntry("alpha", paths))?.body).toBe(entry().body);
    await expect(locked(() => restoreEntry("alpha", update.history_ref!, paths, { ...options, requireAbsent: true }))).rejects.toThrow("entry_exists");
    await expect(locked(() => restoreEntry("other", update.history_ref!, paths, options))).rejects.toThrow("invalid_history_ref");
    await rm(paths.historyDir, { recursive: true }); await writeFile(paths.historyDir, "blocked");
    await expect(locked(() => writeEntry({ ...entry(), body: "Not written" }, "wiki/alpha.md", paths, options))).rejects.toThrow();
    expect((await readWikiEntry("alpha", paths))?.version).toBe(3);
  });

  it("preserves deleted entry, claims and exclusive raw, retaining shared evidence and actor audit", async () => {
    const { paths, locked } = await fixture();
    const exclusive = await writeRawSourceEntry({ id: "exclusive", created: entry().created, sourceType: "inline", tags: [], content: "Exclusive evidence" }, paths);
    const shared = await writeRawSourceEntry({ id: "shared", created: entry().created, sourceType: "inline", tags: [], content: "Shared evidence" }, paths);
    await locked(() => writeEntry({ ...entry(), rawSourceRef: exclusive, rawSourceRefs: [{ ref: exclusive }, { ref: shared }] }, "wiki/alpha.md", paths, options));
    await locked(() => writeEntry({ ...entry("beta"), rawSourceRef: shared, body: "See [[wiki:alpha]]" }, "wiki/beta.md", paths, options));
    await writeClaims({ entryId: "alpha", claims: [{ id: "fact", text: "Evidence", sourceRefs: [{ ref: exclusive }], confidence: "high" }] }, paths);
    const deleted = await locked(() => deleteEntry("alpha", paths, { ...options, reason: "mistake" }));
    expect(deleted).toMatchObject({ removed_raw_sources: [exclusive], kept_shared_raw_sources: [shared], broken_backlinks: ["beta"] });
    expect(await readWikiEntry("alpha", paths)).toBeNull();
    await expect(readFile(path.join(paths.root, exclusive))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(getClaimsFile(paths, "alpha"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(paths.root, shared), "utf8")).toContain("Shared evidence");
    const snapshot = await readHistory(paths, "alpha", deleted.history_ref);
    expect(snapshot.meta.actor).toBe(options.actor); expect(snapshot.claims).toContain("Evidence");
    expect((await parseLog(paths)).find(e => e.event === "entry deleted")?.payload.actor).toBe(options.actor);
    await locked(() => restoreEntry("alpha", deleted.history_ref, paths, options));
    expect(await readFile(getClaimsFile(paths, "alpha"), "utf8")).toBe(snapshot.claims);
    expect(await readFile(path.join(paths.root, exclusive), "utf8")).toBe(snapshot.raw[0]!.content);
  });

  it("rejects stale ingest before any raw, history or audit mutation", async () => {
    const { paths, locked } = await fixture();
    await locked(() => writeEntry(entry(), "wiki/alpha.md", paths, options));
    const log = await readFile(path.join(paths.root, "log.md"), "utf8");
    await expect(buildIngestToolConfig().execute("", { id: "alpha", title: "alpha", tags: [], body: entry().body, source: "new evidence", mode: "update", base_hash: "stale" }, undefined, undefined, { paths })).rejects.toThrow(/stale base_hash/);
    expect(await readdir(paths.rawDir)).toEqual([]); expect(await listHistory(paths, "alpha")).toEqual([]);
    expect(await readFile(path.join(paths.root, "log.md"), "utf8")).toBe(log);
    expect((await readCurrentEntry(paths, "alpha"))?.entry.version).toBe(1);
  });

  it("ignores and preserves legacy review data while drydock emits one informational notice", async () => {
    const { paths, locked } = await fixture();
    for (const [dir, status] of [["queue", "pending"], ["archive", "accepted"], ["conflicts", "unresolved"]]) {
      await mkdir(path.join(paths.root, dir!, "old"), { recursive: true });
      await writeFile(path.join(paths.root, dir!, "old", "meta.json"), JSON.stringify({ status }));
      await writeFile(path.join(paths.root, dir!, "old", "corrupt.md"), "untouched");
    }
    await locked(() => writeEntry(entry(), "wiki/alpha.md", paths, options));
    const notices = (await runDryDock(paths)).issues.filter(i => i.code === "legacy_review_data");
    expect(notices).toHaveLength(1); expect(notices[0]?.severity).toBe("info");
    for (const dir of ["queue", "archive", "conflicts"]) expect(await readFile(path.join(paths.root, dir, "old", "corrupt.md"), "utf8")).toBe("untouched");
  });
});
