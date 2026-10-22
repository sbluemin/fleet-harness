import { resolveToolMemoryPaths } from "../paths.js";
import { WIKI_EDIT_DESCRIPTION, WIKI_EDIT_GUIDELINES, WIKI_EDIT_PROMPT_SNIPPET, buildWikiEditSchema } from "../prompts.js";
import { assertSafeEntryId, parseWikiEntry, wrapWikiEntryBoundary } from "../store.js";
import { listHistory, readHistory } from "../history.js";
import { checkEntryBase, deleteEntry, readCurrentEntry, restoreEntry, withWikiWriteLock, writeEntry } from "../write.js";
import type { WikiEntry } from "../types.js";
import type { WikiToolExecutionContext } from "../tool-context.js";

interface BodyReplaceInput {
  find: string;
  replace: string;
  expected_occurrences?: number;
}

interface EntryEditParams {
  entry_id: string;
  base_hash?: string;
  base_version?: number;
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
  touch_updated: boolean;
  proposer: string;
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

export function buildEditToolConfig() {
  return {
    name: "wiki_edit", label: "Wiki Edit", description: WIKI_EDIT_DESCRIPTION,
    promptSnippet: WIKI_EDIT_PROMPT_SNIPPET, promptGuidelines: [...WIKI_EDIT_GUIDELINES], parameters: buildWikiEditSchema(),
    async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: WikiToolExecutionContext) {
      const paths = resolveToolMemoryPaths(ctx);
      const input = parseEntryEditParams(params);
      const action = params.action ?? "edit";
      const options = { actor: input.proposer, tool: "wiki_edit", base_hash: input.base_hash, base_version: input.base_version };
      let result: unknown;
      if (action === "history") {
        if (typeof params.history_ref === "string") {
          const { markdown } = await readHistory(paths, input.entry_id, params.history_ref);
          const entry = parseWikiEntry(markdown);
          result = { entry_id: input.entry_id, history_ref: params.history_ref, content: wrapWikiEntryBoundary({ id: entry.id, updated: entry.updated, content: markdown }) };
        } else result = { entry_id: input.entry_id, history: await listHistory(paths, input.entry_id) };
      } else {
        result = await withWikiWriteLock(paths, async () => {
          if (action === "delete") {
            if (params.reason !== undefined && (typeof params.reason !== "string" || params.reason.length > 256)) throw new Error("reason must be at most 256 characters");
            return deleteEntry(input.entry_id, paths, { ...options, reason: params.reason as string | undefined });
          }
          if (action === "restore") {
            if (typeof params.history_ref !== "string") throw new Error("history_ref is required for restore");
            return restoreEntry(input.entry_id, params.history_ref, paths, options);
          }
          if (action !== "edit") throw new Error("invalid wiki_edit action");
          const current = await readCurrentEntry(paths, input.entry_id);
          if (!current) throw new Error("entry_not_found");
          checkEntryBase(input.entry_id, current, options);
          const entry = { ...current.entry };
          const changedFields = applyEntryEdits(entry, input);
          const replacements = applyBodyReplacement(entry, input.body_replace);
          if (replacements) changedFields.push("body");
          const written = await writeEntry(entry, current.target, paths, { ...options, historyOp: "edit", touch_updated: input.touch_updated, changed_fields: changedFields });
          return { ...written, changed_fields: changedFields, body_replacements: replacements };
        });
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: {} };
    },
  };
}

function parseEntryEditParams(params: Record<string, unknown>): EntryEditParams {
  const entryId = String(params.entry_id ?? "").trim();
  assertSafeEntryId(entryId);
  return {
    entry_id: entryId,
    base_hash: typeof params.base_hash === "string" ? params.base_hash.trim() : undefined,
    base_version: typeof params.base_version === "number" ? params.base_version : undefined,
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
    touch_updated: params.touch_updated !== false,
    proposer: typeof params.proposer === "string" && params.proposer.trim() ? params.proposer.trim() : "tool:wiki_edit",
  };
}

function applyEntryEdits(entry: WikiEntry, input: EntryEditParams): string[] {
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
    throw new Error(`wiki_edit body_replace expected ${expected} occurrence(s), found ${occurrences}`);
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
