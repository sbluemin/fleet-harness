import { mergeRawSourceRefs, normalizeComparableText } from "../briefing.js";
import { resolveMemoryPaths, resolveToolMemoryPaths } from "../paths.js";
import { inferTemplateIdFromTarget, scanTemplates } from "../schema.js";
import { WIKI_INGEST_DESCRIPTION, WIKI_INGEST_GUIDELINES, WIKI_INGEST_PROMPT_SNIPPET, buildWikiIngestSchema } from "../prompts.js";
import { assertNoUnsafeSecret, findUnsafeMemoryText, assertSafeEntryId, computeContentHash, listWiki, readRawSourceEntry, writeRawSourceEntry } from "../store.js";
import { checkEntryBase, readCurrentEntry, withWikiWriteLock, writeEntry } from "../write.js";
import type { DuplicatePolicy, RawSourceEntry, WikiEntry, WikiIngestMode } from "../types.js";
import type { WikiToolExecutionContext } from "../tool-context.js";

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

const MIN_WIKI_BODY_LENGTH = 120;
const INLINE_RAW_SOURCE_REF_TOKEN = /(?:^|\n)raw_source_ref\s*:/i;

export function buildIngestToolConfig() {
  return {
    name: "wiki_ingest", label: "Wiki Ingest", description: WIKI_INGEST_DESCRIPTION,
    promptSnippet: WIKI_INGEST_PROMPT_SNIPPET, promptGuidelines: [...WIKI_INGEST_GUIDELINES], parameters: buildWikiIngestSchema(),
    async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: WikiToolExecutionContext) {
      const paths = resolveToolMemoryPaths(ctx);
      const input = parseIngestParams(params);
      const result = await withWikiWriteLock(paths, async () => {
        const now = new Date().toISOString();
        const mode = input.mode ?? "auto";
        const current = await readCurrentEntry(paths, input.id);
        const options = { actor: input.proposer ?? "tool:wiki_ingest", tool: "wiki_ingest", base_version: input.base_version, base_hash: input.base_hash };
        checkEntryBase(input.id, current, options);
        if (mode === "create" && current) throw new Error(`[fleet-wiki] wiki_ingest create target already exists: ${input.id} - use mode=update`);
        if (mode === "update" && !current) throw new Error(`[fleet-wiki] wiki_ingest update target does not exist: ${input.id} - use mode=create`);
        const duplicate = await findDuplicateMatch(input, paths);
        if (duplicate) throw new Error(duplicate.message);
        const warnings = findUnsafeMemoryText(input.source).filter(issue => issue.severity === "warning").map(issue => issue.message);
        const rawSource = buildRawSourceEntry(input, now);
        const contradiction = await detectRawSourceContradiction(input, rawSource, current?.entry ?? null, paths);
        if (contradiction) {
          if (input.duplicate_policy !== "append_evidence") throw new Error(contradiction);
          warnings.push(contradiction);
        }
        const target = current?.target ?? `wiki/${input.id}.md`;
        const templateId = input.template_id ?? current?.entry.templateId ?? inferTemplateIdFromTarget(target, (await scanTemplates(paths)).map(t => t.id));
        let entry = current ? buildUpdateEntry(current.entry, input, now, templateId) : buildCreateEntry(input, now, templateId);
        if (contradiction && current) entry = { ...entry, body: current.entry.body };
        let rawSourceRef = "";
        const written = await writeEntry(entry, target, paths, options, async next => {
          rawSourceRef = await writeRawSourceEntry(rawSource, paths);
          return { ...next, rawSourceRef, rawSourceRefs: mergeRawSourceRefs(next.rawSourceRefs, next.rawSourceRef, { ref: rawSourceRef, title: rawSource.title, hash: computeContentHash(rawSource.content) }) };
        });
        return { ok: true, mode, op: current ? "update_wiki" : "create_wiki", ...written, raw_source_ref: rawSourceRef, warnings };
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: { raw_source_ref: result.raw_source_ref } };
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

async function findDuplicateMatch(
  input: WikiIngestParams,
  paths: ReturnType<typeof resolveMemoryPaths>,
): Promise<{ message: string } | null> {
  const normalizedTitle = normalizeComparableText(input.title);
  for (const entry of await listWiki(paths)) {
    if (entry.id === input.id) continue;
    if (normalizeComparableText(entry.title) === normalizedTitle) {
      return {
        message: `[fleet-wiki] wiki_ingest duplicate title detected: "${input.title}" already used by ${entry.id}`,
      };
    }
    if (entry.aliases?.some((alias) => normalizeComparableText(alias) === normalizedTitle)) {
      return {
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
  if (value === "queue_conflict") throw new Error("duplicate_policy=queue_conflict was removed; use reject or append_evidence");
  return value === "reject" || value === "append_evidence" ? value : undefined;
}

function normalizeTemplateInput(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
