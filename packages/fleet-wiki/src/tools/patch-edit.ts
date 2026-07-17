import path from "node:path";

import { PATCH_FILENAME, PATCH_META_FILENAME } from "../constants.js";
import { appendLog } from "../log.js";
import { assertSafeQueueId, parsePatch, rewriteQueuedPatch, serializePatch } from "../patch.js";
import { resolveMemoryPaths, resolveToolMemoryPaths } from "../paths.js";
import {
  WIKI_PATCH_EDIT_DESCRIPTION,
  WIKI_PATCH_EDIT_GUIDELINES,
  WIKI_PATCH_EDIT_PROMPT_SNIPPET,
  buildWikiPatchEditSchema,
} from "../prompts.js";
import { assertSafeEntryId, computeContentHash, readJsonFile, readPatchFile } from "../store.js";
import type { Patch, PatchMeta, WikiEntry } from "../types.js";

interface BodyReplaceInput {
  find: string;
  replace: string;
  expected_occurrences?: number;
}

interface PatchEditParams {
  patch_id: string;
  base_patch_hash?: string;
  body_replace?: BodyReplaceInput;
  title?: string;
  tags?: string[];
  aliases?: string[];
  type?: WikiEntry["type"];
  status?: WikiEntry["status"];
  confidence?: WikiEntry["confidence"];
  owner?: string;
  language?: string;
  revalidateAfter?: string;
  supersedes?: string[];
  related?: string[];
  summary?: string;
  touch_updated: boolean;
  proposer: string;
}

interface PatchEditResult {
  ok: true;
  patch_id: string;
  target: string;
  op: Patch["frontmatter"]["op"];
  previous_patch_hash: string;
  patch_hash: string;
  changed_fields: string[];
  body_replacements: number;
  meta: PatchMeta;
}

const ENTRY_FIELD_KEYS = [
  "title",
  "tags",
  "aliases",
  "type",
  "status",
  "confidence",
  "owner",
  "language",
  "revalidateAfter",
  "supersedes",
  "related",
] as const;

const PATCH_FRONTMATTER_TEXT_FIELDS = ["summary"] as const;

export function buildPatchEditToolConfig() {
  return {
    name: "wiki_patch_edit",
    label: "Wiki Patch Edit",
    description: WIKI_PATCH_EDIT_DESCRIPTION,
    promptSnippet: WIKI_PATCH_EDIT_PROMPT_SNIPPET,
    promptGuidelines: [...WIKI_PATCH_EDIT_GUIDELINES],
    parameters: buildWikiPatchEditSchema(),
    async execute(
      _id: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { cwd: string; paths?: import("../types.js").MemoryPaths },
    ) {
      const paths = resolveToolMemoryPaths(ctx);
      const input = parsePatchEditParams(params);
      const result = await editQueuedPatch(input, paths);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: { patch_id: result.patch_id, patch_hash: result.patch_hash },
      };
    },
  };
}

async function editQueuedPatch(
  input: PatchEditParams,
  paths: ReturnType<typeof resolveMemoryPaths>,
): Promise<PatchEditResult> {
  const { patch, meta, patchHash: previousPatchHash } = await readQueuedPatchSnapshot(paths, input.patch_id);
  if (meta.status !== "pending") throw new Error("patch is not pending");
  if (patch.frontmatter.op !== "create_wiki" && patch.frontmatter.op !== "update_wiki") {
    throw new Error("wiki_patch_edit only supports create_wiki/update_wiki patches");
  }

  if (input.base_patch_hash !== undefined && input.base_patch_hash !== previousPatchHash) {
    throw new Error(`[fleet-wiki] wiki_patch_edit stale base_patch_hash: expected ${previousPatchHash}, got ${input.base_patch_hash}`);
  }

  const entry = parsePatchEntry(patch);
  const entryChangedFields = applyEntryEdits(entry, input);
  const bodyReplacements = applyBodyReplacement(entry, input.body_replace);
  if (bodyReplacements > 0) entryChangedFields.push("body");
  if (entryChangedFields.length > 0 && input.touch_updated) {
    entry.updated = new Date().toISOString();
    if (!entryChangedFields.includes("updated")) entryChangedFields.push("updated");
  }
  const changedFields = [...entryChangedFields];
  if (input.summary !== undefined && input.summary !== patch.frontmatter.summary) changedFields.push("summary");

  const nextPatch: Patch = {
    frontmatter: {
      ...patch.frontmatter,
      summary: input.summary ?? patch.frontmatter.summary,
    },
    body: JSON.stringify(entry),
  };
  await assertPatchFrontmatterRoundTrip(patch, nextPatch);
  const nextMeta: PatchMeta = {
    ...meta,
    editedAt: new Date().toISOString(),
    editCount: (meta.editCount ?? 0) + 1,
    lastEditedBy: input.proposer,
    previousPatchHash,
  };

  const writtenPatchHash = await rewriteQueuedPatch(input.patch_id, paths, nextPatch, nextMeta, previousPatchHash);
  nextMeta.lastEditHash = writtenPatchHash;
  await appendLog(paths, "patch edited", {
    body_replacements: bodyReplacements,
    changed_fields: changedFields,
    next_hash: writtenPatchHash,
    patch_id: input.patch_id,
    previous_hash: previousPatchHash,
    target: nextPatch.frontmatter.target,
  });

  return {
    ok: true,
    patch_id: input.patch_id,
    target: nextPatch.frontmatter.target,
    op: nextPatch.frontmatter.op,
    previous_patch_hash: previousPatchHash,
    patch_hash: writtenPatchHash,
    changed_fields: changedFields,
    body_replacements: bodyReplacements,
    meta: nextMeta,
  };
}

