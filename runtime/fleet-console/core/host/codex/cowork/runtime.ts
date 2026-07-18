import { createExecutorSessionManager, createInProcessMcpServer, createMcpToolRegistry, createMcpToolSnapshotStore } from "@dotobokuri/core-agent";
import { createWikiDraftToolSpecs, getWikiToolSpecs } from "@dotobokuri/fleet-wiki";
import type { CoworkStore } from "./store.js";

/** The per-session registry is deliberately not shared with global Wiki tools. */
export function createCoworkMcpRuntime(store: CoworkStore, workspaceId: string, sessionId: string) {
  const registry = createMcpToolRegistry();
  const snapshots = createMcpToolSnapshotStore();
  const server = createInProcessMcpServer({ toolSnapshotStore: snapshots });
  const manager = createExecutorSessionManager({ runtimes: [{ name: "cowork", runtime: { registry, snapshotStore: snapshots, server } }] });
  const draftTools = createWikiDraftToolSpecs({ draft: store.draftPort(workspaceId, sessionId) });
  const allowedToolIds = ["wiki_draft_read", "wiki_draft_edit", "wiki_draft_write", "wiki_briefing", "wiki_orient", "wiki_read", "wiki_resolve"] as const;
  const specs = [...draftTools, ...getWikiToolSpecs().filter(spec => allowedToolIds.includes(spec.id as typeof allowedToolIds[number]))];
  return { registry, snapshots, server, manager, specs, allowedToolIds, connection: { strictMcp: true, yoloMode: false, autoApprove: false, hostFileAccess: "deny" as const } };
}
