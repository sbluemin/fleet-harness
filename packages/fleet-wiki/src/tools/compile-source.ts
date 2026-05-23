import path from "node:path";

import { wrapWikiRawSourceBoundary } from "../boundaries.js";
import { briefingQuery } from "../briefing.js";
import { extractWikiLinks } from "../links.js";
import { appendLog } from "../log.js";
import { buildPatchSetId, writePatchSet } from "../patch-set.js";
import { enqueuePatch } from "../patch.js";
import { resolveMemoryPaths } from "../paths.js";
import {
  WIKI_COMPILE_SOURCE_DESCRIPTION,
  WIKI_COMPILE_SOURCE_GUIDELINES,
  WIKI_COMPILE_SOURCE_PROMPT_SNIPPET,
  buildWikiCompileSourceSchema,
} from "../prompts.js";
import { assertNoUnsafeSecret } from "../safety.js";
import { assertSafeEntryId, computeContentHash, listWiki, pathExists, readPatchFile, readRawSourceEntry, writeRawSourceEntry } from "../store.js";
import type { Patch, RawSourceEntry, WikiEntry } from "../types.js";

interface WikiCompileSourceInput {
  source?: string;
  source_ref?: string;
  source_title?: string;
  mode?: "preview" | "stage";
  max_pages_touched?: number;
  update_index?: boolean;
  update_log?: boolean;
}

interface WikiCompileSourceOutput {
  ok: boolean;
  patch_set_id: string;
  patches: Array<{
    patch_id: string;
    op: "create_wiki" | "update_wiki";
    target: string;
    summary: string;
  }>;
  related_entry_candidates: Array<{
    id: string;
    title: string;
    reason: "briefing" | "alias" | "tag" | "canonical_id" | "title" | "body";
    score: number;
  }>;
  conflicts: unknown[];
  warnings: string[];
}

interface NormalizedCompileSourceInput {
  source?: string;
  sourceRef?: string;
  sourceTitle?: string;
  mode: "preview" | "stage";
  maxPagesTouched: number;
  updateIndex: boolean;
  updateLog: boolean;
}

interface ResolvedCompileSource {
  rawSourceRef: string;
  sourceContent: string;
  sourceTitle?: string;
  sourcePageId: string;
  wroteRawSource: boolean;
}

interface RelatedEntryCandidate {
  id: string;
  title: string;
  reason: "briefing" | "alias" | "tag" | "canonical_id" | "title" | "body";
  score: number;
}

interface CompileSourceProposal {
  op: "create_wiki" | "update_wiki";
  target: string;
  summary: string;
  entry: WikiEntry;
  baseHash?: string;
  baseVersion?: number;
}

const DEFAULT_MAX_PAGES_TOUCHED = 5;
const MAX_PAGES_TOUCHED_MIN = 1;
const MAX_PAGES_TOUCHED_MAX = 20;
const RAW_PREVIEW_REF_PREFIX = "raw/preview-";
const CANDIDATE_REASON_PRIORITY: Record<RelatedEntryCandidate["reason"], number> = {
  canonical_id: 6,
  alias: 5,
  title: 4,
  tag: 3,
  body: 2,
  briefing: 1,
};

export function buildCompileSourceToolConfig() {
  return {
    name: "wiki_compile_source",
    label: "Wiki Compile Source",
    description: WIKI_COMPILE_SOURCE_DESCRIPTION,
    promptSnippet: WIKI_COMPILE_SOURCE_PROMPT_SNIPPET,
    promptGuidelines: [...WIKI_COMPILE_SOURCE_GUIDELINES],
    parameters: buildWikiCompileSourceSchema(),
    async execute(
      _id: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      const now = new Date().toISOString();
      const paths = resolveMemoryPaths(ctx.cwd);
      const input = normalizeCompileSourceInput(params as WikiCompileSourceInput);
      const output = input.mode === "stage"
        ? await stageSourceCompile(input, paths, now)
        : await compileSourcePreview(input, paths, now);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        details: {},
      };
    },
  };
}

async function compileSourcePreview(
  input: NormalizedCompileSourceInput,
  paths: ReturnType<typeof resolveMemoryPaths>,
  now: string,
): Promise<WikiCompileSourceOutput> {
  const resolvedSource = await resolveCompileSource(input, paths, now);
  const patchSetId = buildPatchSetId(now, resolvedSource.rawSourceRef);
  const warnings = buildCompileWarnings(input, "preview");
  const proposals = await buildCompileProposals(input, paths, now, resolvedSource);

  return {
    ok: true,
    patch_set_id: patchSetId,
    patches: proposals.map((proposal, index) => ({
      patch_id: `preview:${patchSetId}:${index + 1}`,
      op: proposal.op,
      target: proposal.target,
      summary: proposal.summary,
    })),
    related_entry_candidates: await discoverRelatedEntryCandidates(paths, resolvedSource.sourceContent, resolvedSource.sourceTitle),
    conflicts: [],
    warnings,
  };
}

