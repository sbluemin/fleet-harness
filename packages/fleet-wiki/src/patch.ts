import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { createConflict } from "./conflicts.js";
import { PATCH_FILENAME, PATCH_META_FILENAME } from "./constants.js";
import { appendLog } from "./log.js";
import { readPatchSet } from "./patch-set.js";
import { ensureMemoryRoot } from "./paths.js";
import { ensureWorkspaceSchema, inferTemplateIdFromTarget, validateTemplateCompliance } from "./schema.js";
import {
  assertSafeEntryId,
  computeContentHash,
  listDirectoryNames,
  movePath,
  pathExists,
  readJsonFile,
  readPatchFile,
  readWikiEntry,
  rebuildIndex,
  removePath,
  writeJsonFile,
  writePatchFile,
  writeWikiEntryAtTarget,
} from "./store.js";
import type { ConflictReason, MemoryPaths, Patch, PatchMeta, WikiEntry } from "./types.js";

export interface QueueSelection {
  id: string;
  autoSelected: boolean;
  availableIds: string[];
}

export interface PatchSetApprovalResult {
  patch_set_id: string;
  status: "accepted" | "partial";
  accepted: PatchMeta[];
  failed: Array<{ patch_id: string; error: string }>;
  missing: string[];
}

const INLINE_RAW_SOURCE_REF_PATTERN = /(?:\n+)raw_source_ref:\s*(\S+)\s*$/i;
// 단일 Node 프로세스 안의 승인 경합만 막는다. 프로세스 간 atomic 보장은 별도 file lock/CAS 후속 주제다.
const approvalLocks = new Map<string, Promise<void>>();
// 단일 Node 프로세스 안의 patch edit CAS만 막는다. 프로세스 간 atomic 보장은 별도 file lock/CAS 후속 주제다.
const patchEditLocks = new Map<string, Promise<void>>();

export async function parsePatch(markdown: string): Promise<Patch> {
  const match = markdown.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error("missing patch frontmatter");
  const [, rawFrontmatter, body] = match;
  const frontmatter: Record<string, string> = {};
  for (const line of rawFrontmatter.split("\n")) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator === -1) throw new Error(`invalid patch frontmatter line: ${line}`);
    frontmatter[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  return {
    frontmatter: {
      op: frontmatter.op as Patch["frontmatter"]["op"],
      target: frontmatter.target ?? "",
      summary: frontmatter.summary ?? "",
      proposer: frontmatter.proposer ?? "",
      created: frontmatter.created ?? "",
    },
    body,
  };
}

export async function validatePatch(patch: Patch, paths: MemoryPaths): Promise<void> {
  const { op, target, summary, proposer, created } = patch.frontmatter;
  if (!["create_wiki", "update_wiki"].includes(op)) throw new Error("invalid patch op");
  if (!target || !summary || !proposer || !created) throw new Error("patch frontmatter is incomplete");
  if (summary.length > 120) throw new Error("patch summary exceeds 120 chars");
  assertCanonicalPatchTarget(target);

  const absoluteTarget = path.resolve(paths.root, target);
  if (!absoluteTarget.startsWith(`${paths.root}${path.sep}`) && absoluteTarget !== paths.root) {
    throw new Error("patch target escapes wiki root");
  }

  if (!absoluteTarget.startsWith(`${paths.wikiDir}${path.sep}`)) throw new Error("wiki patch must target wiki/");
  assertNoSymlinkPathComponents(target, paths);
  if (op === "create_wiki" && (await pathExists(absoluteTarget))) {
    throw new Error(
      `[fleet-wiki] create_wiki target already exists: ${target} - use update_wiki to modify existing entries`,
    );
  }
  if (op === "update_wiki" && !(await pathExists(absoluteTarget))) throw new Error("update_wiki target does not exist");
}

