import { listConflicts } from "../conflicts.js";
import { approvePatch, approvePatchSet, listQueue, rejectPatch, resolveQueueSelection, showQueue } from "../patch.js";
import { resolveToolMemoryPaths } from "../paths.js";
import {
  WIKI_PATCH_QUEUE_DESCRIPTION,
  WIKI_PATCH_QUEUE_GUIDELINES,
  WIKI_PATCH_QUEUE_PROMPT_SNIPPET,
  buildWikiPatchQueueSchema,
} from "../prompts.js";
import type { WikiToolExecutionContext } from "../agent-specs.js";

export function buildPatchQueueToolConfig() {
  return {
    name: "wiki_patch_queue",
    label: "Wiki Patch Queue",
    description: WIKI_PATCH_QUEUE_DESCRIPTION,
    promptSnippet: WIKI_PATCH_QUEUE_PROMPT_SNIPPET,
    promptGuidelines: [...WIKI_PATCH_QUEUE_GUIDELINES],
    parameters: buildWikiPatchQueueSchema(),
    async execute(
      _id: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: WikiToolExecutionContext,
    ) {
      const paths = resolveToolMemoryPaths(ctx);
      const action = String(params.action ?? "list");

      if (action === "list") {
        const items = await listQueue(paths);
        const unresolvedConflicts = (await listConflicts(paths)).filter((conflict) => conflict.status === "unresolved");
        return textResult({
          ok: true,
          action,
          items,
          unresolved_conflicts: unresolvedConflicts,
          next_action: items.length > 0 ? `Use patch_id from: ${items.map((item) => item.id).join(", ")}` : "Queue is empty.",
        });
      }
      if (action === "show") {
        const selection = await resolveQueueSelection(String(params.patch_id ?? ""), paths);
        const item = await showQueue(selection.id, paths);
        const relatedConflicts = (await listConflicts(paths)).filter((conflict) => {
          const patchWikiId = extractPatchWikiId(item.patch.body);
          return conflict.patchId === selection.id
            || conflict.target === item.patch.frontmatter.target
            || (patchWikiId !== null && conflict.wikiId === patchWikiId);
        });
        return textResult({
          ok: true,
          action,
          item,
          related_conflicts: relatedConflicts,
          auto_selected: selection.autoSelected,
        });
      }
      if (action === "approve") {
        const patchId = String(params.patch_id ?? "").trim();
        if (!patchId) {
          throw new Error(buildMissingPatchIdError("approve", await listQueue(paths)));
        }
        return textResult({ ok: true, action, meta: await approvePatch(patchId, paths) });
      }
      if (action === "reject") {
        const patchId = String(params.patch_id ?? "").trim();
        if (!patchId) {
          throw new Error(buildMissingPatchIdError("reject", await listQueue(paths)));
        }
        return textResult({
          ok: true,
          action,
          meta: await rejectPatch(patchId, String(params.reason ?? "rejected"), paths),
        });
      }
      if (action === "approve_set") {
        const patchSetId = String(params.patch_set_id ?? "").trim();
        if (!patchSetId) {
          throw new Error("wiki_patch_queue approve_set requires patch_set_id.");
        }
        const result = await approvePatchSet(patchSetId, paths);
        return textResult({
          ok: true,
          action,
          ...result,
        });
      }
      return textResult({ ok: false, action, error: "unsupported action" });
    },
  };
}

function textResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: {},
  };
}

function buildMissingPatchIdError(action: "approve" | "reject", items: Array<{ id: string }>): string {
  if (items.length === 0) {
    return `wiki_patch_queue ${action} requires patch_id. Queue is empty.`;
  }
  return `wiki_patch_queue ${action} requires patch_id. Available patch IDs: ${items.map((item) => item.id).join(", ")}`;
}

function extractPatchWikiId(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { id?: unknown };
    return typeof parsed.id === "string" ? parsed.id : null;
  } catch {
    return null;
  }
}
