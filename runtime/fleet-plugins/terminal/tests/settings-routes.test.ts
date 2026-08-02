import type http from "node:http";

import type { GlobalOptionsData } from "@dotobokuri/core-infra";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { describe, expect, it } from "vitest";

import { normalizeAiGatewaySettings, type AiGatewayStoredSettings } from "../server/ai-gateway-settings.js";
import { registerTerminalSettingsRoutes } from "../server/settings-routes.js";

interface WriteJsonCall {
  readonly status: number;
  readonly body: unknown;
}

interface HarnessOptions {
  readonly terminalAuthorized?: boolean;
  readonly body?: unknown;
  readonly bodyNull?: boolean;
  readonly data?: GlobalOptionsData;
  readonly aiGateway?: AiGatewayStoredSettings;
}

describe("terminal settings routes", () => {
  it("GET /plugins/terminal/settings returns terminal settings", async () => {
    const harness = createRouteHarness({
      data: { version: 1, enableMetaphor: false },
    });
    await harness.handle({ req: req("GET"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(200);
    expect(harness.writes[0]?.body).toMatchObject({ enableMetaphor: false, agentIdleDormantMinutes: 60, aiGateway: null });
    expect(harness.writes[0]?.body).not.toHaveProperty("consolePortMode");
  });

  it("GET /plugins/terminal/settings ships the gateway catalog with both Kimi routes", async () => {
    const harness = createRouteHarness({ data: { version: 1 } });
    await harness.handle({ req: req("GET"), res: res(), pathname: "/plugins/terminal/settings" });
    const body = harness.writes[0]?.body as {
      readonly aiGatewayCatalog: { readonly providers: readonly { readonly id: string; readonly models: readonly { readonly id: string; readonly maxMode: boolean; readonly fast: boolean; readonly effort: unknown }[] }[] };
    };
    const providers = body.aiGatewayCatalog.providers;
    expect(providers.map((provider) => provider.id)).toEqual(["codex", "cursor", "kimi"]);
    const allIds = providers.flatMap((provider) => provider.models.map((model) => model.id));
    // Cursor 경유 Kimi와 Kimi 프로바이더는 다른 경로다 — 둘 다 노출한다.
    expect(allIds).toContain("cursor--kimi-k3-1m");
    expect(allIds).toContain("kimi--k3");
    const cursorKimi = providers[1]?.models.find((model) => model.id === "cursor--kimi-k3-1m");
    expect(cursorKimi?.maxMode).toBe(true);
    const fastIds = allIds.filter((id) => id.endsWith("-fast"));
    expect(fastIds.length).toBeGreaterThan(0);
  });

  it("PUT /plugins/terminal/settings updates enableMetaphor in global options", async () => {
    const harness = createRouteHarness({
      body: { enableMetaphor: true },
      data: { version: 1, enableMetaphor: false },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(200);
    expect(harness.writes[0]?.body).toMatchObject({ enableMetaphor: true, agentIdleDormantMinutes: 60 });
    expect(harness.currentData()).toEqual({ version: 1, enableMetaphor: true });
  });

  it("PUT /plugins/terminal/settings rejects non-boolean payloads", async () => {
    const harness = createRouteHarness({ body: { enableMetaphor: "yes" } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings rejects payloads with unknown extra keys", async () => {
    const harness = createRouteHarness({ body: { enableMetaphor: true, consolePortMode: "static" } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings rejects payloads with unknown keys", async () => {
    const harness = createRouteHarness({ body: { terminalRenderer: "webgl" } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings rejects the removed Codex launch mode key", async () => {
    const harness = createRouteHarness({ body: { codexLaunchMode: "app-server" } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings rejects payloads with multiple known keys", async () => {
    const harness = createRouteHarness({
      body: { enableMetaphor: true, agentIdleDormantMinutes: 60 },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings updates agentIdleDormantMinutes in global options", async () => {
    const harness = createRouteHarness({
      body: { agentIdleDormantMinutes: 120 },
      data: { version: 1 },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(200);
    expect(harness.writes[0]?.body).toMatchObject({ enableMetaphor: false, agentIdleDormantMinutes: 120 });
    expect(harness.currentData()).toEqual({ version: 1, agentIdleDormantMinutes: 120 });
  });

  it("PUT /plugins/terminal/settings accepts null agentIdleDormantMinutes to disable auto-dormant", async () => {
    const harness = createRouteHarness({
      body: { agentIdleDormantMinutes: null },
      data: { version: 1, agentIdleDormantMinutes: 60 },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(200);
    expect(harness.writes[0]?.body).toMatchObject({ enableMetaphor: false, agentIdleDormantMinutes: null });
    expect(harness.currentData()).toEqual({ version: 1, agentIdleDormantMinutes: null });
  });

  it("PUT /plugins/terminal/settings rejects invalid agentIdleDormantMinutes values", async () => {
    for (const body of [
      { agentIdleDormantMinutes: 0 },
      { agentIdleDormantMinutes: -1 },
      { agentIdleDormantMinutes: 1.5 },
      { agentIdleDormantMinutes: "60" },
      { agentIdleDormantMinutes: Number.POSITIVE_INFINITY },
    ]) {
      const harness = createRouteHarness({ body });
      await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
      expect(harness.writes.at(-1)?.status).toBe(400);
      expect(harness.updateCalls).toBe(0);
    }
  });

  it("GET /plugins/terminal/settings returns default agentIdleDormantMinutes when unset", async () => {
    const harness = createRouteHarness({ data: { version: 1 } });
    await harness.handle({ req: req("GET"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(200);
    expect(harness.writes[0]?.body).toMatchObject({ enableMetaphor: false, agentIdleDormantMinutes: 60 });
  });

  it("PUT /plugins/terminal/settings stores a catalog-valid aiGateway selection", async () => {
    const harness = createRouteHarness({
      body: {
        aiGateway: {
          models: [
            { id: "cursor--claude-opus-5" },
            { id: "kimi--k3-256k" },
          ],
          defaultModel: "cursor--claude-opus-5",
        },
      },
      data: { version: 1 },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(200);
    expect(harness.writes[0]?.body).toMatchObject({
      aiGateway: {
        models: [
          { id: "cursor--claude-opus-5" },
          { id: "kimi--k3-256k" },
        ],
        defaultModel: "cursor--claude-opus-5",
      },
    });
    // 콘솔 durable state의 플러그인 슬롯에 저장되고, Fleet 전역 옵션은 건드리지 않는다.
    expect(harness.currentAiGateway()).toEqual({
      version: 1,
      models: [
        { id: "cursor--claude-opus-5" },
        { id: "kimi--k3-256k" },
      ],
      defaultModel: "cursor--claude-opus-5",
    });
    expect(harness.currentData()).toEqual({ version: 1 });
  });

  it("PUT /plugins/terminal/settings normalizes gateway alias ids to scoped ids", async () => {
    const harness = createRouteHarness({
      body: { aiGateway: { models: [{ id: "cursor-auto" }] } },
      data: { version: 1 },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(200);
    expect(harness.currentAiGateway()).toEqual({
      version: 1,
      models: [{ id: "cursor--auto" }],
    });
  });

  it("PUT /plugins/terminal/settings clears the aiGateway selection with null", async () => {
    const harness = createRouteHarness({
      body: { aiGateway: null },
      aiGateway: { version: 1, models: [{ id: "cursor--auto" }] },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(200);
    expect(harness.writes[0]?.body).toMatchObject({ aiGateway: null });
    expect(harness.currentAiGateway()).toEqual({ version: 1 });
  });

  it("PUT /plugins/terminal/settings rejects catalog-invalid aiGateway payloads", async () => {
    for (const aiGateway of [
      { models: [{ id: "cursor--no-such-model" }] },
      // 모델별 effort는 폐기된 계약 — 잔존 필드는 거부한다.
      { models: [{ id: "cursor--claude-opus-5", effort: "max" }] },
      { models: [{ id: "cursor--claude-opus-5" }], defaultModel: "kimi--k3" },
      { models: [{ id: "cursor--claude-opus-5" }, { id: "cursor--claude-opus-5" }] },
      { models: "all" },
      { defaultModel: 7 },
      { extra: true },
      [],
      "reset",
    ]) {
      const harness = createRouteHarness({ body: { aiGateway } });
      await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
      expect(harness.writes.at(-1)?.status).toBe(400);
      expect(harness.updateCalls).toBe(0);
    }
  });

  it("PUT /plugins/terminal/settings enforces terminal-origin authorization", async () => {
    const harness = createRouteHarness({ terminalAuthorized: false, body: { enableMetaphor: true } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes).toEqual([{ status: 401, body: { error: "unauthorized" } }]);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings rejects non-JSON content types", async () => {
    const harness = createRouteHarness({ body: { enableMetaphor: true } });
    await harness.handle({ req: req("PUT", "text/plain"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(415);
    expect(harness.updateCalls).toBe(0);
  });
});

function createRouteHarness(options: HarnessOptions = {}) {
  const writes: WriteJsonCall[] = [];
  const routers = new Map<string, Parameters<FleetPluginServerContext["registerRouter"]>[1]>();
  let data = options.data ?? { version: 1 };
  let aiGateway: AiGatewayStoredSettings = options.aiGateway ?? { version: 1 };
  let updateCalls = 0;
  const ctx = {
    pluginId: "terminal",
    manifest: { id: "terminal" },
    basePath: "/plugins/terminal",
    wsBasePath: "/plugins/terminal/ws",
    registerRouter: (path: string, handler: Parameters<FleetPluginServerContext["registerRouter"]>[1]) => { routers.set(path, handler); },
    registerWsHandler: () => undefined,
    host: {
      http: {
        readJsonBody: async () => (options.bodyNull ? null : (options.body ?? {})),
        writeJson: (_res: http.ServerResponse, status: number, body: unknown) => { writes.push({ status, body }); },
      },
      security: {
        validateHost: () => true,
        isTerminalAuthorized: () => options.terminalAuthorized ?? true,
        isLockAuthorized: () => true,
      },
    },
  } as unknown as FleetPluginServerContext;
  registerTerminalSettingsRoutes(ctx, {
    globalOptionsService: {
      load: () => data,
      save: (next) => { data = next; return data; },
      update: (mutate) => { updateCalls += 1; data = mutate(data); return data; },
    },
    aiGatewayStore: {
      read: async () => aiGateway,
      write: async (value) => {
        updateCalls += 1;
        aiGateway = normalizeAiGatewaySettings({ version: 1, ...(value ?? {}) });
        return aiGateway;
      },
    },
  });
  const handle = routers.get("settings");
  if (!handle) throw new Error("settings router was not registered");
  return {
    handle,
    writes,
    currentData: () => data,
    currentAiGateway: () => aiGateway,
    get updateCalls() { return updateCalls; },
  };
}

function req(method: string, contentType?: string): http.IncomingMessage {
  return { method, headers: contentType ? { "content-type": contentType } : {} } as unknown as http.IncomingMessage;
}

function jsonReq(method: string): http.IncomingMessage {
  return req(method, "application/json");
}

function res(): http.ServerResponse {
  return {} as unknown as http.ServerResponse;
}
