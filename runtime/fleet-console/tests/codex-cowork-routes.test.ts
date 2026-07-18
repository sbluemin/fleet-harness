import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryPaths, ensureMemoryRoot, writeWikiEntry } from "@dotobokuri/fleet-wiki";
import { describe, expect, it } from "vitest";
import { handleCoworkRequest } from "../core/host/codex/cowork/routes.js";
import { CoworkService, type CoworkConnector } from "../core/host/codex/cowork/service.js";
import { CoworkStore } from "../core/host/codex/cowork/store.js";
import type { IUnifiedAgentClient } from "@dotobokuri/core-unified-agent";
import { EventEmitter } from "node:events";

describe("Cowork DTO", () => {
  it("does not expose provider identity", () => {
    const service = Object.create(CoworkService.prototype) as CoworkService;
    expect(service.dto({ id: "s", workspaceId: "w", entryId: "e", state: "idle", revision: 0, draft: "x", baseHash: "h", baseVersion: 0, selection: null, annotations: [], createdAt: "now", updatedAt: "now", providerSessionId: "/secret" })).not.toHaveProperty("providerSessionId");
  });

  it("keeps provider identity out of DTO and SSE payloads while exposing user agent settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "cowork-"));
    const paths = createMemoryPaths(join(root, "knowledge"));
    await ensureMemoryRoot(paths);
    await writeWikiEntry(entry(), paths);
    const store = new CoworkStore(root);
    const service = new CoworkService(store, paths, root, new FakeConnector());
    const session = await service.create("workspace", "entry");
    await store.update("workspace", session.id, value => ({ ...value, providerSessionId: "/private/provider", cli: "codex", model: "secret-model", effort: "high" }));
    const events: unknown[] = [];
    service.subscribe(session.id, event => events.push(event));

    await service.setSelection("workspace", session.id, "selected");
    const dto = service.dto((await service.get("workspace", session.id))!);
    const payload = JSON.stringify({ dto, events });

    for (const secret of ["providerSessionId", "/private/provider", root]) expect(payload).not.toContain(secret);
    expect(dto).toMatchObject({ cli: "codex", model: "secret-model", effort: "high" });
  });

  it("maps a running re-prompt to cowork_busy with HTTP 409", async () => {
    const root = await mkdtemp(join(tmpdir(), "cowork-"));
    const paths = createMemoryPaths(join(root, "knowledge"));
    await ensureMemoryRoot(paths);
    await writeWikiEntry(entry(), paths);
    const connector = new FakeConnector();
    const service = new CoworkService(new CoworkStore(root), paths, root, connector);
    const session = await service.create("workspace", "entry");
    await service.prompt("workspace", session.id, "first");
    const server = createServer((request, response) => void handleCoworkRequest(request, response, { workspaceId: "workspace", paths, coworkService: service, allowedOrigins: new Set(["http://console.test"]), port: 0 }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server has no TCP address");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/cowork/sessions/${session.id}/prompt`, { method: "POST", headers: { origin: "http://console.test" }, body: JSON.stringify({ prompt: "second" }) });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "cowork_busy" });
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});

function entry() { return { id: "entry", title: "Entry", tags: ["test"], created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z", version: 1, body: "Original" }; }

class FakeConnector implements CoworkConnector {
  readonly client = new EventEmitter() as EventEmitter & { getConnectionInfo(): { sessionId: string }; sendMessage(content: string): Promise<{}>; cancelPrompt(): Promise<void>; disconnect(): Promise<void> };
  constructor() {
    this.client.getConnectionInfo = () => ({ sessionId: "provider-session-only" });
    this.client.sendMessage = async () => ({});
    this.client.cancelPrompt = async () => {};
    this.client.disconnect = async () => {};
  }
  async connect(): Promise<IUnifiedAgentClient> { return this.client as unknown as IUnifiedAgentClient; }
}
