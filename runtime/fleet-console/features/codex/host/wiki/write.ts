import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { getClaimsFile, listClaims } from "./claims.js";
import { readHistory, snapshotEntry } from "./history.js";
import type { HistoryMeta } from "./history.js";
import { appendLog } from "./log.js";
import { assertContainedPath, ensureMemoryRoot } from "./paths.js";
import { inferTemplateIdFromTarget, scanTemplates, validateTemplateCompliance } from "./schema.js";
import { assertNoUnsafeSecret, assertSafeEntryId, buildBacklinksIndex, computeContentHash, listWiki, parseWikiEntry, pathExists, readPatchFile, rebuildIndex, resolveWikiEntryPath, serializeWikiEntry, writeWikiEntryAtTarget } from "./store.js";
import type { MemoryPaths, WikiEntry } from "./types.js";

// 도구와 Console 경로가 공유하는 프로세스 내 knowledge-root 단위 잠금이다.
const writeLocks = new Map<string, Promise<void>>();

export async function withWikiWriteLock<T>(paths: MemoryPaths, fn: () => Promise<T>): Promise<T> {
  await mkdir(paths.root, { recursive: true });
  const key = await realpath(paths.root);
  const previous = writeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => current);
  writeLocks.set(key, queued);
  await previous;
  try {
    await ensureMemoryRoot(paths);
    return await fn();
  } finally {
    release();
    if (writeLocks.get(key) === queued) writeLocks.delete(key);
  }
}

export interface WriteOptions {
  actor: string;
  tool: string;
  base_version?: number;
  base_hash?: string;
  op?: "create_wiki" | "update_wiki";
  historyOp?: HistoryMeta["op"];
  touch_updated?: boolean;
  changed_fields?: string[];
  reason?: string;
}

export class StaleEntryBaseError extends Error {
  constructor(message: string, readonly currentHash: string) { super(message); }
}

export async function readCurrentEntry(paths: MemoryPaths, id: string) {
  assertSafeEntryId(id);
  const target = await resolveWikiEntryPath(id, paths);
  if (!target) return null;
  await assertContainedPath(paths, target);
  const markdown = await readPatchFile(path.join(paths.root, target));
  return { target, markdown, entry: parseWikiEntry(markdown), hash: computeContentHash(markdown) };
}

export function checkEntryBase(id: string, current: Awaited<ReturnType<typeof readCurrentEntry>>, options: Pick<WriteOptions, "tool" | "base_version" | "base_hash">): void {
  for (const [field, expected, actual] of [["base_version", options.base_version, current?.entry.version], ["base_hash", options.base_hash, current?.hash]] as const) {
    if (expected !== undefined && expected !== actual) throw new StaleEntryBaseError(`[fleet-wiki] ${options.tool} stale ${field} for ${id}: expected ${expected}, current ${actual ?? "missing"} (hash ${current?.hash ?? "missing"})`, current?.hash ?? "");
  }
}

/** 호출자는 계획부터 적용 완료까지 withWikiWriteLock을 유지한다. */
export async function prepareEntry(entry: WikiEntry, target: string, paths: MemoryPaths, options: WriteOptions): Promise<WikiEntry> {
  assertSafeEntryId(entry.id);
  if (!target.startsWith("wiki/") || !target.endsWith(".md") || path.posix.basename(target, ".md") !== entry.id) throw new Error("wiki entry id must match target filename under wiki/");
  await assertContainedPath(paths, target);
  assertNoUnsafeSecret(entry.body);
  const current = await readCurrentEntry(paths, entry.id);
  checkEntryBase(entry.id, current, options);
  if (current && (options.op === "create_wiki" || current.target !== target)) throw new Error(`create_wiki target already exists: ${entry.id}`);
  if (!current && options.op === "update_wiki") throw new Error(`update_wiki target does not exist: ${entry.id}`);
  if (!current && await pathExists(path.join(paths.root, target))) throw new Error(`create_wiki target already exists: ${target}`);
  for (const ref of entryRawRefs(entry)) {
    if (!ref.startsWith("raw/") || !ref.endsWith(".md")) throw new Error("raw source provenance must point into raw/");
    await assertContainedPath(paths, ref);
  }
  const templateId = entry.templateId ?? current?.entry.templateId ?? inferTemplateIdFromTarget(target, (await scanTemplates(paths)).map(t => t.id));
  await validateTemplateCompliance(paths, templateId, entry.body);
  return { ...entry, templateId, version: (current?.entry.version ?? 0) + 1, created: current?.entry.created ?? entry.created, updated: options.touch_updated === false ? current?.entry.updated ?? entry.updated : new Date().toISOString() };
}

/** beforeWrite는 모든 검증과 이전 본문 보관 뒤에만 raw를 기록한다. */
export async function writeEntry(entry: WikiEntry, target: string, paths: MemoryPaths, options: WriteOptions, beforeWrite?: (entry: WikiEntry) => Promise<WikiEntry>) {
  let next = await prepareEntry(entry, target, paths, options);
  const current = await readCurrentEntry(paths, entry.id);
  const historyRef = current ? await snapshotEntry(paths, current.markdown, { entryId: entry.id, target, op: options.historyOp ?? "update", actor: options.actor, raw: [], ...(options.reason ? { reason: options.reason } : {}) }) : undefined;
  if (beforeWrite) next = await beforeWrite(next);
  await writeWikiEntryAtTarget(next, target, paths);
  await rebuildIndex(paths);
  const hash = computeContentHash(serializeWikiEntry(next));
  await auditEntry(paths, current ? "entry updated" : "entry created", entry.id, target, next.version, hash, current, historyRef, next.rawSourceRef, options);
  return { entry_id: next.id, target, version: next.version, hash, ...(historyRef ? { history_ref: historyRef } : {}) };
}