async function stageSourceCompile(
  input: NormalizedCompileSourceInput,
  paths: ReturnType<typeof resolveMemoryPaths>,
  now: string,
): Promise<WikiCompileSourceOutput> {
  const resolvedSource = await resolveCompileSource(input, paths, now);
  if (resolvedSource.wroteRawSource && input.updateLog) {
    await appendLog(paths, "raw source added", {
      id: `${resolvedSource.sourcePageId}-source`,
      raw_source_ref: resolvedSource.rawSourceRef,
      source_type: "inline",
      tag_count: 0,
      title: resolvedSource.sourceTitle ?? null,
    });
  }

  const warnings = buildCompileWarnings(input, "stage");
  const proposals = await buildCompileProposals(input, paths, now, resolvedSource);
  const patchSetId = buildPatchSetId(now, resolvedSource.rawSourceRef);
  const patchIds: string[] = [];

  for (const proposal of proposals) {
    const patch = buildProposalPatch(proposal, now);
    const patchId = await enqueuePatch(patch, paths, {
      baseCheckedAt: proposal.baseHash || proposal.baseVersion !== undefined ? now : undefined,
      baseHash: proposal.baseHash,
      baseVersion: proposal.baseVersion,
      patch_set_id: patchSetId,
      rawSourceRef: resolvedSource.rawSourceRef,
    });
    patchIds.push(patchId);
  }

  await writePatchSet(paths, {
    id: patchSetId,
    sourceRef: resolvedSource.rawSourceRef,
    createdAt: now,
    patchIds,
  });
  if (input.updateLog) {
    await appendLog(paths, "patch set staged", {
      patch_count: patchIds.length,
      patch_set_id: patchSetId,
      source_ref: resolvedSource.rawSourceRef,
    });
  }

  return {
    ok: true,
    patch_set_id: patchSetId,
    patches: proposals.map((proposal, index) => ({
      patch_id: patchIds[index]!,
      op: proposal.op,
      target: proposal.target,
      summary: proposal.summary,
    })),
    related_entry_candidates: await discoverRelatedEntryCandidates(paths, resolvedSource.sourceContent, resolvedSource.sourceTitle),
    conflicts: [],
    warnings,
  };
}

function normalizeCompileSourceInput(params: WikiCompileSourceInput): NormalizedCompileSourceInput {
  const source = typeof params.source === "string" ? params.source : undefined;
  const sourceRef = typeof params.source_ref === "string" ? params.source_ref.trim() : undefined;
  const sourceTitle = typeof params.source_title === "string" ? params.source_title.trim() : undefined;
  if ((source?.length ?? 0) > 0 && (sourceRef?.length ?? 0) > 0) {
    throw new Error("[fleet-wiki] wiki_compile_source accepts exactly one of source or source_ref");
  }
  if (!(source && source.length > 0) && !(sourceRef && sourceRef.length > 0)) {
    throw new Error("[fleet-wiki] wiki_compile_source requires source or source_ref");
  }
  if (source) {
    assertNoUnsafeSecret(source);
  }
  return {
    source,
    sourceRef,
    sourceTitle: sourceTitle || undefined,
    mode: params.mode === "stage" ? "stage" : "preview",
    maxPagesTouched: normalizeMaxPagesTouched(params.max_pages_touched),
    updateIndex: params.update_index === true,
    updateLog: params.update_log !== false,
  };
}

async function resolveCompileSource(
  input: NormalizedCompileSourceInput,
  paths: ReturnType<typeof resolveMemoryPaths>,
  now: string,
): Promise<ResolvedCompileSource> {
  if (input.sourceRef) {
    const rawSource = await readRawSourceEntry(input.sourceRef, paths);
    const sourcePageId = buildSourcePageId(input.sourceTitle ?? rawSource.title ?? rawSource.id);
    return {
      rawSourceRef: input.sourceRef,
      sourceContent: rawSource.content,
      sourceTitle: input.sourceTitle ?? rawSource.title,
      sourcePageId,
      wroteRawSource: false,
    };
  }

  const sourcePageId = buildSourcePageId(input.sourceTitle ?? "compiled-source");
  if (input.mode === "preview") {
    return {
      rawSourceRef: `${RAW_PREVIEW_REF_PREFIX}${sourcePageId}.md`,
      sourceContent: input.source ?? "",
      sourceTitle: input.sourceTitle,
      sourcePageId,
      wroteRawSource: false,
    };
  }

  const rawSourceRef = await writeRawSourceEntry({
    id: `${sourcePageId}-source`,
    created: now,
    sourceType: "inline",
    title: input.sourceTitle,
    tags: [],
    content: input.source ?? "",
  } satisfies RawSourceEntry, paths);
  return {
    rawSourceRef,
    sourceContent: input.source ?? "",
    sourceTitle: input.sourceTitle,
    sourcePageId,
    wroteRawSource: true,
  };
}

