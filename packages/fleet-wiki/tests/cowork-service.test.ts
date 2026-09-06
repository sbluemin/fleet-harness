import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryPaths, ensureMemoryRoot, loadIndex, readWikiEntry, writeWikiEntry } from "../src/index.js";
import { describe, expect, it } from "vitest";
import { CoworkService, CoworkStore, type CoworkAgentClient, type CoworkConnector } from "../src/cowork/index.js";

describe("Cowork contract defects", () => {
  it("applies a valid draft through Fleet Wiki and releases the session", async () => {
    const { service, store, paths } = await fixture();
    const session = await service.create("workspace", "entry");
    await store.update("workspace", session.id, s => ({ ...s, state: "running" }));
    await store.draftPort("workspace", session.id).write({ body: draft({ body: "Updated", version: 1 }), expectedRevision: 0 });
    await store.update("workspace", session.id, s => ({ ...s, state: "idle" }));

    await expect(service.apply("workspace", session.id)).resolves.toMatchObject({ state: "applied" });
    await expect(readWikiEntry("entry", paths)).resolves.toMatchObject({ body: "Updated", version: 2 });
    const index = await loadIndex(paths);
    expect(index.entry?.path).toBe("wiki/entry.md");
    expect(index.entry?.updated).not.toBe("2026-01-01T00:00:00.000Z");
    expect((await service.get("workspace", session.id))?.state).toBe("applied");
  });

  it("restores durable annotations when the provider fails mid-run", async () => {
    const connector = new FakeConnector();
    connector.client.sendMessage = async () => { throw new Error("boom"); };
    const { service } = await fixture(connector);
    const session = await service.create("workspace", "entry");
    await service.annotations("workspace", session.id, [{ id: "a1", quote: "quote", comment: "fix this" }]);
    await service.prompt("workspace", session.id, "go");
    await until(async () => (await service.get("workspace", session.id))?.state === "idle");

    // 전송 실패 시 선제 클리어된 어노테이션이 durable 세션에 복원되어야 한다.
    expect((await service.get("workspace", session.id))?.annotations).toEqual([{ id: "a1", quote: "quote", comment: "fix this" }]);
  });

  it("accumulates fake connector chunks and emits SSE-safe events without provider identity", async () => {
    const connector = new FakeConnector();
    const { service, store } = await fixture(connector);
    const session = await service.create("workspace", "entry");
    const events: unknown[] = [];
    service.subscribe(session.id, event => events.push(event));

    await service.prompt("workspace", session.id, "Revise this");
    connector.client.emit("messageChunk", "first ");
    connector.client.emit("messageChunk", "second");
    connector.client.emit("promptComplete");
    await until(async () => (await store.events("workspace", session.id)).some(event => event.type === "done"));

    expect(await store.transcript("workspace", session.id)).toEqual(expect.arrayContaining([{ role: "user", text: "Revise this", at: expect.any(String) }, { role: "assistant", text: "first second", at: expect.any(String) }]));
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "transcript", text: "first " }), expect.objectContaining({ type: "done" })]));
    expect((await service.get("workspace", session.id))?.state).toBe("idle");
    // 원샷 실행: provider 세션 식별자는 어디에도 저장·노출되지 않는다.
    expect(JSON.stringify({ session: await service.get("workspace", session.id), events })).not.toContain("provider-session-only");
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
function draft(value: { body: string; version: number }) { const e = { ...entry(), ...value }; return `---\nid: ${e.id}\ntitle: ${e.title}\ntags: ["test"]\ncreated: ${e.created}\nupdated: ${e.updated}\nversion: ${e.version}\n---\n${e.body}`; }
async function until(condition: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error("condition not met within timeout");
}
class FakeConnector implements CoworkConnector {
  readonly client = new EventEmitter() as EventEmitter & { getConnectionInfo(): { sessionId: string }; sendMessage(content: string): Promise<{}>; cancelPrompt(): Promise<void>; disconnect(): Promise<void> };
  constructor() { this.client.getConnectionInfo = () => ({ sessionId: "provider-session-only" }); this.client.sendMessage = async () => ({}); this.client.cancelPrompt = async () => {}; this.client.disconnect = async () => {}; }
  async connect(): Promise<CoworkAgentClient> { return this.client as unknown as CoworkAgentClient; }
}
