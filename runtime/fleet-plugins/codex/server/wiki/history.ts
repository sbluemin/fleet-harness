import { constants } from "node:fs";
import { mkdir, open, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NOFOLLOW_FLAG } from "@fleet-console/infra/fs-store";

import { assertContainedPath } from "./paths.js";
import { assertSafeEntryId, computeContentHash, parseWikiEntry } from "./store.js";
import type { MemoryPaths } from "./types.js";

export interface HistoryMeta {
  schemaVersion: 1;
  entryId: string;
  target: string;
  op: "update" | "edit" | "delete" | "restore";
  actor: string;
  at: string;
  version: number;
  hash: string;
  reason?: string;
  raw: string[];
}

export async function snapshotEntry(paths: MemoryPaths, markdown: string, meta: Omit<HistoryMeta, "schemaVersion" | "version" | "hash" | "at">, extras?: { claims?: string; raw: Array<{ ref: string; content: string }> }): Promise<string> {
  assertSafeEntryId(meta.entryId);
  const at = new Date().toISOString();
  const parent = `history/${meta.entryId}`;
  await assertContainedPath(paths, parent);
  await mkdir(path.join(paths.root, parent), { recursive: true });
  const stem = `${at.replace(/[:.]/g, "-")}-${meta.op}-v${parseWikiEntry(markdown).version}`;
  let ref = `${parent}/${stem}`;
  for (let suffix = 2; ; suffix++) {
    try { await mkdir(path.join(paths.root, ref)); break; }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      ref = `${parent}/${stem}-${suffix}`;
    }
  }
  await writeFile(path.join(paths.root, ref, "entry.md"), markdown, { flag: "wx" });
  if (extras?.claims !== undefined) await writeFile(path.join(paths.root, ref, "claims.json"), extras.claims, { flag: "wx" });
  for (const raw of extras?.raw ?? []) {
    await assertContainedPath(paths, raw.ref);
    const file = path.join(paths.root, ref, raw.ref);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, raw.content, { flag: "wx" });
  }
  // meta를 완성 표식으로 써서 불완전한 snapshot은 복구 목록에 올리지 않는다.
  await writeFile(path.join(paths.root, ref, "meta.json"), JSON.stringify({ ...meta, schemaVersion: 1, at, version: parseWikiEntry(markdown).version, hash: computeContentHash(markdown) } satisfies HistoryMeta, null, 2), { flag: "wx" });
  return ref;
}

export function validateHistoryRef(entryId: string, ref: string): void {
  assertSafeEntryId(entryId);
  if (!new RegExp(`^history/${entryId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z-(update|edit|delete|restore)-v[0-9]+(?:-[0-9]+)?$`).test(ref)) throw new Error("invalid_history_ref");
}

async function readBounded(paths: MemoryPaths, relative: string, limit = 1024 * 1024): Promise<string> {
  await assertContainedPath(paths, relative);
  const handle = await open(path.join(paths.root, relative), constants.O_RDONLY | NOFOLLOW_FLAG);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("invalid_history_ref");
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) throw new Error("invalid_history_ref");
    return bytes.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

async function readExtra(paths: MemoryPaths, relative: string): Promise<string> {
  await assertContainedPath(paths, relative);
  const handle = await open(path.join(paths.root, relative), constants.O_RDONLY | NOFOLLOW_FLAG);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("invalid_history_ref");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

async function readHistoryMeta(paths: MemoryPaths, entryId: string, ref: string): Promise<HistoryMeta> {
  validateHistoryRef(entryId, ref);
  const meta = JSON.parse(await readBounded(paths, `${ref}/meta.json`)) as HistoryMeta;
  if (meta.schemaVersion !== 1 || meta.entryId !== entryId || !Number.isSafeInteger(meta.version) || meta.version < 1 || !Array.isArray(meta.raw) || typeof meta.target !== "string" || typeof meta.at !== "string" || !Number.isFinite(Date.parse(meta.at)) || typeof meta.actor !== "string" || !["update", "edit", "delete", "restore"].includes(meta.op)) throw new Error("invalid_history_ref");
  return meta;
}

export async function readHistory(paths: MemoryPaths, entryId: string, ref: string): Promise<{ meta: HistoryMeta; markdown: string; claims?: string; raw: Array<{ ref: string; content: string }> }> {
  const meta = await readHistoryMeta(paths, entryId, ref);
  const markdown = await readBounded(paths, `${ref}/entry.md`);
  const entry = parseWikiEntry(markdown);
  if (entry.id !== entryId || meta.version !== entry.version || meta.hash !== computeContentHash(markdown)) throw new Error("invalid_history_ref");
  let claims: string | undefined;
  try { claims = await readExtra(paths, `${ref}/claims.json`); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const raw = [];
  for (const rawRef of meta.raw) {
    if (typeof rawRef !== "string" || !/^raw\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.md$/.test(rawRef)) throw new Error("invalid_history_ref");
    raw.push({ ref: rawRef, content: await readExtra(paths, `${ref}/${rawRef}`) });
  }
  return { meta, markdown, claims, raw };
}

export async function listHistory(paths: MemoryPaths, entryId: string): Promise<Array<HistoryMeta & { history_ref: string }>> {
  assertSafeEntryId(entryId);
  await assertContainedPath(paths, `history/${entryId}`);
  let names: string[];
  try { names = await readdir(path.join(paths.historyDir, entryId)); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return []; throw error; }
  const items = [];
  for (const name of names.sort().reverse()) {
    try {
      const ref = `history/${entryId}/${name}`;
      const meta = await readHistoryMeta(paths, entryId, ref);
      items.push({ ...meta, history_ref: ref });
    } catch { /* 불완전하거나 손상된 snapshot은 복구 목록에서 제외한다. */ }
  }
  return items.sort((a, b) => b.at.localeCompare(a.at) || b.version - a.version || b.history_ref.localeCompare(a.history_ref)).slice(0, 50);
}
