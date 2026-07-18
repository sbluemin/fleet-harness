import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryPaths, ensureMemoryRoot, loadIndex, readWikiEntry, writeWikiEntry } from "@dotobokuri/fleet-wiki";
import type { AcpPermissionRequestParams, AcpPermissionResponse, IUnifiedAgentClient } from "@dotobokuri/core-unified-agent";
import { describe, expect, it } from "vitest";
import { createCoworkMcpRuntime } from "../core/host/codex/cowork/runtime.js";
import { CoworkService, type CoworkConnector, permissionResponse } from "../core/host/codex/cowork/service.js";
import { CoworkStore } from "../core/host/codex/cowork/store.js";

describe("Cowork MCP runtime", () => {
  it("defaults to the seven-tool, host-file-denied connection", async () => {
    const store = new CoworkStore(await mkdtemp(join(tmpdir(), "cowork-"))); const session = await store.create("workspace", "entry", "draft");
    const runtime = createCoworkMcpRuntime(store, "workspace", session.id);
    expect(runtime.allowedToolIds).toHaveLength(7);
    expect(runtime.connection).toEqual({ strictMcp: true, yoloMode: false, autoApprove: false, hostFileAccess: "deny" });
  });

  it("preserves draft and session when the Wiki base has gone stale", async () => {
    const { service, store, paths } = await fixture();
    const session = await service.create("workspace", "entry");
    const changedDraft = draft({ body: "Cowork draft", version: 1 });
    await store.update("workspace", session.id, s => ({ ...s, state: "running" }));
    await store.draftPort("workspace", session.id).write({ body: changedDraft, expectedRevision: 0 });
    await store.update("workspace", session.id, s => ({ ...s, state: "idle" }));
    await writeWikiEntry({ ...entry(), body: "External", version: 2 }, paths);

    await expect(service.apply("workspace", session.id)).rejects.toThrow("cowork_apply_stale");
    expect(await store.draftPort("workspace", session.id).read()).toEqual({ body: changedDraft, revision: 1 });
    expect((await service.get("workspace", session.id))?.state).toBe("idle");
  });

  it("safely rejects a malformed draft before it can be applied", async () => {
    const { service, store } = await fixture();
    const session = await service.create("workspace", "entry");
    await store.update("workspace", session.id, s => ({ ...s, state: "running" }));
    await store.draftPort("workspace", session.id).write({ body: "title: no frontmatter", expectedRevision: 0 });
    await store.update("workspace", session.id, s => ({ ...s, state: "idle" }));
    await expect(service.apply("workspace", session.id)).rejects.toThrow("cowork_apply_invalid_draft");
    expect((await service.get("workspace", session.id))?.state).toBe("idle");
  });

  it("rejects every provider permission request — the MCP token registry is the only grant path", () => {
    // Cowork MCP tools never pass through provider approval; anything that asks is CLI-native and must be denied.
    for (const title of ["mcp__cowork__wiki_draft_read", "bash", "write_file", "bash__wiki_read", "arbitrary.wiki_read"]) {
      const response: AcpPermissionResponse = permissionResponse(permission(title));
      expect(response).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } });
    }
    expect(permissionResponse({ ...permission("bash"), options: [] })).toEqual({ outcome: { outcome: "cancelled" } });
  });

});

async function fixture(connector: CoworkConnector = new FakeConnector()) {
  const root = await mkdtemp(join(tmpdir(), "cowork-"));
  const paths = createMemoryPaths(join(root, "knowledge"));
  await ensureMemoryRoot(paths);
  await writeWikiEntry(entry(), paths);
  const store = new CoworkStore(root);
  return { paths, store, service: new CoworkService(store, paths, root, connector) };
}
function entry() { return { id: "entry", title: "Entry", tags: ["test"], created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z", version: 1, body: "Original" }; }
function draft(value: { body: string; version: number }) { const e = { ...entry(), ...value }; return `---\nid: ${e.id}\ntitle: ${e.title}\ntags: ["test"]\ncreated: ${e.created}\nupdated: ${e.updated}\nversion: ${e.version}\n---\n${e.body}`; }
function permission(title: string): AcpPermissionRequestParams { return { sessionId: "session", toolCall: { toolCallId: "call", title, kind: "other", status: "pending", rawInput: {} }, options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "reject-once", name: "Reject once", kind: "reject_once" }] } as AcpPermissionRequestParams; }
class FakeConnector implements CoworkConnector {
  readonly client = new EventEmitter() as EventEmitter & { getConnectionInfo(): { sessionId: string }; sendMessage(content: string): Promise<{}>; cancelPrompt(): Promise<void>; disconnect(): Promise<void> };
  constructor() { this.client.getConnectionInfo = () => ({ sessionId: "provider-session-only" }); this.client.sendMessage = async () => ({}); this.client.cancelPrompt = async () => {}; this.client.disconnect = async () => {}; }
  async connect(): Promise<IUnifiedAgentClient> { return this.client as unknown as IUnifiedAgentClient; }
}
