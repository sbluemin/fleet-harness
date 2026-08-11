import path from "node:path";

import { createConflict } from "../conflicts.js";
import { mergeRawSourceRefs, normalizeComparableText } from "../briefing.js";
import { appendLog } from "../log.js";
import { enqueuePatch } from "../patch.js";
import { resolveMemoryPaths, resolveToolMemoryPaths } from "../paths.js";
import { ensureWorkspaceSchema, inferTemplateIdFromTarget, scanTemplates, validateTemplateCompliance } from "../schema.js";
import {
  WIKI_INGEST_DESCRIPTION,
  WIKI_INGEST_GUIDELINES,
  WIKI_INGEST_PROMPT_SNIPPET,
  buildWikiIngestSchema,
} from "../prompts.js";
import { assertNoUnsafeSecret, findUnsafeMemoryText } from "../store.js";
import { assertSafeEntryId, computeContentHash, listWiki, readPatchFile, readRawSourceEntry, readWikiEntry, writeRawSourceEntry } from "../store.js";
import type {
  ConflictReason,
  DuplicatePolicy,
  IngestResult,
  Patch,
  PatchOp,
  RawSourceEntry,
  WikiEntry,
  WikiIngestMode,
} from "../types.js";
import type { WikiToolExecutionContext } from "../agent-specs.js";

interface WikiIngestParams {
  id: string;
  title: string;
  body: string;
  tags: string[];
  source: string;
  source_type?: "inline" | "file";
  source_title?: string;
  proposer?: string;
  mode?: WikiIngestMode;
  base_version?: number;
  base_hash?: string;
  duplicate_policy?: DuplicatePolicy;
  template_id?: string;
}

interface DuplicateMatch {
  reason: ConflictReason;
  message: string;
}

interface ConflictCandidate {
  reason: ConflictReason;
  message: string;
  currentMarkdown?: string;
  currentVersion?: number;
  proposedVersion?: number;
  baseVersion?: number;
  baseHash?: string;
  currentHash?: string;
}

interface IngestPlanEnqueue {
  kind: "enqueue";
  mode: WikiIngestMode;
  op: PatchOp;
  warnings: string[];
  rawSource: RawSourceEntry;
  entry: WikiEntry;
  proposer: string;
  baseHash?: string;
  baseVersion?: number;
}

interface IngestPlanConflict {
  kind: "conflict";
  mode: WikiIngestMode;
  warnings: string[];
  rawSource: RawSourceEntry;
  entry: WikiEntry;
  proposer: string;
  conflict: ConflictCandidate;
}

type IngestPlan = IngestPlanEnqueue | IngestPlanConflict;

const MIN_WIKI_BODY_LENGTH = 120;
const INLINE_RAW_SOURCE_REF_TOKEN = /(?:^|\n)raw_source_ref\s*:/i;

export function buildIngestToolConfig() {
  return {
    name: "wiki_ingest",
    label: "Wiki Ingest",
    description: WIKI_INGEST_DESCRIPTION,
    promptSnippet: WIKI_INGEST_PROMPT_SNIPPET,
    promptGuidelines: [...WIKI_INGEST_GUIDELINES],
    parameters: buildWikiIngestSchema(),
    async execute(
      _id: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: WikiToolExecutionContext,
    ) {
      const now = new Date().toISOString();
      const paths = resolveToolMemoryPaths(ctx);
      const input = parseIngestParams(params);
      const plan = await planIngest(input, paths, now);
      const result = await stageIngestPlan(plan, paths);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
        details: result.raw_source_ref ? { raw_source_ref: result.raw_source_ref } : {},
      };
    },
  };
}

