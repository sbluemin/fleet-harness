import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryPaths, ensureMemoryRoot, readWikiEntry, writeWikiEntry } from "../src/index.js";
import type { IUnifiedAgentClient } from "@dotobokuri/core-unified-agent";
import { describe, expect, it } from "vitest";
import { createCoworkMcpRuntime } from "../src/cowork/index.js";
import { CoworkService, CoworkStore, type CoworkConnector } from "../src/cowork/index.js";

describe("Cowork MCP runtime", () => {
  it("runs one-shot yolo with only the seven scoped MCP tools", async () => {
    const store = new CoworkStore(); const session = await store.create("workspace", "entry", "draft");
    const runtime = createCoworkMcpRuntime(store, "workspace", session.id);
    expect(runtime.allowedToolIds).toHaveLength(7);
    expect(runtime.specs.map(spec => spec.id).sort()).toEqual([...runtime.allowedToolIds].sort());
    expect(runtime.connection).toEqual({ strictMcp: true, yoloMode: true, autoApprove: true });
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

  it("creates sessions for nested entries even when the index is stale", async () => {
    const { service, paths } = await fixture();
    // index.json이 모르는 중첩 엔트리 — readWikiEntry는 재귀 스캔으로 찾아낸다.
    const nested = join(paths.root, "wiki", "queries", "nested.md");
    await mkdir(join(paths.root, "wiki", "queries"), { recursive: true });
    await writeFile(nested, `---\nid: nested\ntitle: Nested\ntags: ["test"]\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\nversion: 1\n---\nNested body`, "utf8");

    const session = await service.create("workspace", "nested");
    expect(session.draft).toContain("Nested body");
    expect(session.targetPath).toBe("wiki/queries/nested.md");
  });

  it("keeps template_id through a cowork apply", async () => {
    const { service, store, paths } = await fixture();
    await mkdir(paths.schemaDir, { recursive: true });
    await writeFile(join(paths.schemaDir, "template-prd.md"), "---\ntitle: PRD\n---\n\n## Overview\n", "utf8");
    const session = await service.create("workspace", "entry");
    await store.update("workspace", session.id, s => ({ ...s, state: "running" }));
    await store.draftPort("workspace", session.id).write({ body: draft({ body: "## Overview\n\nTemplated", version: 1, templateId: "prd" }), expectedRevision: 0 });
    await store.update("workspace", session.id, s => ({ ...s, state: "idle" }));

    await expect(service.apply("workspace", session.id)).resolves.toMatchObject({ state: "applied" });
    // YAML의 template_id가 WikiEntry.templateId로 매핑되지 않으면 apply에서 소실된다.
    await expect(readWikiEntry("entry", paths)).resolves.toMatchObject({ templateId: "prd" });
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
class FakeConnector implements CoworkConnector {
  readonly client = new EventEmitter() as EventEmitter & { getConnectionInfo(): { sessionId: string }; sendMessage(content: string): Promise<{}>; cancelPrompt(): Promise<void>; disconnect(): Promise<void> };
  constructor() { this.client.getConnectionInfo = () => ({ sessionId: "provider-session-only" }); this.client.sendMessage = async () => ({}); this.client.cancelPrompt = async () => {}; this.client.disconnect = async () => {}; }
  async connect(): Promise<IUnifiedAgentClient> { return this.client as unknown as IUnifiedAgentClient; }
}
