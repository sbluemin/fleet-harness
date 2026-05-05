import { mkdir } from "node:fs/promises";
import path from "node:path";

import { ensureMemoryRoot } from "./paths.js";
import {
  computeContentHash,
  listDirectoryNames,
  pathExists,
  readJsonFile,
  readPatchFile,
  writeJsonFile,
  writePatchFile,
} from "./store.js";
import type { ConflictMeta, ConflictReason, ConflictRecord, MemoryPaths } from "./types.js";

export interface CreateConflictInput {
  reason: ConflictReason;
  target: string;
  wikiId: string;
  title?: string;
  proposer?: string;
  rawSourceRef?: string;
  current?: string;
  proposed: string;
  rawSource?: string;
  patchId?: string;
  currentVersion?: number;
  proposedVersion?: number;
  baseVersion?: number;
  baseHash?: string;
  currentHash?: string;
  warnings?: string[];
  now?: Date;
}

const CONFLICT_META_FILENAME = "meta.json";
const CONFLICT_CURRENT_FILENAME = "current.md";
const CONFLICT_PROPOSED_FILENAME = "proposed.md";
const CONFLICT_RAW_SOURCE_FILENAME = "raw-source.md";

export async function createConflict(input: CreateConflictInput, paths: MemoryPaths): Promise<ConflictRecord> {
  await ensureMemoryRoot(paths);
  const now = input.now ?? new Date();
  const conflictId = buildConflictId(now, input.wikiId, input.reason, input.proposed);
  const conflictDir = path.join(paths.conflictsDir, conflictId);
  await mkdir(conflictDir, { recursive: true });

  const meta: ConflictMeta = {
    id: conflictId,
    status: "unresolved",
    reason: input.reason,
    createdAt: now.toISOString(),
    target: input.target,
    wikiId: input.wikiId,
    title: input.title,
    proposer: input.proposer,
    rawSourceRef: input.rawSourceRef,
    patchId: input.patchId,
    currentVersion: input.currentVersion,
    proposedVersion: input.proposedVersion,
    baseVersion: input.baseVersion,
    baseHash: input.baseHash,
    currentHash: input.currentHash,
    warnings: input.warnings,
  };
  await writeJsonFile(path.join(conflictDir, CONFLICT_META_FILENAME), meta, paths);
  await writePatchFile(path.join(conflictDir, CONFLICT_PROPOSED_FILENAME), input.proposed, paths);
  if (input.current !== undefined) {
    await writePatchFile(path.join(conflictDir, CONFLICT_CURRENT_FILENAME), input.current, paths);
  }
  if (input.rawSource !== undefined) {
    await writePatchFile(path.join(conflictDir, CONFLICT_RAW_SOURCE_FILENAME), input.rawSource, paths);
  }
  return {
    meta,
    current: input.current,
    proposed: input.proposed,
    rawSource: input.rawSource,
  };
}

export async function listConflicts(paths: MemoryPaths): Promise<ConflictMeta[]> {
  const ids = await listDirectoryNames(paths.conflictsDir);
  const metas: ConflictMeta[] = [];
  for (const id of ids) {
    try {
      metas.push(await readJsonFile<ConflictMeta>(path.join(paths.conflictsDir, id, CONFLICT_META_FILENAME)));
    } catch {
      continue;
    }
  }
  return metas.sort(compareConflictMeta);
}

export async function readConflict(conflictId: string, paths: MemoryPaths): Promise<ConflictRecord> {
  const conflictDir = resolveConflictDir(conflictId, paths);
  const meta = await readJsonFile<ConflictMeta>(path.join(conflictDir, CONFLICT_META_FILENAME));
  const currentPath = path.join(conflictDir, CONFLICT_CURRENT_FILENAME);
  const rawSourcePath = path.join(conflictDir, CONFLICT_RAW_SOURCE_FILENAME);
  return {
    meta,
    current: (await pathExists(currentPath)) ? await readPatchFile(currentPath) : undefined,
    proposed: await readPatchFile(path.join(conflictDir, CONFLICT_PROPOSED_FILENAME)),
    rawSource: (await pathExists(rawSourcePath)) ? await readPatchFile(rawSourcePath) : undefined,
  };
}

export async function resolveConflict(
  conflictId: string,
  resolution: { resolution: ConflictMeta["resolution"]; note?: string; now?: Date },
  paths: MemoryPaths,
): Promise<ConflictMeta> {
  const record = await readConflict(conflictId, paths);
  const nextMeta: ConflictMeta = {
    ...record.meta,
    status: "resolved",
    resolvedAt: (resolution.now ?? new Date()).toISOString(),
    resolution: resolution.resolution,
    note: resolution.note,
  };
  await writeJsonFile(path.join(resolveConflictDir(conflictId, paths), CONFLICT_META_FILENAME), nextMeta, paths);
  return nextMeta;
}

function compareConflictMeta(left: ConflictMeta, right: ConflictMeta): number {
  if (left.status !== right.status) {
    return left.status === "unresolved" ? -1 : 1;
  }
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function buildConflictId(now: Date, wikiId: string, reason: ConflictReason, proposed: string): string {
  const timestamp = now.toISOString().replace(/[-:.]/g, "").replace("T", "t").replace("Z", "z");
  const hash = computeContentHash(proposed);
  return `${timestamp}-${sanitizeConflictToken(wikiId)}-${sanitizeConflictToken(reason)}-${hash}`;
}

function sanitizeConflictToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "unknown";
}

function resolveConflictDir(conflictId: string, paths: MemoryPaths): string {
  const conflictDir = path.resolve(paths.conflictsDir, conflictId);
  const relative = path.relative(paths.conflictsDir, conflictDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`[fleet-wiki] conflict id escapes conflicts/: ${conflictId}`);
  }
  return conflictDir;
}