export async function applyPatch(patch: Patch, paths: MemoryPaths): Promise<string> {
  await validatePatch(patch, paths);
  await validatePatchBase(patch, undefined, paths);
  await ensureWorkspaceSchema(paths);

  const entry = await normalizeWikiEntryPatch(JSON.parse(patch.body) as WikiEntry, patch.frontmatter.target, paths);
  const relativePath = await writeWikiEntryAtTarget(entry, patch.frontmatter.target, paths);
  await rebuildIndex(paths);
  return relativePath;
}

export async function enqueuePatch(patch: Patch, paths: MemoryPaths, metaOverrides?: Partial<PatchMeta>): Promise<string> {
  await ensureMemoryRoot(paths);
  const patchId = buildPatchId(patch.frontmatter.created, patch.frontmatter.summary, patch.frontmatter.target, patch.body);
  const queueDir = path.join(paths.queueDir, patchId);
  if (await pathExists(queueDir)) {
    throw new Error(`[fleet-wiki] patch id collision: ${patchId} - this should never happen with target+body hashing`);
  }
  await mkdir(queueDir, { recursive: true });
  await writePatchFile(path.join(queueDir, PATCH_FILENAME), serializePatch(patch), paths);
  const meta: PatchMeta = {
    id: patchId,
    status: "pending",
    createdAt: patch.frontmatter.created,
    ...metaOverrides,
  };
  await writeJsonFile(path.join(queueDir, PATCH_META_FILENAME), meta satisfies PatchMeta, paths);
  await appendLog(paths, "patch enqueued", {
    patch_id: patchId,
    patch_set_id: meta.patch_set_id ?? null,
    op: patch.frontmatter.op,
    proposer: patch.frontmatter.proposer,
    raw_source_ref: meta.rawSourceRef ?? null,
    target: patch.frontmatter.target,
    warning_count: meta.warnings?.length ?? 0,
  });
  return patchId;
}

export async function listQueue(paths: MemoryPaths): Promise<Array<{ id: string; meta: PatchMeta }>> {
  const ids = await listDirectoryNames(paths.queueDir);
  const results: Array<{ id: string; meta: PatchMeta }> = [];
  for (const id of ids) {
    if (id === "_sets") continue;
    try {
      const meta = await readJsonFile<PatchMeta>(path.join(paths.queueDir, id, PATCH_META_FILENAME));
      results.push({ id, meta });
    } catch {
      // Corrupted queue entry (missing/malformed meta.json). Skip silently here so
      // listing surfaces stay useful; wiki_drydock reports it as malformed_queue.
      continue;
    }
  }
  return results;
}

export async function resolveQueueSelection(id: string, paths: MemoryPaths): Promise<QueueSelection> {
  const normalizedId = id.trim();
  const items = await listQueue(paths);
  const availableIds = items.map((item) => item.id);

  if (normalizedId) {
    if (availableIds.includes(normalizedId)) {
      return { id: normalizedId, autoSelected: false, availableIds };
    }
    throw new Error(buildQueueIdHelp("Unknown patch ID", availableIds));
  }

  if (availableIds.length === 1) {
    return { id: availableIds[0]!, autoSelected: true, availableIds };
  }

  throw new Error(buildQueueIdHelp("Patch ID is required", availableIds));
}

export async function showQueue(id: string, paths: MemoryPaths): Promise<{ patch: Patch; meta: PatchMeta }> {
  const selection = await resolveQueueSelection(id, paths);
  const queueDir = path.join(paths.queueDir, selection.id);
  const patch = await parsePatch(await readPatchFile(path.join(queueDir, PATCH_FILENAME)));
  const meta = await readJsonFile<PatchMeta>(path.join(queueDir, PATCH_META_FILENAME));
  return { patch, meta };
}