async function buildCompileProposals(
  input: NormalizedCompileSourceInput,
  paths: ReturnType<typeof resolveMemoryPaths>,
  now: string,
  resolvedSource: ResolvedCompileSource,
): Promise<CompileSourceProposal[]> {
  const sourceTarget = `wiki/sources/${resolvedSource.sourcePageId}.md`;
  const sourceExists = await pathExists(path.join(paths.root, sourceTarget));
  const existingEntries = await listWiki(paths);
  const sourcePageTitle = resolvedSource.sourceTitle?.trim() || `Source ${resolvedSource.sourcePageId}`;
  const existingSourceEntry = existingEntries.find((entry) => entry.id === resolvedSource.sourcePageId);
  const sourceEntry: WikiEntry = {
    id: resolvedSource.sourcePageId,
    title: sourcePageTitle,
    tags: ["source", "compiled"],
    created: existingSourceEntry?.created ?? now,
    updated: now,
    version: existingSourceEntry ? existingSourceEntry.version + 1 : 1,
    type: "source",
    status: "current",
    rawSourceRef: resolvedSource.rawSourceRef,
    rawSourceRefs: mergeRawSourceRefs(existingSourceEntry?.rawSourceRefs, existingSourceEntry?.rawSourceRef, { ref: resolvedSource.rawSourceRef }),
    body: buildSourcePageBody(sourcePageTitle, resolvedSource),
  };
  const proposals: CompileSourceProposal[] = [{
    op: sourceExists ? "update_wiki" : "create_wiki",
    target: sourceTarget,
    summary: truncateSummary(`Compile source page ${sourcePageTitle}`),
    entry: sourceEntry,
    baseHash: sourceExists ? computeContentHash(await readPatchFile(path.join(paths.root, sourceTarget))) : undefined,
    baseVersion: existingSourceEntry?.version,
  }];

  const relatedCandidates = await discoverRelatedEntryCandidates(paths, resolvedSource.sourceContent, resolvedSource.sourceTitle);
  const updateCandidates = relatedCandidates
    .filter((candidate) => candidate.reason === "canonical_id" || candidate.reason === "alias" || candidate.reason === "title")
    .slice(0, Math.max(0, input.maxPagesTouched - 1));

  for (const candidate of updateCandidates) {
    const existing = existingEntries.find((entry) => entry.id === candidate.id);
    if (!existing) continue;
    proposals.push({
      op: "update_wiki",
      target: `wiki/${existing.id}.md`,
      summary: truncateSummary(`Compile note for ${existing.title}`),
      entry: {
        ...existing,
        updated: now,
        version: existing.version + 1,
        rawSourceRef: resolvedSource.rawSourceRef,
        rawSourceRefs: mergeRawSourceRefs(existing.rawSourceRefs, existing.rawSourceRef, { ref: resolvedSource.rawSourceRef }),
        body: appendSourceCompileNote(existing.body, resolvedSource.sourcePageId, resolvedSource.rawSourceRef),
      },
      baseHash: computeContentHash(await readPatchFile(path.join(paths.wikiDir, `${existing.id}.md`))),
      baseVersion: existing.version,
    });
  }

  return proposals.slice(0, input.maxPagesTouched);
}

