import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryPaths, ensureMemoryRoot, readWikiEntry, writeWikiEntry } from "../server/wiki/index.js";
import { describe, expect, it } from "vitest";
import { createCoworkTools } from "../server/codex/cowork/index.js";
import { CoworkService, CoworkStore, type CoworkAgentClient, type CoworkConnectOptions, type CoworkConnector } from "../server/codex/cowork/index.js";

const SCOPED_TOOL_IDS = [
  "wiki_draft_read",
  "wiki_draft_edit",
  "wiki_draft_write",
  "wiki_briefing",
  "wiki_orient",
  "wiki_read",
  "wiki_resolve",
] as const;

describe("Cowork MCP runtime", () => {
  it("exposes only the seven scoped MCP tools", async () => {
    const store = new CoworkStore(); const session = await store.create("workspace", "entry", "draft");
    const runtime = createCoworkTools(store, "workspace", session.id, "/workspace");
    expect(runtime.flatMap(group => group.tools.map(tool => tool.name)).sort()).toEqual([...SCOPED_TOOL_IDS].sort());
  });

  it("preserves draft and session when the Wiki base has gone stale", async () => {
    const connector = new FakeConnector();
    const { service, store, paths } = await fixture(connector);
    await writeWikiEntry({ ...entry(), body: "Original\nStable" }, paths);
    const session = await service.create("workspace", "entry");
    const changedDraft = draft({ body: "Cowork draft\nStable", version: 1 });
    await store.update("workspace", session.id, s => ({ ...s, state: "running" }));
    await store.draftPort("workspace", session.id).write({ body: changedDraft, expectedRevision: 0 });
    await store.update("workspace", session.id, s => ({ ...s, state: "idle" }));
    await writeWikiEntry({ ...entry(), body: "External\nStable", version: 2 }, paths);

    await expect(service.apply("workspace", session.id)).rejects.toThrow("cowork_apply_stale");
    expect((await service.describe((await service.get("workspace", session.id))!)).freshness).toEqual({ stale: true, currentVersion: 2 });
    await expect(service.rebase("workspace", session.id, 1)).rejects.toThrow("cowork_reapply_conflict");
    expect(await store.draftPort("workspace", session.id).read()).toEqual({ body: changedDraft, revision: 1 });
    expect((await service.get("workspace", session.id))?.state).toBe("idle");

    // 바깥에서 메타데이터가 깨져도 실행 잠금과 코멘트 손실 없이 낡음으로 알린다.
    const annotations = [{ id: "a1", quote: "Stable", comment: "코멘트 보존" }];
    await service.annotations("workspace", session.id, annotations);
    await writeFile(join(paths.root, "wiki/entry.md"), "---\nid: entry\ntitle: Broken\n---\nExternal", "utf8");
    await expect(service.prompt("workspace", session.id, "Review")).rejects.toThrow("cowork_entry_unavailable");
    expect(await service.describe((await service.get("workspace", session.id))!)).toMatchObject({ state: "idle", draft: changedDraft, revision: 1, annotations, freshness: { stale: true, currentVersion: null } });
    expect(connector.connected).toHaveLength(0);
    expect(await store.transcript("workspace", session.id)).toEqual([]);

    await writeWikiEntry({ ...entry(), body: "Original\nServer", version: 2 }, paths);
    const rebased = await service.rebase("workspace", session.id, 1);
    expect(rebased).toMatchObject({ state: "idle", baseVersion: 2, revision: 2 });
    expect(rebased.draft).toContain("Cowork draft\nServer");
    expect((await readWikiEntry("entry", paths))?.body).toBe("Original\nServer");
    await expect(service.apply("workspace", session.id, 1)).rejects.toThrow("cowork_apply_stale_revision");
    await service.apply("workspace", session.id, 2);
    expect(await readWikiEntry("entry", paths)).toMatchObject({ version: 3, body: "Cowork draft\nServer" });
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
});

async function fixture(connector: CoworkConnector = new FakeConnector()) {
  const root = await mkdtemp(join(tmpdir(), "cowork-"));
  const paths = createMemoryPaths(join(root, "knowledge"));
  await ensureMemoryRoot(paths);
  await writeWikiEntry(entry(), paths);
  const store = new CoworkStore();
  return { paths, store, service: new CoworkService(store, paths, root, connector) };
}
function entry() { return { id: "entry", title: "Entry", tags: ["test"], created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z", version: 1, body: "Original" }; }
function draft(value: { body: string; version: number; templateId?: string }) { const e = { ...entry(), ...value }; return `---\nid: ${e.id}\ntitle: ${e.title}\ntags: ["test"]\ncreated: ${e.created}\nupdated: ${e.updated}\nversion: ${e.version}\n${value.templateId ? `template_id: ${value.templateId}\n` : ""}---\n${e.body}`; }
async function until(condition: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error("condition not met within timeout");
}
class FakeConnector implements CoworkConnector {
  readonly connected: CoworkConnectOptions[] = [];
  readonly client = new EventEmitter() as EventEmitter & { getConnectionInfo(): { sessionId: string }; sendMessage(content: string): Promise<{}>; cancelPrompt(): Promise<void>; disconnect(): Promise<void> };
  constructor() { this.client.getConnectionInfo = () => ({ sessionId: "provider-session-only" }); this.client.sendMessage = async () => ({}); this.client.cancelPrompt = async () => {}; this.client.disconnect = async () => {}; }
  async connect(options: CoworkConnectOptions): Promise<CoworkAgentClient> {
    this.connected.push(options);
    return this.client as unknown as CoworkAgentClient;
  }
}