function parseIngestParams(params: Record<string, unknown>): WikiIngestParams {
  const input: WikiIngestParams = {
    id: String(params.id ?? "").trim(),
    title: String(params.title ?? "").trim(),
    body: String(params.body ?? "").trim(),
    tags: Array.isArray(params.tags) ? params.tags.map(String) : [],
    source: String(params.source ?? ""),
    source_type: params.source_type === "file" ? "file" : "inline",
    source_title: typeof params.source_title === "string" ? params.source_title : undefined,
    proposer: typeof params.proposer === "string" ? params.proposer : undefined,
    mode: normalizeMode(params.mode),
    base_version: typeof params.base_version === "number" ? params.base_version : undefined,
    base_hash: typeof params.base_hash === "string" ? params.base_hash : undefined,
    duplicate_policy: normalizeDuplicatePolicy(params.duplicate_policy),
    template_id: normalizeTemplateInput(params.template_id),
  };
  assertSafeEntryId(input.id);
  assertNoUnsafeSecret(input.source);
  validateWikiBody(input.body);
  return input;
}

async function planIngest(input: WikiIngestParams, paths: ReturnType<typeof resolveMemoryPaths>, now: string): Promise<IngestPlan> {
  const warnings = findUnsafeMemoryText(input.source)
    .filter((issue) => issue.severity === "warning")
    .map((issue) => issue.message);
  const mode = input.mode ?? "auto";
  const duplicatePolicy = input.duplicate_policy ?? "reject";
  const target = `wiki/${input.id}.md`;
  const proposer = input.proposer ?? "tool:wiki_ingest";
  const currentEntry = await readWikiEntry(input.id, paths);
  const currentMarkdown = currentEntry ? await readPatchFile(path.join(paths.wikiDir, `${input.id}.md`)) : undefined;
  const currentHash = currentMarkdown ? computeContentHash(currentMarkdown) : undefined;
  const rawSource = buildRawSourceEntry(input, now);
  await ensureWorkspaceSchema(paths);
  const knownIds = (await scanTemplates(paths)).map((t) => t.id);
  const resolvedTemplateId = input.template_id ?? currentEntry?.templateId ?? inferTemplateIdFromTarget(target, knownIds);
  await validateTemplateCompliance(paths, resolvedTemplateId, input.body);

  if (mode === "create" && currentEntry) {
    return resolveConflictOrThrow(
      duplicatePolicy,
      createFriendlyError(
        `[fleet-wiki] wiki_ingest create target already exists: ${input.id} - use mode=update or duplicate_policy=queue_conflict`,
      ),
      {
        kind: "conflict",
        mode,
        warnings,
        rawSource,
        entry: buildCreateEntry(input, now, resolvedTemplateId),
        proposer,
        conflict: {
          reason: "create_target_exists",
          message: "create target already exists",
          currentMarkdown,
          currentVersion: currentEntry.version,
          proposedVersion: 1,
          currentHash,
        },
      },
    );
  }

  if (mode === "update" && !currentEntry) {
    return resolveConflictOrThrow(
      duplicatePolicy,
      createFriendlyError(
        `[fleet-wiki] wiki_ingest update target does not exist: ${input.id} - use mode=create or duplicate_policy=queue_conflict`,
      ),
      {
        kind: "conflict",
        mode,
        warnings,
        rawSource,
        entry: buildCreateEntry(input, now, resolvedTemplateId),
        proposer,
        conflict: {
          reason: "update_target_missing",
          message: "update target does not exist",
          proposedVersion: 1,
        },
      },
    );
  }

  const duplicateMatch = await findDuplicateMatch(input, paths);
  if (duplicateMatch) {
    return resolveConflictOrThrow(
      duplicatePolicy,
      createFriendlyError(duplicateMatch.message),
      {
        kind: "conflict",
        mode,
        warnings,
        rawSource,
        entry: currentEntry
          ? buildUpdateEntry(currentEntry, input, now, resolvedTemplateId)
          : buildCreateEntry(input, now, resolvedTemplateId),
        proposer,
        conflict: {
          reason: duplicateMatch.reason,
          message: duplicateMatch.message,
          currentMarkdown,
          currentVersion: currentEntry?.version,
          proposedVersion: currentEntry ? currentEntry.version + 1 : 1,
          currentHash,
        },
      },
    );
  }

  if (currentEntry && input.base_version !== undefined && input.base_version !== currentEntry.version) {
    return resolveConflictOrThrow(
      duplicatePolicy,
      createFriendlyError(
        `[fleet-wiki] wiki_ingest stale base_version for ${input.id}: expected ${currentEntry.version}, got ${input.base_version}`,
      ),
      {
        kind: "conflict",
        mode,
        warnings,
        rawSource,
        entry: buildUpdateEntry(currentEntry, input, now, resolvedTemplateId),
        proposer,
        conflict: {
          reason: "base_version_mismatch",
          message: "base_version mismatch",
          currentMarkdown,
          currentVersion: currentEntry.version,
          proposedVersion: currentEntry.version + 1,
          baseVersion: input.base_version,
          currentHash,
        },
      },
    );
  }

  if (currentEntry && input.base_hash !== undefined && input.base_hash !== currentHash) {
    return resolveConflictOrThrow(
      duplicatePolicy,
      createFriendlyError(
        `[fleet-wiki] wiki_ingest stale base_hash for ${input.id}: expected ${currentHash ?? "unknown"}, got ${input.base_hash}`,
      ),
      {
        kind: "conflict",
        mode,
        warnings,
        rawSource,
        entry: buildUpdateEntry(currentEntry, input, now, resolvedTemplateId),
        proposer,
        conflict: {
          reason: "base_hash_mismatch",
          message: "base_hash mismatch",
          currentMarkdown,
          currentVersion: currentEntry.version,
          proposedVersion: currentEntry.version + 1,
          baseVersion: input.base_version,
          baseHash: input.base_hash,
          currentHash,
        },
      },
    );
  }

  const contradictionMessage = await detectRawSourceContradiction(input, rawSource, currentEntry, paths);
  if (contradictionMessage) {
    if (duplicatePolicy === "queue_conflict") {
      return {
        kind: "conflict",
        mode,
        warnings,
        rawSource,
        entry: buildUpdateEntry(currentEntry!, input, now, resolvedTemplateId),
        proposer,
        conflict: {
          reason: "raw_source_contradiction",
          message: contradictionMessage,
          currentMarkdown,
          currentVersion: currentEntry?.version,
          proposedVersion: currentEntry ? currentEntry.version + 1 : 1,
          baseVersion: input.base_version,
          baseHash: input.base_hash,
          currentHash,
        },
      };
    }
    if (duplicatePolicy === "reject") {
      throw createFriendlyError(contradictionMessage);
    }
    warnings.push(contradictionMessage);
  }

  if (!currentEntry) {
    return {
      kind: "enqueue",
      mode,
      op: "create_wiki",
      warnings,
      rawSource,
      entry: buildCreateEntry(input, now, resolvedTemplateId),
      proposer,
    };
  }

  return {
    kind: "enqueue",
    mode,
    op: "update_wiki",
    warnings,
    rawSource,
    entry: buildUpdateEntry(currentEntry, input, now, resolvedTemplateId),
    proposer,
    baseHash: input.base_hash ?? currentHash,
    baseVersion: input.base_version ?? currentEntry.version,
  };
}