export async function rewriteQueuedPatch(
  id: string,
  paths: MemoryPaths,
  patch: Patch,
  meta: PatchMeta,
  expectedPatchHash?: string,
): Promise<string> {
  assertSafeQueueId(id);
  return withPatchEditLock(paths, id, async () => {
    const queueDir = path.join(paths.queueDir, id);
    if (expectedPatchHash !== undefined) {
      const currentMarkdown = await readPatchFile(path.join(queueDir, PATCH_FILENAME));
      const currentHash = computeContentHash(currentMarkdown);
      if (currentHash !== expectedPatchHash) {
        throw new Error(`[fleet-wiki] wiki_patch_edit stale base_patch_hash: expected ${currentHash}, got ${expectedPatchHash}`);
      }
    }
    const patchMarkdown = serializePatch(patch);
    const patchHash = computeContentHash(patchMarkdown);
    const nextMeta = { ...meta, lastEditHash: patchHash } satisfies PatchMeta;
    await writePatchFile(path.join(queueDir, PATCH_FILENAME), patchMarkdown, paths);
    await writeJsonFile(path.join(queueDir, PATCH_META_FILENAME), nextMeta, paths);
    return patchHash;
  });
}

export async function approvePatch(id: string, paths: MemoryPaths): Promise<PatchMeta> {
  assertSafeQueueId(id);
  return withPatchEditLock(paths, id, async () => {
    const { patch, meta } = await showQueue(id, paths);
    if (meta.status !== "pending") throw new Error("patch is not pending");
    try {
      await withApprovalLock(paths, patch, async () => {
        await validatePatchBase(patch, meta, paths);
        await applyPatch(patch, paths);
      });
    } catch (error) {
      const reason = classifyPatchConflict(error);
      if (reason) {
        const conflictId = await recordPatchConflict(patch, paths, reason, {
          baseHash: meta.baseHash,
          baseVersion: meta.baseVersion,
          patchId: id,
          rawSourceRef: meta.rawSourceRef,
          warnings: meta.warnings,
        });
        const queueDir = path.join(paths.queueDir, id);
        await writeJsonFile(path.join(queueDir, PATCH_META_FILENAME), {
          ...meta,
          conflictId,
        } satisfies PatchMeta, paths);
      }
      throw error;
    }
    const nextMeta: PatchMeta = {
      ...meta,
      status: "accepted",
      decidedAt: new Date().toISOString(),
    };
    await archiveQueueEntry(id, paths, nextMeta);
    await appendLog(paths, "patch approved", {
      op: patch.frontmatter.op,
      patch_id: id,
      patch_set_id: nextMeta.patch_set_id ?? null,
      proposer: patch.frontmatter.proposer,
      raw_source_ref: nextMeta.rawSourceRef ?? null,
      result: "accepted",
      target: patch.frontmatter.target,
    });
    return nextMeta;
  });
}

function assertSafeQueueId(id: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/.test(id)) {
    throw new Error("patch_id must be a non-empty canonical queue ID");
  }
}