async function discoverRelatedEntryCandidates(
  paths: ReturnType<typeof resolveMemoryPaths>,
  sourceContent: string,
  sourceTitle: string | undefined,
): Promise<RelatedEntryCandidate[]> {
  const candidates = new Map<string, RelatedEntryCandidate>();
  const wikiEntries = await listWiki(paths);
  const topic = (sourceTitle ?? sourceContent.slice(0, 80)).trim();
  const canonicalIds = extractWikiLinks(sourceContent);

  for (const canonicalId of canonicalIds) {
    const entry = wikiEntries.find((item) => item.id === canonicalId);
    if (!entry) continue;
    candidates.set(entry.id, { id: entry.id, title: entry.title, reason: "canonical_id", score: 100 });
  }

  for (const hit of await briefingQuery(paths, { topic, limit: 5 })) {
    upsertCandidate(candidates, { id: hit.id, title: hit.title, reason: "briefing", score: hit.score });
  }

  const normalizedTitle = normalizeComparableText(sourceTitle ?? "");
  const normalizedSource = normalizeComparableText(sourceContent);
  for (const entry of wikiEntries) {
    const entryTitle = normalizeComparableText(entry.title);
    if (normalizedTitle && entryTitle === normalizedTitle) {
      upsertCandidate(candidates, { id: entry.id, title: entry.title, reason: "title", score: 95 });
    }
    if ((entry.aliases ?? []).some((alias) => normalizeComparableText(alias) === normalizedTitle || normalizedSource.includes(normalizeComparableText(alias)))) {
      upsertCandidate(candidates, { id: entry.id, title: entry.title, reason: "alias", score: 94 });
    }
    if (entry.tags.some((tag) => normalizedSource.includes(normalizeComparableText(tag)))) {
      upsertCandidate(candidates, { id: entry.id, title: entry.title, reason: "tag", score: 70 });
    }
    if (normalizedTitle && entryTitle.includes(normalizedTitle)) {
      upsertCandidate(candidates, { id: entry.id, title: entry.title, reason: "title", score: 85 });
    }
    if (normalizedSource.includes(normalizeComparableText(entry.id))) {
      upsertCandidate(candidates, { id: entry.id, title: entry.title, reason: "body", score: 60 });
    }
  }

  return [...candidates.values()].sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

function buildProposalPatch(proposal: CompileSourceProposal, createdAt: string): Patch {
  return {
    frontmatter: {
      op: proposal.op,
      target: proposal.target,
      summary: proposal.summary,
      proposer: "tool:wiki_compile_source",
      created: createdAt,
    },
    body: JSON.stringify(proposal.entry),
  };
}

function mergeRawSourceRefs(
  refs: WikiEntry["rawSourceRefs"],
  currentRef: string | undefined,
  nextRef: NonNullable<WikiEntry["rawSourceRefs"]>[number],
): WikiEntry["rawSourceRefs"] {
  const existing = refs ? [...refs] : [];
  if (currentRef && !existing.some((item) => item.ref === currentRef)) {
    existing.push({ ref: currentRef });
  }
  if (existing.some((item) => item.ref === nextRef.ref)) return existing;
  return [...existing, nextRef];
}

function buildCompileWarnings(input: NormalizedCompileSourceInput, mode: "preview" | "stage"): string[] {
  const warnings: string[] = [];
  if (mode === "preview") {
    warnings.push("preview mode does not persist raw source, queue items, logs, or patch set metadata");
  }
  if (input.updateIndex) {
    warnings.push("index is generated; update_index ignored");
  }
  return warnings;
}

function buildSourcePageId(seed: string): string {
  const cleaned = seed
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/^\d{4}-\d{2}-\d{2}-/, "")
    .replace(/-[a-f0-9]{8}$/i, "")
    .trim();
  const slug = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "compiled-source";
  const candidate = slug === "index" ? `source-${slug}` : slug;
  assertSafeEntryId(candidate);
  return candidate;
}

function normalizeMaxPagesTouched(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_PAGES_TOUCHED;
  if (!Number.isInteger(value)) {
    throw new Error("[fleet-wiki] wiki_compile_source max_pages_touched must be an integer");
  }
  return Math.min(MAX_PAGES_TOUCHED_MAX, Math.max(MAX_PAGES_TOUCHED_MIN, value));
}

function buildSourcePageBody(sourcePageTitle: string, resolvedSource: ResolvedCompileSource): string {
  return [
    "## Overview",
    "",
    `${sourcePageTitle} source compile snapshot.`,
    "",
    "## Provenance",
    "",
    `- raw_source_ref: \`${resolvedSource.rawSourceRef}\``,
    "",
    "## Source Excerpt",
    "",
    wrapWikiRawSourceBoundary({
      ref: resolvedSource.rawSourceRef,
      content: resolvedSource.sourceContent,
    }),
    "",
    "## Related",
    "",
    "- None",
  ].join("\n");
}

function appendSourceCompileNote(body: string, sourcePageId: string, rawSourceRef: string): string {
  const note = [
    "## Source compile note",
    "",
    `- compiled_from: [[wiki:${sourcePageId}]]`,
    `- raw_source_ref: \`${rawSourceRef}\``,
  ].join("\n");
  if (body.includes("## Source compile note")) {
    return body;
  }
  return `${body.trimEnd()}\n\n${note}\n`;
}

function truncateSummary(summary: string): string {
  return summary.slice(0, 120);
}

function normalizeComparableText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function upsertCandidate(
  candidates: Map<string, RelatedEntryCandidate>,
  candidate: RelatedEntryCandidate,
): void {
  const existing = candidates.get(candidate.id);
  if (
    !existing
    || CANDIDATE_REASON_PRIORITY[candidate.reason] > CANDIDATE_REASON_PRIORITY[existing.reason]
    || (
      CANDIDATE_REASON_PRIORITY[candidate.reason] === CANDIDATE_REASON_PRIORITY[existing.reason]
      && candidate.score > existing.score
    )
  ) {
    candidates.set(candidate.id, candidate);
  }
}
