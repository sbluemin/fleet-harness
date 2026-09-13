import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryPaths, ensureMemoryRoot, writeWikiEntry } from "@dotobokuri/fleet-wiki";
import { describe, expect, it } from "vitest";
import { DEFAULT_EXPERIMENT_SETTINGS, type ConsoleExperimentSettings } from "@fleet-console/sdk/settings";
import { handleCoworkRequest } from "../server/codex/cowork/routes.js";
import { CoworkService, CoworkStore, type CoworkAgentClient, type CoworkConnector } from "../server/codex/cowork/index.js";
import { EventEmitter } from "node:events";

describe("Cowork DTO", () => {
  it("does not expose the server-only target path", () => {
    const service = Object.create(CoworkService.prototype) as CoworkService;
    expect(service.dto({ id: "s", workspaceId: "w", entryId: "e", state: "idle", revision: 0, draft: "x", baseDraft: "x", baseHash: "h", baseVersion: 0, selection: null, annotations: [], createdAt: "now", updatedAt: "now", targetPath: "wiki/secret/e.md" })).not.toHaveProperty("targetPath");
  });

  it("maps a running re-prompt to cowork_busy with HTTP 409", async () => {
    const root = await mkdtemp(join(tmpdir(), "cowork-"));
    const paths = createMemoryPaths(join(root, "knowledge"));
    await ensureMemoryRoot(paths);
    await writeWikiEntry(entry(), paths);
    const connector = new FakeConnector();
    const service = new CoworkService(new CoworkStore(), paths, root, connector);
    const session = await service.create("workspace", "entry");
    await service.prompt("workspace", session.id, "first");
    const server = createServer((request, response) => void handleCoworkRequest(request, response, { workspaceId: "workspace", paths, coworkService: service, allowedOrigins: new Set(["http://console.test"]), port: 0, admitted: true }));
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

describe("Cowork options", () => {
  it("takes the model and effort from Settings and falls back to Sonnet when the configured model is not available", async () => {
    const root = await mkdtemp(join(tmpdir(), "cowork-options-"));
    const paths = createMemoryPaths(join(root, "knowledge"));
    await ensureMemoryRoot(paths);
    const service = new CoworkService(new CoworkStore(), paths, root, new FakeConnector());
    let experiments: ConsoleExperimentSettings = { ...DEFAULT_EXPERIMENT_SETTINGS, coworkModel: "claude-gateway--codex--gpt-5.6-luna", coworkEffort: "high" };
    const luna = { id: "codex--gpt-5.6-luna", provider: "codex", displayName: "Codex-GPT-5.6-Luna", contextWindow: 400_000, effort: { supported: true, levels: ["low", "medium", "high"] } };
    let enabled: readonly (typeof luna)[] = [luna];
    const server = createServer((request, response) => void handleCoworkRequest(request, response, { workspaceId: "workspace", paths, coworkService: service, allowedOrigins: new Set(["http://console.test"]), port: 0, admitted: true, enabledGatewayModels: enabled as never, readExperiments: () => experiments }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server has no TCP address");
      const url = `http://127.0.0.1:${address.port}/api/cowork/options`;
      const enabledResponse = await (await fetch(url)).json() as { defaultModel: string; defaultEffort: string; fallback: boolean; rows: Array<{ id: string; label: string; provider: string }> };
      expect(enabledResponse).toMatchObject({ defaultModel: "claude-gateway--codex--gpt-5.6-luna", defaultEffort: "high", fallback: false });
      expect(enabledResponse.rows).toContainEqual({ id: "claude-gateway--codex--gpt-5.6-luna", label: "GPT-5.6-Luna", provider: "codex" });
      // Settings › AI Gateway에서 그 모델을 끄면 목록에서 빠지고 Sonnet으로 내려간다 — 강도는 설정값을 유지한다.
      enabled = [];
      expect(await (await fetch(url)).json()).toMatchObject({ defaultModel: "sonnet", defaultEffort: "high", fallback: true });
      experiments = { ...experiments, coworkModel: "haiku", coworkEffort: "low" };
      expect(await (await fetch(url)).json()).toMatchObject({ defaultModel: "haiku", defaultEffort: "low", fallback: false });
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
  async connect(): Promise<CoworkAgentClient> { return this.client as unknown as CoworkAgentClient; }
}
