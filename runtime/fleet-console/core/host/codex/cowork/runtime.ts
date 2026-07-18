import { createMcpToolRegistry, createMcpToolSnapshotStore } from "@dotobokuri/core-agent";
import { createWikiDraftToolSpecs } from "@dotobokuri/fleet-wiki";
import type { CoworkStore } from "./store.js";

/** The per-session registry is deliberately not shared with global Wiki tools. */
export function createCoworkMcpRuntime(store: CoworkStore, workspaceId: string, sessionId: string) {
  const registry = createMcpToolRegistry();
  const snapshots = createMcpToolSnapshotStore();
  const draftTools = createWikiDraftToolSpecs({ draft: store.draftPort(workspaceId, sessionId) });
  return { registry, snapshots, draftTools, allowedToolIds: ["wiki_draft_read", "wiki_draft_edit", "wiki_draft_write", "wiki_briefing", "wiki_orient", "wiki_read", "wiki_resolve"] as const, connection: { strictMcp: true, yoloMode: false, autoApprove: false, hostFileAccess: "deny" as const } };
}