export async function approvePatchSet(patchSetId: string, paths: MemoryPaths): Promise<PatchSetApprovalResult> {
  const patchSet = await readPatchSet(paths, patchSetId);
  const accepted: PatchMeta[] = [];
  const failed: Array<{ patch_id: string; error: string }> = [];
  const missing: string[] = [];

  for (const patchId of patchSet.patchIds) {
    const queueDir = path.join(paths.queueDir, patchId);
    if (!(await pathExists(queueDir))) {
      missing.push(patchId);
      continue;
    }
    try {
      accepted.push(await approvePatch(patchId, paths));
    } catch (error) {
      failed.push({
        patch_id: patchId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const status = failed.length === 0 && missing.length === 0 ? "accepted" : "partial";
  await appendLog(paths, status === "accepted" ? "patch set approved" : "patch set partially approved", {
    accepted_count: accepted.length,
    failed_count: failed.length,
    missing_count: missing.length,
    patch_set_id: patchSetId,
    source_ref: patchSet.sourceRef,
  });

  return {
    patch_set_id: patchSetId,
    status,
    accepted,
    failed,
    missing,
  };
}

export async function rejectPatch(id: string, reason: string, paths: MemoryPaths): Promise<PatchMeta> {
  assertSafeQueueId(id);
  return withPatchEditLock(paths, id, async () => {
    const { meta } = await showQueue(id, paths);
    if (meta.status !== "pending") throw new Error("patch is not pending");
    const nextMeta: PatchMeta = {
      ...meta,
      status: "rejected",
      decidedAt: new Date().toISOString(),
      reason,
    };
    await archiveQueueEntry(id, paths, nextMeta);
    await appendLog(paths, "patch rejected", {
      patch_id: id,
      patch_set_id: nextMeta.patch_set_id ?? null,
      reason,
      result: "rejected",
    });
    return nextMeta;
  });
}

export function serializePatch(patch: Patch): string {
  const lines = [
    `op: "${patch.frontmatter.op}"`,
    `target: "${patch.frontmatter.target}"`,
    `summary: "${patch.frontmatter.summary}"`,
    `proposer: "${patch.frontmatter.proposer}"`,
    `created: "${patch.frontmatter.created}"`,
  ];
  return `---\n${lines.join("\n")}\n---\n${patch.body}`;
}

async function normalizeWikiEntryPatch(entry: WikiEntry, target: string, paths: MemoryPaths): Promise<WikiEntry> {
  assertSafeEntryId(entry.id);
  if (entry.id !== path.basename(target, ".md")) {
    throw new Error("wiki patch body id must match target filename");
  }
  const inlineRawSourceRef = extractInlineRawSourceRef(entry.body);
  if (inlineRawSourceRef && entry.rawSourceRef && entry.rawSourceRef !== inlineRawSourceRef.rawSourceRef) {
    throw new Error("conflicting raw source provenance in wiki patch");
  }
  const rawSourceRef = entry.rawSourceRef ?? inlineRawSourceRef?.rawSourceRef;
  if (rawSourceRef) {
    assertSafeRawSourceRef(rawSourceRef, paths);
  }
  const currentEntry = await readWikiEntry(entry.id, paths);
  const templateId = entry.templateId ?? currentEntry?.templateId ?? inferTemplateIdFromTarget(target);
  const body = inlineRawSourceRef ? inlineRawSourceRef.body : entry.body;
  try {
    await validateTemplateCompliance(paths, templateId, body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[fleet-wiki] template approval failed for ${target} using template "${templateId ?? "(none)"}": ${message}`);
  }
  return {
    ...entry,
    body,
    rawSourceRef,
    templateId,
  };
}

function extractInlineRawSourceRef(body: string): { body: string; rawSourceRef: string } | null {
  const match = body.match(INLINE_RAW_SOURCE_REF_PATTERN);
  if (!match) return null;
  return {
    body: body.replace(INLINE_RAW_SOURCE_REF_PATTERN, "").trimEnd(),
    rawSourceRef: match[1]!,
  };
}

function buildPatchId(createdAt: string, summary: string, target: string, body: string): string {
  const compact = createdAt.replace(/[:.]/g, "-");
  // Hash includes target + body (not just summary) so that compile_source-style
  // batches sharing a single timestamp + summary still produce distinct queue dirs.
  const hash = createHash("sha256")
    .update(`${summary}\u0001${target}\u0001${body}`, "utf8")
    .digest("hex")
    .slice(0, 8);
  return `${compact}-${hash}`;
}

async function validatePatchBase(patch: Patch, meta: PatchMeta | undefined, paths: MemoryPaths): Promise<void> {
  if (patch.frontmatter.op !== "update_wiki" || (!meta?.baseVersion && !meta?.baseHash)) return;

  const wikiId = path.basename(patch.frontmatter.target, ".md");
  const currentEntry = await readWikiEntry(wikiId, paths);
  const currentPath = path.join(paths.root, patch.frontmatter.target);
  const currentMarkdown = await pathExists(currentPath) ? await readPatchFile(currentPath) : undefined;
  if (meta.baseVersion !== undefined && currentEntry?.version !== meta.baseVersion) {
    throw new Error(
      `[fleet-wiki] approve stale base_version for ${wikiId}: expected ${meta.baseVersion}, got ${currentEntry?.version ?? "missing"}`,
    );
  }
  if (meta.baseHash !== undefined && computeContentHash(currentMarkdown ?? "") !== meta.baseHash) {
    throw new Error(
      `[fleet-wiki] approve stale base_hash for ${wikiId}: expected ${meta.baseHash}, got ${currentMarkdown ? computeContentHash(currentMarkdown) : "missing"}`,
    );
  }
}

async function withApprovalLock<T>(paths: MemoryPaths, patch: Patch, action: () => Promise<T>): Promise<T> {
  await ensureMemoryRoot(paths);
  const key = canonicalApprovalLockKey(paths, patch.frontmatter.target);
  const previous = approvalLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current, () => current);
  approvalLocks.set(key, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (approvalLocks.get(key) === queued) {
      approvalLocks.delete(key);
    }
  }
}

async function withPatchEditLock<T>(paths: MemoryPaths, patchId: string, action: () => Promise<T>): Promise<T> {
  const key = canonicalPatchEditLockKey(paths, patchId);
  const previous = patchEditLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current, () => current);
  patchEditLocks.set(key, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (patchEditLocks.get(key) === queued) {
      patchEditLocks.delete(key);
    }
  }
}

function assertCanonicalPatchTarget(target: string): void {
  if (target.includes("\\")) {
    throw new Error("patch target must use forward slashes");
  }
  if (target.endsWith("/")) {
    throw new Error("patch target must not end with a slash");
  }
  if (target.startsWith("/") || path.posix.isAbsolute(target) || path.win32.isAbsolute(target)) {
    throw new Error("patch target must be relative");
  }
  if (path.posix.normalize(target) !== target) {
    throw new Error("patch target must not contain dot segments or redundant separators");
  }
}

function canonicalApprovalLockKey(paths: MemoryPaths, target: string): string {
  const wikiRoot = realpathSync(paths.wikiDir);
  const relativeTarget = path.posix.relative("wiki", target);
  const targetPath = path.join(wikiRoot, ...relativeTarget.split("/"));
  // case-insensitive FS alias race 차단을 위해 의도적으로 보수적인 lower-case 잠금을 적용한다.
  return `${wikiRoot}\u0000${targetPath}`.toLowerCase();
}

function canonicalPatchEditLockKey(paths: MemoryPaths, patchId: string): string {
  return `${realpathSync(paths.queueDir)}\u0000${patchId}`;
}

function assertNoSymlinkPathComponents(target: string, paths: MemoryPaths): void {
  const parts = target.split("/").slice(1);
  let current: string;
  try {
    current = realpathSync(paths.wikiDir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error("patch target must not include symlink path components");
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }
}

function assertSafeRawSourceRef(rawSourceRef: string, paths: MemoryPaths): void {
  if (!rawSourceRef.startsWith("raw/")) {
    throw new Error("raw source provenance must point into raw/");
  }
  const absoluteRef = path.resolve(paths.root, rawSourceRef);
  if (!absoluteRef.startsWith(`${paths.rawDir}${path.sep}`)) {
    throw new Error("raw source provenance must point into raw/");
  }
}

function classifyPatchConflict(error: unknown): ConflictReason | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("create_wiki target already exists")) return "create_target_exists";
  if (message.includes("update_wiki target does not exist")) return "update_target_missing";
  if (message.includes("wiki patch body id must match target filename")) return "patch_body_target_mismatch";
  if (message.includes("conflicting raw source provenance in wiki patch")) return "source_provenance_conflict";
  if (message.includes("approve stale base_version")) return "base_version_mismatch";
  if (message.includes("approve stale base_hash")) return "base_hash_mismatch";
  return null;
}

async function recordPatchConflict(
  patch: Patch,
  paths: MemoryPaths,
  reason: ConflictReason,
  options?: { baseHash?: string; baseVersion?: number; patchId?: string; rawSourceRef?: string; warnings?: string[] },
): Promise<string> {
  const now = new Date();
  const targetPath = path.join(paths.root, patch.frontmatter.target);
  const current = await pathExists(targetPath) ? await readPatchFile(targetPath) : undefined;
  const currentEntry = current ? parseStoredWikiEntry(current) : undefined;
  const proposedEntry = parsePatchBodyEntry(patch.body);
  const record = await createConflict({
    reason,
    target: patch.frontmatter.target,
    wikiId: proposedEntry?.id ?? path.basename(patch.frontmatter.target, ".md"),
    title: proposedEntry?.title,
    proposer: patch.frontmatter.proposer,
    rawSourceRef: options?.rawSourceRef,
    current,
    proposed: serializeConflictProposed(proposedEntry, patch.body),
    patchId: options?.patchId,
    currentVersion: currentEntry?.version,
    proposedVersion: proposedEntry?.version,
    baseVersion: options?.baseVersion,
    baseHash: options?.baseHash,
    currentHash: current ? computeContentHash(current) : undefined,
    warnings: options?.warnings,
    now,
  }, paths);
  await appendLog(paths, "conflict detected", {
    conflict_id: record.meta.id,
    patch_id: options?.patchId ?? null,
    raw_source_ref: options?.rawSourceRef ?? null,
    reason,
    target: patch.frontmatter.target,
    wiki_id: record.meta.wikiId,
  }, now);
  return record.meta.id;
}

function parsePatchBodyEntry(content: string): WikiEntry | undefined {
  try {
    return JSON.parse(content) as WikiEntry;
  } catch {
    return undefined;
  }
}

function parseStoredWikiEntry(content: string): WikiEntry | undefined {
  const match = content.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return undefined;
  const [, rawFrontmatter, body] = match;
  const frontmatter = new Map<string, string>();
  for (const line of rawFrontmatter.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    frontmatter.set(
      line.slice(0, separator).trim(),
      line.slice(separator + 1).trim().replace(/^"(.*)"$/, "$1"),
    );
  }
  const id = frontmatter.get("id");
  const title = frontmatter.get("title");
  const created = frontmatter.get("created");
  const updated = frontmatter.get("updated");
  const version = frontmatter.get("version");
  const tags = frontmatter.get("tags");
  if (!id || !title || !created || !updated || !version || !tags) return undefined;
  return {
    id,
    title,
    tags: parseInlineArray(tags),
    created,
    updated,
    version: Number(version),
    rawSourceRef: frontmatter.get("rawSourceRef"),
    body,
  };
}

function serializeConflictProposed(entry: WikiEntry | undefined, fallback: string): string {
  if (!entry) return fallback;
  const lines = [
    `id: ${serializeFrontmatterValue(entry.id)}`,
    `title: ${serializeFrontmatterValue(entry.title)}`,
    `tags: ${serializeFrontmatterValue(entry.tags)}`,
    `created: ${serializeFrontmatterValue(entry.created)}`,
    `updated: ${serializeFrontmatterValue(entry.updated)}`,
    `version: ${entry.version}`,
  ];
  if (entry.rawSourceRef) lines.push(`rawSourceRef: ${serializeFrontmatterValue(entry.rawSourceRef)}`);
  return `---\n${lines.join("\n")}\n---\n${entry.body}`;
}

function serializeFrontmatterValue(value: string | string[]): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => `"${escapeFrontmatter(item)}"`).join(", ")}]`;
  }
  return `"${escapeFrontmatter(value)}"`;
}

function escapeFrontmatter(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/"/g, "\\\"");
}

function parseInlineArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((item) => item.trim().replace(/^"(.*)"$/, "$1"));
}

async function archiveQueueEntry(id: string, paths: MemoryPaths, meta: PatchMeta): Promise<void> {
  const fromDir = path.join(paths.queueDir, id);
  const toDir = path.join(paths.archiveDir, id);
  await removePath(toDir);
  await movePath(fromDir, toDir);
  await writeJsonFile(path.join(toDir, PATCH_META_FILENAME), meta, paths);
}

function buildQueueIdHelp(prefix: string, availableIds: string[]): string {
  if (availableIds.length === 0) {
    return `${prefix}. Queue is empty.`;
  }
  return `${prefix}. Available patch IDs: ${availableIds.join(", ")}`;
}