async function stageIngestPlan(plan: IngestPlan, paths: ReturnType<typeof resolveMemoryPaths>): Promise<IngestResult> {
  const rawSourceRef = await writeRawSourceEntry(plan.rawSource, paths);
  await appendLog(paths, "raw source added", {
    id: plan.rawSource.id,
    raw_source_ref: rawSourceRef,
    source_type: plan.rawSource.sourceType,
    tag_count: plan.rawSource.tags.length,
    title: plan.rawSource.title ?? null,
  });

  const entry = {
    ...plan.entry,
    rawSourceRef,
    rawSourceRefs: mergeRawSourceRefs(plan.entry.rawSourceRefs, plan.entry.rawSourceRef, {
      ref: rawSourceRef,
      title: plan.rawSource.title,
      hash: computeContentHash(plan.rawSource.content),
    }),
  } satisfies WikiEntry;

  if (plan.kind === "conflict") {
    const record = await createConflict({
      reason: plan.conflict.reason,
      target: `wiki/${entry.id}.md`,
      wikiId: entry.id,
      title: entry.title,
      proposer: plan.proposer,
      rawSourceRef,
      current: plan.conflict.currentMarkdown,
      proposed: serializeConflictEntry(entry),
      rawSource: plan.rawSource.content,
      currentVersion: plan.conflict.currentVersion,
      proposedVersion: plan.conflict.proposedVersion,
      baseVersion: plan.conflict.baseVersion,
      baseHash: plan.conflict.baseHash,
      currentHash: plan.conflict.currentHash,
      warnings: plan.warnings,
    }, paths);
    await appendLog(paths, "conflict detected", {
      conflict_id: record.meta.id,
      patch_id: null,
      raw_source_ref: rawSourceRef,
      reason: plan.conflict.reason,
      target: record.meta.target,
      wiki_id: record.meta.wikiId,
    });
    return {
      ok: false,
      mode: plan.mode,
      conflict_id: record.meta.id,
      raw_source_ref: rawSourceRef,
      warnings: plan.warnings,
    };
  }

  const patch = buildPatch(plan.op, entry, plan.proposer, plan.entry.updated);
  const patchId = await enqueuePatch(patch, paths, {
    baseCheckedAt: plan.baseHash || plan.baseVersion !== undefined ? new Date().toISOString() : undefined,
    baseHash: plan.baseHash,
    baseVersion: plan.baseVersion,
    rawSourceRef,
    warnings: plan.warnings,
  });
  return {
    ok: true,
    mode: plan.mode,
    op: plan.op,
    patch_id: patchId,
    raw_source_ref: rawSourceRef,
    warnings: plan.warnings,
  };
}

