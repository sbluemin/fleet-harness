import { appendLog } from "../log.js";
import { enqueuePatch } from "../patch.js";
import { resolveMemoryPaths } from "../paths.js";
import {
  WIKI_INGEST_DESCRIPTION,
  WIKI_INGEST_GUIDELINES,
  WIKI_INGEST_PROMPT_SNIPPET,
  buildWikiIngestSchema,
} from "../prompts.js";
import { assertNoUnsafeSecret, findUnsafeMemoryText } from "../safety.js";
import { assertSafeEntryId, writeRawSourceEntry } from "../store.js";
import type { Patch, RawSourceEntry, WikiEntry } from "../types.js";

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
      ctx: { cwd: string },
    ) {
      const now = new Date().toISOString();
      const paths = resolveMemoryPaths(ctx.cwd);
      const entryId = String(params.id);
      const sourceContent = String(params.source);
      const wikiBody = String(params.body).trim();
      assertSafeEntryId(entryId);
      assertNoUnsafeSecret(sourceContent);
      validateWikiBody(wikiBody);
      const warnings = findUnsafeMemoryText(sourceContent)
        .filter((issue) => issue.severity === "warning")
        .map((issue) => issue.message);
      const rawSource: RawSourceEntry = {
        id: `${entryId}-source`,
        created: now,
        sourceType: params.source_type === "file" ? "file" : "inline",
        title: typeof params.source_title === "string" ? params.source_title : String(params.title),
        tags: Array.isArray(params.tags) ? params.tags.map(String) : [],
        content: sourceContent,
      };
      const rawSourceRef = await writeRawSourceEntry(rawSource, paths);
      await appendLog(paths, "raw source added", {
        id: rawSource.id,
        raw_source_ref: rawSourceRef,
        source_type: rawSource.sourceType,
        tag_count: rawSource.tags.length,
        title: rawSource.title ?? null,
      });

      const entry: WikiEntry = {
        id: entryId,
        title: String(params.title),
        body: wikiBody,
        tags: Array.isArray(params.tags) ? params.tags.map(String) : [],
        created: now,
        updated: now,
        version: 1,
        rawSourceRef,
      };
      const patch: Patch = {
        frontmatter: {
          op: "create_wiki",
          target: `wiki/${entry.id}.md`,
          summary: `${entry.title}`.slice(0, 120),
          proposer: String(params.proposer ?? "tool:wiki_ingest"),
          created: now,
        },
        body: JSON.stringify(entry),
      };
      const patchId = await enqueuePatch(patch, paths, { rawSourceRef, warnings });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ok: true, patch_id: patchId, raw_source_ref: rawSourceRef, warnings }, null, 2),
        }],
        details: { raw_source_ref: rawSourceRef },
      };
    },
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
