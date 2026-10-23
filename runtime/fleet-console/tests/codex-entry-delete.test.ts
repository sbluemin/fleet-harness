import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { legacyKnowledgeRoot, startCodexTestServer } from "./codex-test-server.js";
import type { CodexTestServer } from "./codex-test-server.js";
import { createMemoryPaths, writeWikiEntry } from "../features/codex/host/wiki/index.js";

let server: CodexTestServer | null = null;
let root = "";
let baseUrl = "";
let knowledge = "";

describe("confirmed entry deletion", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "fleet-codex-delete-"));
    await writeWikiEntry({ id: "entry", title: "Entry", tags: [], created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z", version: 1, body: "Recoverable knowledge" }, createMemoryPaths(legacyKnowledgeRoot(root, root)));
    const lockPath = path.join(root, "server.lock");
    server = await startCodexTestServer({ cwd: root, lockPath, port: 0, host: "127.0.0.1" });
    const { port } = JSON.parse(await readFile(lockPath, "utf8")) as { port: number };
    baseUrl = `http://127.0.0.1:${port}/console/codex`;
    // 옛 자리에 둔 항목은 그 맥락 사령관의 지식으로 옮겨지고, 기록(history)도 거기에 쌓인다.
    knowledge = await server.knowledgeRoot(await server.registerWorkspace(root));
  });
  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = null;
    await rm(root, { recursive: true, force: true });
  });
  const post = (action: string, body: unknown) => fetch(`${baseUrl}/api/entry/entry/${action}`, { method: "POST", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify(body) });

  it("deletes matching content, keeps history, and restores once without overwriting a current entry", async () => {
    const entry = await (await fetch(`${baseUrl}/api/entry/entry`)).json() as { hash: string };
    const response = await post("delete", { expectedHash: entry.hash });
    expect(response.status).toBe(200);
    const { historyRef } = await response.json() as { historyRef: string };
    expect((await fetch(`${baseUrl}/api/entry/entry`)).status).toBe(404);
    expect(await readFile(path.join(knowledge, historyRef, "entry.md"), "utf8")).toContain("Recoverable knowledge");
    const restored = await post("restore", { historyRef });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ ok: true, version: 2 });
    expect((await post("restore", { historyRef })).status).toBe(409);
    const current = await (await fetch(`${baseUrl}/api/entry/entry`)).json() as { frontmatter: { version: number } };
    expect(current.frontmatter.version).toBe(2);
  });

  it("rejects stale hashes and leaves the entry untouched", async () => {
    const response = await post("delete", { expectedHash: "stale" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "entry_changed", currentHash: expect.any(String) });
    expect((await fetch(`${baseUrl}/api/entry/entry`)).status).toBe(200);
  });
});