async function findDuplicateMatch(
  input: WikiIngestParams,
  paths: ReturnType<typeof resolveMemoryPaths>,
): Promise<DuplicateMatch | null> {
  const normalizedTitle = normalizeComparableText(input.title);
  for (const entry of await listWiki(paths)) {
    if (entry.id === input.id) continue;
    if (normalizeComparableText(entry.title) === normalizedTitle) {
      return {
        reason: "duplicate_title",
        message: `[fleet-wiki] wiki_ingest duplicate title detected: "${input.title}" already used by ${entry.id}`,
      };
    }
    if (entry.aliases?.some((alias) => normalizeComparableText(alias) === normalizedTitle)) {
      return {
        reason: "duplicate_alias",
        message: `[fleet-wiki] wiki_ingest duplicate alias detected: "${input.title}" matches alias on ${entry.id}`,
      };
    }
  }
  return null;
}

async function detectRawSourceContradiction(
  input: WikiIngestParams,
  rawSource: RawSourceEntry,
  currentEntry: WikiEntry | null,
  paths: ReturnType<typeof resolveMemoryPaths>,
): Promise<string | null> {
  if (!currentEntry?.rawSourceRef) return null;
  try {
    const currentRaw = await readRawSourceEntry(currentEntry.rawSourceRef, paths);
    const currentTitle = normalizeComparableText(currentRaw.title ?? currentEntry.title);
    const nextTitle = normalizeComparableText(rawSource.title ?? input.title);
    if (
      currentRaw.sourceType === rawSource.sourceType
      && currentTitle === nextTitle
      && currentRaw.contentHash
      && currentRaw.contentHash !== computeContentHash(rawSource.content)
    ) {
      return `[fleet-wiki] wiki_ingest raw source contradiction detected for ${input.id}: same source identity but different content`;
    }
  } catch {
    return null;
  }
  return null;
}

function buildRawSourceEntry(input: WikiIngestParams, now: string): RawSourceEntry {
  return {
    id: `${input.id}-source`,
    created: now,
    sourceType: input.source_type === "file" ? "file" : "inline",
    title: input.source_title ?? input.title,
    tags: input.tags,
    content: input.source,
  };
}

function buildCreateEntry(input: WikiIngestParams, now: string, templateId: string | undefined): WikiEntry {
  return {
    id: input.id,
    title: input.title,
    tags: input.tags,
    created: now,
    updated: now,
    version: 1,
    templateId,
    body: input.body,
  };
}

