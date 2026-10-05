import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryPaths, ensureMemoryRoot, writeWikiEntry } from "../server/wiki/index.js";
import { describe, expect, it } from "vitest";
import { DEFAULT_EXPERIMENT_SETTINGS, type ConsoleExperimentSettings } from "@fleet-console/sdk/settings";
import { resolveRosterCoordinate, type ModelRoster } from "@fleet-console/sdk/models";
import type { OperationLaunchVariantRow } from "@fleet-console/sdk/operations";
import type { FleetPluginModelsHost } from "@fleet-console/sdk/plugin";
import { handleCoworkRequest } from "../server/codex/cowork/routes.js";
import { CoworkService, CoworkStore, type CoworkAgentClient, type CoworkConnector } from "../server/codex/cowork/index.js";
import { EventEmitter } from "node:events";

describe("Cowork DTO", () => {
  it("does not expose the server-only target path", () => {
    const service = Object.create(CoworkService.prototype) as CoworkService;
    expect(service.dto({ id: "s", workspaceId: "w", entryId: "e", state: "idle", revision: 0, stateSequence: 0, draft: "x", baseDraft: "x", baseHash: "h", baseVersion: 0, selection: null, annotations: [], createdAt: "now", updatedAt: "now", targetPath: "wiki/secret/e.md" })).not.toHaveProperty("targetPath");
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
  it("resolves the Settings coordinate against the host model roster and falls back to Sonnet when the model is off", async () => {
    const root = await mkdtemp(join(tmpdir(), "cowork-options-"));
    const paths = createMemoryPaths(join(root, "knowledge"));
    await ensureMemoryRoot(paths);
    const service = new CoworkService(new CoworkStore(), paths, root, new FakeConnector());
    // 레거시 Claude Code 디스커버리 표기로 저장된 값 — 읽을 때 정준 id로 접히고 저장값은 그대로다.
    let experiments: ConsoleExperimentSettings = { ...DEFAULT_EXPERIMENT_SETTINGS, coworkModel: "claude-gateway--codex--gpt-6-luna", coworkEffort: "xhigh" };
    const sonnet = { group: "gateway:claude", label: "Sonnet", id: "sonnet", ladder: ["low", "medium", "high", "xhigh", "max"] };
    const luna = { group: "gateway:codex", label: "GPT-6-Luna", id: "codex--gpt-6-luna", ladder: ["low", "medium", "high", "xhigh"] };
    let enabled = [sonnet, luna];
    const models = rosterHost(() => enabled);
    const server = createServer((request, response) => void handleCoworkRequest(request, response, { workspaceId: "workspace", paths, coworkService: service, allowedOrigins: new Set(["http://console.test"]), port: 0, admitted: true, models, readExperiments: () => experiments }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server has no TCP address");
      const url = `http://127.0.0.1:${address.port}/api/cowork/options`;
      const enabledResponse = await (await fetch(url)).json() as { defaultModel: string; defaultEffort: string; efforts: string[]; fallback: boolean; rows: Array<{ id: string; label: string; provider: string }> };
      // 강도는 고른 행의 사다리 전체다 — 예전 3단 상한은 없다.
      expect(enabledResponse).toMatchObject({ defaultModel: "codex--gpt-6-luna", defaultEffort: "xhigh", efforts: luna.ladder, fallback: false });
      expect(enabledResponse.rows).toContainEqual({ id: "codex--gpt-6-luna", label: "GPT-6-Luna", provider: "codex" });
      // Settings › AI Gateway에서 그 모델을 끄면 목록에서 빠지고 Sonnet으로 실행하되, 저장된 강도는 유지된다.
      enabled = [sonnet];
      expect(await (await fetch(url)).json()).toMatchObject({ defaultModel: "sonnet", defaultEffort: "xhigh", fallback: true });
      // 로스터가 비어도 실행은 최후 폴백(sonnet)으로 서고 폴백 표식이 붙는다.
      enabled = [];
      experiments = { ...experiments, coworkModel: "sonnet", coworkEffort: "low" };
      expect(await (await fetch(url)).json()).toMatchObject({ models: ["sonnet"], defaultModel: "sonnet", defaultEffort: "low", fallback: true });
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});

/** 호스트 포트(`ctx.host.models`)의 대역 — 로스터 해석은 SDK의 공용 규칙 그대로다. */
function rosterHost(rows: () => readonly { group: string; label: string; id: string; ladder: readonly string[] }[]): Pick<FleetPluginModelsHost, "roster" | "resolve"> {
  const roster = (): ModelRoster => {
    const groups = new Map<string, OperationLaunchVariantRow[]>();
    for (const row of rows()) groups.set(row.group, [...(groups.get(row.group) ?? []), { id: row.id, label: row.label, launch: { model: row.id }, effortAxis: [...row.ladder], chips: row.ladder.map((effort) => ({ id: effort, label: effort, launch: { model: row.id, effort } })) }]);
    return [...groups].map(([id, groupRows]) => ({ id, label: id, rows: groupRows }));
  };
  return {
    roster,
    resolve: (stored, _target, fallback) => {
      const resolved = resolveRosterCoordinate(roster(), stored, fallback ?? { model: "sonnet" });
      return { ...resolved, wireModel: resolved.model };
    },
  };
}

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
