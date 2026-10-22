import path from "node:path";

import { wrapWikiRawSourceBoundary } from "../store.js";
import { briefingQuery } from "../briefing.js";
import { mergeRawSourceRefs, normalizeComparableText, truncateSummary } from "../briefing.js";
import { extractWikiLinks } from "../store.js";
import { appendLog } from "../log.js";
import { prepareEntry, withWikiWriteLock, writeEntry } from "../write.js";
import { resolveMemoryPaths, resolveToolMemoryPaths } from "../paths.js";
import {
  WIKI_COMPILE_SOURCE_DESCRIPTION,
  WIKI_COMPILE_SOURCE_GUIDELINES,
  WIKI_COMPILE_SOURCE_PROMPT_SNIPPET,
  buildWikiCompileSourceSchema,
} from "../prompts.js";
import { assertNoUnsafeSecret } from "../store.js";
import { assertSafeEntryId, computeContentHash, listWiki, pathExists, readPatchFile, readRawSourceEntry, resolveWikiEntryPath, writeRawSourceEntry } from "../store.js";
import type { RawSourceEntry, WikiEntry } from "../types.js";
import type { WikiToolExecutionContext } from "../tool-context.js";

interface WikiCompileSourceInput {
  source?: string;
  source_ref?: string;
  source_title?: string;
  mode?: "preview" | "write";
  max_pages_touched?: number;
  update_index?: boolean;
  update_log?: boolean;
}

interface WikiCompileSourceOutput {
  ok: boolean;
  entries: Array<{ entry_id: string; op: "create_wiki" | "update_wiki"; target: string; summary: string; version?: number }>;
  failed?: { target: string; error: string };
  related_entry_candidates: Array<{
    id: string;
    title: string;
    reason: "briefing" | "alias" | "tag" | "canonical_id" | "title" | "body";
    score: number;
  }>;
  warnings: string[];
}

interface NormalizedCompileSourceInput {
  source?: string;
  sourceRef?: string;
  sourceTitle?: string;
  mode: "preview" | "write";
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
      ctx: WikiToolExecutionContext,
    ) {
      const now = new Date().toISOString();
      const paths = resolveToolMemoryPaths(ctx);
      const input = normalizeCompileSourceInput(params as WikiCompileSourceInput);
      const output = input.mode === "write"
        ? await withWikiWriteLock(paths, () => writeSourceCompile(input, paths, now))
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
  const warnings = buildCompileWarnings(input, "preview");
  const proposals = await buildCompileProposals(input, paths, now, resolvedSource);
  return {
    ok: true,
    entries: proposals.map(p => ({ entry_id: p.entry.id, op: p.op, target: p.target, summary: p.summary })),
    related_entry_candidates: await discoverRelatedEntryCandidates(paths, resolvedSource.sourceContent, resolvedSource.sourceTitle), warnings,
  };
}

async function writeSourceCompile(input: NormalizedCompileSourceInput, paths: ReturnType<typeof resolveMemoryPaths>, now: string): Promise<WikiCompileSourceOutput> {
  const source = await resolveCompileSource(input, paths, now);
  const proposals = await buildCompileProposals(input, paths, now, source);
  const options = { actor: "tool:wiki_compile_source", tool: "wiki_compile_source" };
  // Validate the complete plan before any source or entry mutation.
  for (const p of proposals) await prepareEntry(p.entry, p.target, paths, { ...options, op: p.op, base_hash: p.baseHash, base_version: p.baseVersion });
  if (input.source !== undefined) await writeRawSourceEntry({ id: `${source.sourcePageId}-source`, created: now, sourceType: "inline", title: input.sourceTitle, tags: [], content: input.source } satisfies RawSourceEntry, paths);
  const result: WikiCompileSourceOutput = { ok: true, entries: [], related_entry_candidates: await discoverRelatedEntryCandidates(paths, source.sourceContent, source.sourceTitle), warnings: buildCompileWarnings(input, "write") };
  for (const p of proposals) {
    try {
      const written = await writeEntry(p.entry, p.target, paths, { ...options, op: p.op, base_hash: p.baseHash, base_version: p.baseVersion });
      result.entries.push({ entry_id: p.entry.id, op: p.op, target: p.target, summary: p.summary, version: written.version });
    } catch (error) {
      result.ok = false;
      result.failed = { target: p.target, error: error instanceof Error ? error.message : String(error) };
      break;
    }
  }
  await appendLog(paths, "source compiled", { actor: options.actor, tool: options.tool, entry_id: null, target: null, version: null, previous_version: null, previous_hash: null, hash: null, history_ref: null, raw_source_ref: source.rawSourceRef, reason: null, changed_fields: null, entry_count: result.entries.length, ok: result.ok });
  return result;
}

function normalizeCompileSourceInput(params: WikiCompileSourceInput): NormalizedCompileSourceInput {
  if ((params.mode as string) === "stage") throw new Error("mode=stage was removed; use mode=write");
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
    mode: params.mode === "write" ? "write" : "preview",
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

  return { rawSourceRef: `raw/${now.slice(0, 10)}-${sourcePageId}-source-${computeContentHash(input.source ?? "")}.md`, sourceContent: input.source ?? "", sourceTitle: input.sourceTitle, sourcePageId, wroteRawSource: false };
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
    .filter((candidate) => candidate.id !== sourceEntry.id && (candidate.reason === "canonical_id" || candidate.reason === "alias" || candidate.reason === "title"))
    .slice(0, Math.max(0, input.maxPagesTouched - 1));

  for (const candidate of updateCandidates) {
    const existing = existingEntries.find((entry) => entry.id === candidate.id);
    if (!existing) continue;
    proposals.push({
      op: "update_wiki",
      target: (await resolveWikiEntryPath(existing.id, paths))!,
      summary: truncateSummary(`Compile note for ${existing.title}`),
      entry: {
        ...existing,
        updated: now,
        version: existing.version + 1,
        rawSourceRef: resolvedSource.rawSourceRef,
        rawSourceRefs: mergeRawSourceRefs(existing.rawSourceRefs, existing.rawSourceRef, { ref: resolvedSource.rawSourceRef }),
        body: appendSourceCompileNote(existing.body, resolvedSource.sourcePageId, resolvedSource.rawSourceRef),
      },
      baseHash: computeContentHash(await readPatchFile(path.join(paths.root, (await resolveWikiEntryPath(existing.id, paths))!))),
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

function buildCompileWarnings(input: NormalizedCompileSourceInput, mode: "preview" | "write"): string[] {
  const warnings: string[] = [];
  if (mode === "preview") {
    warnings.push("preview mode does not persist sources, entries, or logs");
  }
  if (input.updateIndex) {
    warnings.push("index is generated; update_index ignored");
  }
  if (!input.updateLog) warnings.push("audit logging is mandatory; update_log=false ignored");
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