async function readQueuedPatchSnapshot(
  paths: ReturnType<typeof resolveMemoryPaths>,
  patchId: string,
): Promise<{ patch: Patch; meta: PatchMeta; patchHash: string }> {
  const queueDir = path.join(paths.queueDir, patchId);
  const markdown = await readPatchFile(path.join(queueDir, PATCH_FILENAME));
  return {
    patch: await parsePatch(markdown),
    meta: await readJsonFile<PatchMeta>(path.join(queueDir, PATCH_META_FILENAME)),
    patchHash: computeContentHash(markdown),
  };
}

function parsePatchEditParams(params: Record<string, unknown>): PatchEditParams {
  const summary = typeof params.summary === "string" ? params.summary.trim() : undefined;
  if (summary !== undefined && summary.length > 120) throw new Error("patch summary exceeds 120 chars");
  if (summary !== undefined) assertSafePatchFrontmatterText("summary", summary);
  const patchId = String(params.patch_id ?? "").trim();
  assertSafeQueueId(patchId);
  return {
    patch_id: patchId,
    base_patch_hash: typeof params.base_patch_hash === "string" ? params.base_patch_hash.trim() : undefined,
    body_replace: parseBodyReplace(params.body_replace),
    title: stringParam(params.title),
    tags: stringArrayParam(params.tags),
    aliases: stringArrayParam(params.aliases),
    type: enumParam(params.type, ["concept", "entity", "source", "decision", "runbook", "project_context", "policy", "preference", "lesson", "api_contract", "query", "synthesis"]),
    status: enumParam(params.status, ["draft", "current", "deprecated", "superseded"]),
    confidence: enumParam(params.confidence, ["low", "medium", "high"]),
    owner: stringParam(params.owner),
    language: stringParam(params.language),
    revalidateAfter: stringParam(params.revalidateAfter),
    supersedes: stringArrayParam(params.supersedes),
    related: stringArrayParam(params.related),
    summary,
    touch_updated: params.touch_updated !== false,
    proposer: typeof params.proposer === "string" && params.proposer.trim() ? params.proposer.trim() : "tool:wiki_patch_edit",
  };
}

async function assertPatchFrontmatterRoundTrip(previousPatch: Patch, nextPatch: Patch): Promise<void> {
  for (const key of PATCH_FRONTMATTER_TEXT_FIELDS) {
    assertSafePatchFrontmatterText(key, nextPatch.frontmatter[key]);
  }
  assertSafePatchFrontmatterText("proposer", nextPatch.frontmatter.proposer);
  assertSafePatchFrontmatterText("created", nextPatch.frontmatter.created);
  assertSafePatchFrontmatterText("target", nextPatch.frontmatter.target);

  const parsed = await parsePatch(serializePatch(nextPatch));
  if (parsed.frontmatter.op !== previousPatch.frontmatter.op) throw new Error("wiki_patch_edit must not change patch op");
  if (parsed.frontmatter.target !== previousPatch.frontmatter.target) throw new Error("wiki_patch_edit must not change patch target");
  if (parsed.frontmatter.created !== previousPatch.frontmatter.created) throw new Error("wiki_patch_edit must not change patch created");
  if (parsed.frontmatter.proposer !== previousPatch.frontmatter.proposer) throw new Error("wiki_patch_edit must not change patch proposer");
  if (parsed.frontmatter.summary !== nextPatch.frontmatter.summary) throw new Error("wiki_patch_edit patch summary failed round-trip validation");
}

function assertSafePatchFrontmatterText(field: string, value: string): void {
  if (/[\r\n]/.test(value) || value.includes("---")) {
    throw new Error(`patch ${field} must be single-line frontmatter text`);
  }
}

function parsePatchEntry(patch: Patch): WikiEntry {
  let entry: WikiEntry;
  try {
    entry = JSON.parse(patch.body) as WikiEntry;
  } catch {
    throw new Error("wiki_patch_edit requires patch body to be JSON WikiEntry");
  }
  assertSafeEntryId(entry.id);
  if (entry.id !== patch.frontmatter.target.split("/").pop()?.replace(/\.md$/, "")) {
    throw new Error("wiki patch body id must match target filename");
  }
  return entry;
}

function applyEntryEdits(entry: WikiEntry, input: PatchEditParams): string[] {
  const changed: string[] = [];
  for (const key of ENTRY_FIELD_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    if (JSON.stringify(entry[key]) === JSON.stringify(value)) continue;
    (entry as unknown as Record<string, unknown>)[key] = value;
    changed.push(key);
  }
  return changed;
}

function applyBodyReplacement(entry: WikiEntry, replaceInput: BodyReplaceInput | undefined): number {
  if (!replaceInput) return 0;
  const expected = replaceInput.expected_occurrences ?? 1;
  if (replaceInput.find.length === 0) throw new Error("body_replace.find must not be empty");
  const occurrences = countOccurrences(entry.body, replaceInput.find);
  if (occurrences !== expected) {
    throw new Error(`wiki_patch_edit body_replace expected ${expected} occurrence(s), found ${occurrences}`);
  }
  entry.body = entry.body.split(replaceInput.find).join(replaceInput.replace);
  return occurrences;
}

function parseBodyReplace(value: unknown): BodyReplaceInput | undefined {
  if (value === undefined || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return {
    find: String(record.find ?? ""),
    replace: String(record.replace ?? ""),
    expected_occurrences: typeof record.expected_occurrences === "number" ? record.expected_occurrences : undefined,
  };
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArrayParam(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}

function enumParam<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : undefined;
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
