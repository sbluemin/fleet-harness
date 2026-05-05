import { mkdir } from "node:fs/promises";
import path from "node:path";

import { PATCH_FILENAME, PATCH_META_FILENAME } from "./constants.js";
import { appendLog } from "./log.js";
import { ensureMemoryRoot } from "./paths.js";
import {
  assertSafeEntryId,
  listDirectoryNames,
  movePath,
  pathExists,
  readJsonFile,
  readPatchFile,
  rebuildIndex,
  removePath,
  writeJsonFile,
  writePatchFile,
  writeWikiEntry,
} from "./store.js";
import type { MemoryPaths, Patch, PatchMeta, WikiEntry } from "./types.js";

export interface QueueSelection {
  id: string;
  autoSelected: boolean;
  availableIds: string[];
}

const INLINE_RAW_SOURCE_REF_PATTERN = /(?:\n+)raw_source_ref:\s*(\S+)\s*$/i;

export async function parsePatch(markdown: string): Promise<Patch> {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
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

  const absoluteTarget = path.resolve(paths.root, target);
  if (!absoluteTarget.startsWith(`${paths.root}${path.sep}`) && absoluteTarget !== paths.root) {
    throw new Error("patch target escapes wiki root");
  }

  if (!absoluteTarget.startsWith(`${paths.wikiDir}${path.sep}`)) throw new Error("wiki patch must target wiki/");
  if (op === "create_wiki" && (await pathExists(absoluteTarget))) {
    throw new Error(
      `[fleet-wiki] create_wiki target already exists: ${target} - use update_wiki to modify existing entries`,
    );
  }
  if (op === "update_wiki" && !(await pathExists(absoluteTarget))) throw new Error("update_wiki target does not exist");
}

export async function applyPatch(patch: Patch, paths: MemoryPaths): Promise<string> {
  await validatePatch(patch, paths);

  const entry = normalizeWikiEntryPatch(JSON.parse(patch.body) as WikiEntry, patch.frontmatter.target, paths);
  const relativePath = await writeWikiEntry(entry, paths);
  await rebuildIndex(paths);
  return relativePath;
}

export async function enqueuePatch(patch: Patch, paths: MemoryPaths, metaOverrides?: Partial<PatchMeta>): Promise<string> {
  await ensureMemoryRoot(paths);
  const patchId = buildPatchId(patch.frontmatter.created, patch.frontmatter.summary);
  const queueDir = path.join(paths.queueDir, patchId);
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
    const meta = await readJsonFile<PatchMeta>(path.join(paths.queueDir, id, PATCH_META_FILENAME));
    results.push({ id, meta });
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

export async function approvePatch(id: string, paths: MemoryPaths): Promise<PatchMeta> {
  const { patch, meta } = await showQueue(id, paths);
  if (meta.status !== "pending") throw new Error("patch is not pending");
  await applyPatch(patch, paths);
  const nextMeta: PatchMeta = {
    ...meta,
    status: "accepted",
    decidedAt: new Date().toISOString(),
  };
  await archiveQueueEntry(id, paths, nextMeta);
  await appendLog(paths, "patch approved", {
    op: patch.frontmatter.op,
    patch_id: id,
    proposer: patch.frontmatter.proposer,
    raw_source_ref: nextMeta.rawSourceRef ?? null,
    result: "accepted",
    target: patch.frontmatter.target,
  });
  return nextMeta;
}

export async function rejectPatch(id: string, reason: string, paths: MemoryPaths): Promise<PatchMeta> {
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
    reason,
    result: "rejected",
  });
  return nextMeta;
}

function serializePatch(patch: Patch): string {
  const lines = [
    `op: "${patch.frontmatter.op}"`,
    `target: "${patch.frontmatter.target}"`,
    `summary: "${patch.frontmatter.summary}"`,
    `proposer: "${patch.frontmatter.proposer}"`,
    `created: "${patch.frontmatter.created}"`,
  ];
  return `---\n${lines.join("\n")}\n---\n${patch.body}`;
}

function normalizeWikiEntryPatch(entry: WikiEntry, target: string, paths: MemoryPaths): WikiEntry {
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
  return {
    ...entry,
    body: inlineRawSourceRef ? inlineRawSourceRef.body : entry.body,
    rawSourceRef,
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

function buildPatchId(createdAt: string, summary: string): string {
  const compact = createdAt.replace(/[:.]/g, "-");
  const hash = Buffer.from(summary).toString("hex").slice(0, 8) || "00000000";
  return `${compact}-${hash}`;
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