export function entryRawRefs(entry: WikiEntry): string[] {
  return [...new Set([entry.rawSourceRef, ...(entry.rawSourceRefs?.map(item => item.ref) ?? [])].filter((ref): ref is string => !!ref))];
}

export async function deleteEntry(id: string, paths: MemoryPaths, options: WriteOptions) {
  const current = await readCurrentEntry(paths, id);
  if (!current) throw new Error("entry_not_found");
  checkEntryBase(id, current, options);
  const [entries, claims] = await Promise.all([listWiki(paths), listClaims(paths)]);
  const otherRefs = new Set([...entries.filter(e => e.id !== id).flatMap(entryRawRefs), ...claims.filter(c => c.entryId !== id).flatMap(c => c.claims.flatMap(claim => claim.sourceRefs.map(source => source.ref)))]);
  const refs = [...new Set([...entryRawRefs(current.entry), ...claims.filter(c => c.entryId === id).flatMap(c => c.claims.flatMap(claim => claim.sourceRefs.map(source => source.ref)))])];
  const raw: Array<{ ref: string; content: string }> = [];
  for (const ref of refs.filter(ref => !otherRefs.has(ref))) {
    if (!ref.startsWith("raw/") || !ref.endsWith(".md")) throw new Error("invalid raw source ref");
    await assertContainedPath(paths, ref);
    try { raw.push({ ref, content: await readFile(path.join(paths.root, ref), "utf8") }); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  }
  const claimsFile = getClaimsFile(paths, id);
  await assertContainedPath(paths, path.relative(paths.root, claimsFile).split(path.sep).join("/"));
  const claimsText = await pathExists(claimsFile) ? await readFile(claimsFile, "utf8") : undefined;
  const historyRef = await snapshotEntry(paths, current.markdown, { entryId: id, target: current.target, op: "delete", actor: options.actor, raw: raw.map(r => r.ref), ...(options.reason ? { reason: options.reason } : {}) }, { claims: claimsText, raw });
  await rm(path.join(paths.root, current.target));
  await rm(claimsFile, { force: true });
  for (const item of raw) await rm(path.join(paths.root, item.ref));
  await rebuildIndex(paths);
  await auditEntry(paths, "entry deleted", id, current.target, current.entry.version + 1, null, current, historyRef, current.entry.rawSourceRef, options);
  return { entry_id: id, history_ref: historyRef, removed_raw_sources: raw.map(r => r.ref), kept_shared_raw_sources: refs.filter(ref => otherRefs.has(ref)), broken_backlinks: [...(buildBacklinksIndex(entries).get(id) ?? [])].filter(backlink => backlink !== id) };
}

export async function restoreEntry(id: string, ref: string, paths: MemoryPaths, options: WriteOptions & { requireAbsent?: boolean }) {
  const current = await readCurrentEntry(paths, id);
  if (options.requireAbsent && current) throw new Error("entry_exists");
  const snapshot = await readHistory(paths, id, ref);
  checkEntryBase(id, current, options);
  const entry = parseWikiEntry(snapshot.markdown);
  const next = await prepareEntry(entry, snapshot.meta.target, paths, { ...options, op: undefined });
  next.version = Math.max(current?.entry.version ?? 0, snapshot.meta.version) + 1;
  const warnings: string[] = [];
  const extras = [...snapshot.raw, ...(snapshot.claims !== undefined ? [{ ref: path.relative(paths.root, getClaimsFile(paths, id)).split(path.sep).join("/"), content: snapshot.claims }] : [])];
  // 모든 복구 경로를 먼저 검증한다. 기존의 다른 근거는 덮어쓰지 않는다.
  for (const item of extras) await assertContainedPath(paths, item.ref);
  const historyRef = current ? await snapshotEntry(paths, current.markdown, { entryId: id, target: current.target, op: "restore", actor: options.actor, raw: [] }) : undefined;
  for (const item of extras) {
    const file = path.join(paths.root, item.ref);
    await mkdir(path.dirname(file), { recursive: true });
    try { await writeFile(file, item.content, { flag: "wx" }); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (await readFile(file, "utf8") !== item.content) warnings.push(`Existing content differs; preserved ${item.ref}`);
    }
  }
  await writeWikiEntryAtTarget(next, snapshot.meta.target, paths);
  await rebuildIndex(paths);
  const hash = computeContentHash(serializeWikiEntry(next));
  await auditEntry(paths, "entry restored", id, snapshot.meta.target, next.version, hash, current, historyRef ?? ref, next.rawSourceRef, options);
  return { entry_id: id, version: next.version, hash, history_ref: historyRef ?? ref, warnings };
}

async function auditEntry(paths: MemoryPaths, event: "entry created" | "entry updated" | "entry deleted" | "entry restored", id: string, target: string, version: number, hash: string | null, previous: Awaited<ReturnType<typeof readCurrentEntry>>, historyRef: string | undefined, rawSourceRef: string | undefined, options: WriteOptions) {
  await appendLog(paths, event, { actor: options.actor, tool: options.tool, entry_id: id, target, version, previous_version: previous?.entry.version ?? null, previous_hash: previous?.hash ?? null, hash, history_ref: historyRef ?? null, raw_source_ref: rawSourceRef ?? null, reason: options.reason ?? null, changed_fields: options.changed_fields ?? null });
}
