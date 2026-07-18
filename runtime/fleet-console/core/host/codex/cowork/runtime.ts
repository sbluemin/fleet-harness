import { createExecutorSessionManager, createInProcessMcpServer, createMcpToolRegistry, createMcpToolSnapshotStore } from "@dotobokuri/core-agent";
import { createWikiDraftToolSpecs, getWikiToolSpecs } from "@dotobokuri/fleet-wiki";
import type { WikiWorkspaceResolver } from "@dotobokuri/fleet-wiki";
import type { CoworkStore } from "./store.js";

/** The per-session registry is deliberately not shared with global Wiki tools. */
export function createCoworkMcpRuntime(store: CoworkStore, workspaceId: string, sessionId: string, resolver?: WikiWorkspaceResolver) {
  const registry = createMcpToolRegistry();
  const snapshots = createMcpToolSnapshotStore();
  const server = createInProcessMcpServer({ toolSnapshotStore: snapshots });
  const manager = createExecutorSessionManager({ runtimes: [{ name: "cowork", runtime: { registry, snapshotStore: snapshots, server } }] });
  const draftTools = createWikiDraftToolSpecs({ draft: store.draftPort(workspaceId, sessionId) });
  const allowedToolIds = ["wiki_draft_read", "wiki_draft_edit", "wiki_draft_write", "wiki_briefing", "wiki_orient", "wiki_read", "wiki_resolve"] as const;
  const specs = [...draftTools, ...getWikiToolSpecs(resolver).filter(spec => allowedToolIds.includes(spec.id as typeof allowedToolIds[number]))];
  // The session-token snapshot scopes tools/list, but the executor call router still
  // invokes through the registry — the same seven specs must be registered there too.
  for (const spec of specs) registry.registerAgentTool(spec);
  // 스코프 강제는 승인 게이트가 아니라 전용 MCP 도구 주입 + 시스템 프롬프트가 담당한다.
  // yolo/autoApprove가 없으면 백엔드별 승인 프로토콜(claude/opencode/cursor)마다 브릿지가 필요해진다.
  return { registry, snapshots, server, manager, specs, allowedToolIds, connection: { strictMcp: true, yoloMode: true, autoApprove: true } };
}
