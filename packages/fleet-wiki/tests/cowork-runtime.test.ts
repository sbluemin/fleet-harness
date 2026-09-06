import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryPaths, ensureMemoryRoot, readWikiEntry, writeWikiEntry } from "../src/index.js";
import { describe, expect, it } from "vitest";
import { createCoworkMcpRuntime } from "../src/cowork/index.js";
import { CoworkService, CoworkStore, type CoworkAgentClient, type CoworkConnectOptions, type CoworkConnector } from "../src/cowork/index.js";

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
    const runtime = createCoworkMcpRuntime(store, "workspace", session.id);
    expect([...runtime.allowedToolIds]).toEqual([...SCOPED_TOOL_IDS]);
    expect(runtime.specs.map(spec => spec.id).sort()).toEqual([...SCOPED_TOOL_IDS].sort());
    expect(runtime).not.toHaveProperty("connection");
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