function buildUpdateEntry(
  currentEntry: WikiEntry,
  input: WikiIngestParams,
  now: string,
  templateId: string | undefined,
): WikiEntry {
  return {
    ...currentEntry,
    id: currentEntry.id,
    title: input.title,
    tags: input.tags,
    created: currentEntry.created,
    updated: now,
    version: currentEntry.version + 1,
    templateId,
    body: input.body,
  };
}

function buildPatch(op: PatchOp, entry: WikiEntry, proposer: string, created: string): Patch {
  return {
    frontmatter: {
      op,
      target: `wiki/${entry.id}.md`,
      summary: entry.title.slice(0, 120),
      proposer,
      created,
    },
    body: JSON.stringify(entry),
  };
}

function resolveConflictOrThrow(
  duplicatePolicy: DuplicatePolicy,
  error: Error,
  conflictPlan: IngestPlanConflict,
): IngestPlanConflict {
  if (duplicatePolicy === "queue_conflict") {
    return conflictPlan;
  }
  throw error;
}

function validateWikiBody(body: string): void {
  if (body.length < MIN_WIKI_BODY_LENGTH) {
    throw new Error(`wiki body must be at least ${MIN_WIKI_BODY_LENGTH} characters`);
  }
  assertNoUnsafeSecret(body);
  const warningIssue = findUnsafeMemoryText(body).find((issue) => issue.code === "prompt_injection");
  if (warningIssue) {
    throw new Error(warningIssue.message);
  }
  if (INLINE_RAW_SOURCE_REF_TOKEN.test(body)) {
    throw new Error("wiki body must not include inline raw_source_ref metadata");
  }
}

function normalizeMode(value: unknown): WikiIngestMode | undefined {
  return value === "create" || value === "update" || value === "auto" ? value : undefined;
}

function normalizeDuplicatePolicy(value: unknown): DuplicatePolicy | undefined {
  return value === "reject" || value === "queue_conflict" || value === "append_evidence" ? value : undefined;
}

function normalizeTemplateInput(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function createFriendlyError(message: string): Error {
  return new Error(message);
}

function serializeConflictEntry(entry: WikiEntry): string {
  const frontmatterLines = [
    `id: ${serializeFrontmatterValue(entry.id)}`,
    `title: ${serializeFrontmatterValue(entry.title)}`,
    `tags: ${serializeFrontmatterValue(entry.tags)}`,
    `created: ${serializeFrontmatterValue(entry.created)}`,
    `updated: ${serializeFrontmatterValue(entry.updated)}`,
    `version: ${entry.version}`,
  ];
  if (entry.rawSourceRef) frontmatterLines.push(`rawSourceRef: ${serializeFrontmatterValue(entry.rawSourceRef)}`);
  if (entry.templateId) frontmatterLines.push(`template_id: ${serializeFrontmatterValue(entry.templateId)}`);
  if (entry.aliases?.length) frontmatterLines.push(`aliases: ${serializeFrontmatterValue(entry.aliases)}`);
  if (entry.type) frontmatterLines.push(`type: ${serializeFrontmatterValue(entry.type)}`);
  if (entry.status) frontmatterLines.push(`status: ${serializeFrontmatterValue(entry.status)}`);
  if (entry.confidence) frontmatterLines.push(`confidence: ${serializeFrontmatterValue(entry.confidence)}`);
  if (entry.owner) frontmatterLines.push(`owner: ${serializeFrontmatterValue(entry.owner)}`);
  if (entry.language) frontmatterLines.push(`language: ${serializeFrontmatterValue(entry.language)}`);
  if (entry.revalidateAfter) frontmatterLines.push(`revalidateAfter: ${serializeFrontmatterValue(entry.revalidateAfter)}`);
  if (entry.supersedes?.length) frontmatterLines.push(`supersedes: ${serializeFrontmatterValue(entry.supersedes)}`);
  if (entry.related?.length) frontmatterLines.push(`related: ${serializeFrontmatterValue(entry.related)}`);
  if (entry.rawSourceRefs?.length) frontmatterLines.push(`rawSourceRefs: ${serializeFrontmatterValue(JSON.stringify(entry.rawSourceRefs))}`);
  return `---\n${frontmatterLines.join("\n")}\n---\n${entry.body}`;
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
