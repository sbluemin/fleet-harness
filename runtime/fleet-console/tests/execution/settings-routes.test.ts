import type http from "node:http";

import { sanitizeAgentOptionsData, type AgentOptionsData } from "@fleet-console/infra";
import type { ConsoleRuntimeContext } from "../../features/execution/host/context.js";
import { describe, expect, it } from "vitest";

import { normalizeAiGatewaySettings, type AiGatewayStoredSettings } from "@fleet-console/ai-gateway";
import { registerTerminalSettingsRoutes } from "../../features/settings/host/execution-settings-routes.js";
import { createTheaterSystemPromptService } from "../../features/settings/host/agent-options.js";

interface WriteJsonCall {
  readonly status: number;
  readonly body: unknown;
}

interface HarnessOptions {
  readonly terminalAuthorized?: boolean;
  readonly body?: unknown;
  readonly bodyNull?: boolean;
  readonly data?: AgentOptionsData;
  readonly aiGateway?: AiGatewayStoredSettings;
  readonly wireLogEnabled?: boolean;
  readonly applyError?: boolean;
}

describe("terminal settings routes", () => {
  it("GET /api/v1/agent/settings returns terminal settings", async () => {
    const harness = createRouteHarness({
      data: {},
    });
    await harness.handle({ req: req("GET"), res: res(), pathname: "/api/v1/agent/settings" });
    expect(harness.writes[0]?.status).toBe(200);
    expect(harness.writes[0]?.body).toMatchObject({
      agentIdleDormantMinutes: 60,
      aiGateway: null,
      wireLogEnabled: false,
      delegationRoutingEnabled: false,
      delegationRoutingMode: "model",
      compactCeiling: null,
    });
    expect(harness.writes[0]?.body).not.toHaveProperty("consolePortMode");
  });

  it("keeps Theater prompts scoped, validates writes, and clears the pair together", async () => {
    const theaterUrl = "/api/v1/agent/theater-system-prompt?theaterId=theater-1";
    const harness = createRouteHarness({ body: { prompt: { mode: "append", body: "  My rules\r\n" } }, data: { agentIdleDormantMinutes: 30 } });
    await harness.handleTheaterPrompt({ req: req("PUT", "application/json", theaterUrl), res: res(), pathname: theaterUrl });
    expect(harness.writes.pop()).toEqual({ status: 200, body: { theaterId: "theater-1", prompt: { mode: "append", body: "  My rules\n" } } });
    expect(harness.currentData()).toEqual({ agentIdleDormantMinutes: 30, claudeCodeTheaterSystemPrompts: { "theater-1": { mode: "append", body: "  My rules\n" } } });
    await harness.handleTheaterPrompt({ req: req("GET", undefined, theaterUrl), res: res(), pathname: theaterUrl });
    expect(harness.writes.pop()?.body).toMatchObject({ prompt: { mode: "append" } });
    const cleared = createRouteHarness({ body: { prompt: null }, data: harness.currentData() });
    await cleared.handleTheaterPrompt({ req: req("PUT", "application/json", theaterUrl), res: res(), pathname: theaterUrl });
    expect(cleared.writes.pop()?.body).toEqual({ theaterId: "theater-1", prompt: null });
    expect(cleared.currentData()).toEqual({ agentIdleDormantMinutes: 30 });
    expect(cleared.theaterSystemPrompts.save("theater-1", { mode: "on", body: "" })).toBeNull();
    expect(cleared.theaterSystemPrompts.save("theater-1", { mode: "on", body: "saved for later" })).toEqual({ mode: "on", body: "saved for later" });
    // 서브에이전트는 Theater마다 켜 둘 수 있고(기본은 대체), 잊힌 Theater를 지울 때 프롬프트와 함께 사라진다.
    const subagentsUrl = "/api/v1/agent/theater-subagents?theaterId=theater-1";
    const kept = createRouteHarness({ body: { subagentsKept: true }, data: harness.currentData() });
    await kept.handleTheaterSubagents({ req: req("PUT", "application/json", subagentsUrl), res: res(), pathname: subagentsUrl });
    expect(kept.writes.pop()?.body).toEqual({ theaterId: "theater-1", subagentsKept: true });
    expect(kept.theaterSystemPrompts.subagentsKept("theater-1")).toBe(true);
    kept.theaterSystemPrompts.purge("theater-1");
    expect(kept.currentData()).toEqual({ agentIdleDormantMinutes: 30 });

    const unknown = createRouteHarness({ body: { prompt: { mode: "off", body: "secret" } } });
    await unknown.handleTheaterPrompt({ req: req("PUT", "application/json", "/api/v1/agent/theater-system-prompt?theaterId=unknown"), res: res(), pathname: "" });
    expect(unknown.writes.pop()?.status).toBe(404);
    const denied = createRouteHarness({ terminalAuthorized: false, body: { prompt: null } });
    await denied.handleTheaterPrompt({ req: req("PUT", "application/json", theaterUrl), res: res(), pathname: theaterUrl });
    expect(denied.writes.pop()?.status).toBe(401);
    const invalid = createRouteHarness({ body: { prompt: { mode: "off", body: "x".repeat(16_001) } } });
    await invalid.handleTheaterPrompt({ req: req("PUT", "application/json", theaterUrl), res: res(), pathname: theaterUrl });
    expect(invalid.writes.pop()?.status).toBe(400);
    expect(invalid.updateCalls).toBe(0);
  });

  it("drops retired global prompt and subagent keys without migrating them into Theater settings", () => {
    expect(sanitizeAgentOptionsData({
      claudeCodeSystemPrompt: "off", claudeCodeCustomSystemPrompt: "old instructions",
      agentIdleDormantMinutes: 30, claudeCodeDisabledAgents: ["Explore"],
    })).toEqual({ data: { agentIdleDormantMinutes: 30 }, changed: true });
  });

  it("GET /api/v1/agent/settings resolves stored Jev routing mode", async () => {
    const harness = createRouteHarness({
      aiGateway: { version: 1, delegationRoutingMode: "jev" },
    });
    await harness.handle({ req: req("GET"), res: res(), pathname: "/api/v1/agent/settings" });
    expect(harness.writes[0]?.body).toMatchObject({
      delegationRoutingMode: "jev",
    });
  });

  it("PUT /api/v1/agent/settings stores delegation routing mode independently", async () => {
    const harness = createRouteHarness({
      body: { delegationRoutingMode: "jev" },
      aiGateway: { version: 1, models: [{ id: "codex--gpt-6-sol" }] },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/agent/settings" });
    expect(harness.writes[0]?.status).toBe(200);
    expect(harness.writes[0]?.body).toMatchObject({ delegationRoutingMode: "jev" });
    expect(harness.currentAiGateway()).toEqual({
      version: 1,
      models: [{ id: "codex--gpt-6-sol" }],
      delegationRoutingMode: "jev",
    });

    const cleared = createRouteHarness({
      body: { delegationRoutingMode: "model" },
      aiGateway: harness.currentAiGateway(),
    });
    await cleared.handle({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/agent/settings" });
    expect(cleared.writes[0]?.body).toMatchObject({ delegationRoutingMode: "model" });
    expect(cleared.currentAiGateway()).toEqual({
      version: 1,
      delegationRoutingMode: "model",
      models: [{ id: "codex--gpt-6-sol" }],
    });
  });

  it("PUT /api/v1/agent/settings rejects payloads with unknown extra keys", async () => {
    const harness = createRouteHarness({ body: { wireLogEnabled: true, consolePortMode: "static" } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/agent/settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /api/v1/agent/settings enforces terminal-origin authorization", async () => {
    const harness = createRouteHarness({ terminalAuthorized: false, body: { wireLogEnabled: true } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/agent/settings" });
    expect(harness.writes).toEqual([{ status: 401, body: { error: "unauthorized" } }]);
    expect(harness.updateCalls).toBe(0);
  });
});

function createRouteHarness(options: HarnessOptions = {}) {
  const writes: WriteJsonCall[] = [];
  const routers = new Map<string, Parameters<ConsoleRuntimeContext["registerRouter"]>[1]>();
  let data: AgentOptionsData = options.data ?? {};
  let aiGateway: AiGatewayStoredSettings = options.aiGateway ?? { version: 1 };
  let updateCalls = 0;
  const applied: boolean[] = [];
  const ctx = {
    dataDir: "/unused",
    legacyDataDir: "/unused",
    basePath: "/api/v1",
    wsBasePath: "/api/v1/terminal/ws",
    registerRouter: (path: string, handler: Parameters<ConsoleRuntimeContext["registerRouter"]>[1]) => { routers.set(path, handler); },
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
        resolveTerminalSocketRole: () => "control" as const,
        isWriteAdmitted: () => true,
        expectedOrigin: () => "http://127.0.0.1:1",
      },
    },
  } as unknown as ConsoleRuntimeContext;
  const agentOptionsService = {
    load: () => data,
    update: (mutate: (current: AgentOptionsData) => AgentOptionsData) => { updateCalls += 1; data = mutate(data); return data; },
  };
  const isRegisteredTheater = (id: string) => id === "theater-1";
  const theaterSystemPrompts = createTheaterSystemPromptService(agentOptionsService, isRegisteredTheater);
  registerTerminalSettingsRoutes(ctx, {
    agentOptionsService,
    theaterSystemPrompts,
    aiGatewayStore: {
      path: "/test/ai-gateway.json",
      read: () => aiGateway,
      // 실 store(core-ai-gateway settings-store)의 write와 같은 보존 규칙을 지킨다.
      // 여기서 wireLogEnabled를 빠뜨리면 모델만 바꾼 PUT이 로깅을 끈 것처럼 보이고,
      // 하네스는 프로덕션에 없는 동작을 상대로 green이 된다.
      write: (value) => {
        updateCalls += 1;
        aiGateway = normalizeAiGatewaySettings({
          version: 1,
          ...(typeof aiGateway.wireLogEnabled === "boolean"
            ? { wireLogEnabled: aiGateway.wireLogEnabled }
            : {}),
          ...(aiGateway.delegationRoutingEnabled === true
            ? { delegationRoutingEnabled: true }
            : {}),
          ...(aiGateway.providerPriority
            ? { providerPriority: aiGateway.providerPriority }
            : {}),
          ...(aiGateway.compactCeiling !== undefined
            ? { compactCeiling: aiGateway.compactCeiling }
            : {}),
          ...(aiGateway.xaiEndpoint !== undefined
            ? { xaiEndpoint: aiGateway.xaiEndpoint }
            : {}),
          ...(aiGateway.delegationRoutingMode === "jev"
            ? { delegationRoutingMode: "jev" }
            : {}),
          models: [],
          ...(value ?? {}),
        });
        return aiGateway;
      },
      seedModels: () => false,
      writeDelegationRoutingEnabled: (enabled) => {
        updateCalls += 1;
        aiGateway = normalizeAiGatewaySettings({
          ...aiGateway,
          delegationRoutingEnabled: enabled,
        });
        return aiGateway;
      },
      writeDelegationRoutingModel: (model) => {
        updateCalls += 1;
        aiGateway = normalizeAiGatewaySettings({ ...aiGateway, delegationRoutingModel: model });
        return aiGateway;
      },
      writeDelegationRoutingMode: (mode) => {
        updateCalls += 1;
        aiGateway = normalizeAiGatewaySettings({ ...aiGateway, delegationRoutingMode: mode });
        return aiGateway;
      },
      writeCursorDiagnosticsEnabled: (enabled) => {
        updateCalls += 1;
        aiGateway = normalizeAiGatewaySettings({ ...aiGateway, cursorDiagnosticsEnabled: enabled });
        return aiGateway;
      },
      writeWireLogEnabled: (enabled) => {
        updateCalls += 1;
        aiGateway = normalizeAiGatewaySettings({
          ...aiGateway,
          ...(enabled === undefined ? {} : { wireLogEnabled: enabled }),
        });
        if (enabled === undefined) {
          const withoutWireLog = { ...aiGateway } as { wireLogEnabled?: boolean };
          delete withoutWireLog.wireLogEnabled;
          aiGateway = withoutWireLog as AiGatewayStoredSettings;
        }
        return aiGateway;
      },
      writeCompactCeiling: (ceiling) => {
        updateCalls += 1;
        aiGateway = normalizeAiGatewaySettings({
          ...aiGateway,
          ...(ceiling === undefined ? {} : { compactCeiling: ceiling }),
        });
        if (ceiling === undefined) {
          const without = { ...aiGateway } as { compactCeiling?: unknown };
          delete without.compactCeiling;
          aiGateway = without as AiGatewayStoredSettings;
        }
        return aiGateway;
      },
      writeXaiEndpoint: (endpoint) => {
        updateCalls += 1;
        aiGateway = normalizeAiGatewaySettings({
          ...aiGateway,
          ...(endpoint === undefined ? {} : { xaiEndpoint: endpoint }),
        });
        if (endpoint === undefined) {
          const without = { ...aiGateway } as { xaiEndpoint?: unknown };
          delete without.xaiEndpoint;
          aiGateway = without as AiGatewayStoredSettings;
        }
        return aiGateway;
      },
    },
    wireLogRuntime: {
      enabled: () => options.wireLogEnabled ?? aiGateway.wireLogEnabled === true,
      apply: (enabled) => {
        if (enabled !== undefined) applied.push(enabled);
        if (options.applyError) throw new Error("apply failed");
      },
    },
  });
  const handle = routers.get("agent/settings");
  if (!handle) throw new Error("settings router was not registered");
  return {
    handle,
    handleTheaterPrompt: routers.get("agent/theater-system-prompt")!,
    handleTheaterSubagents: routers.get("agent/theater-subagents")!,
    theaterSystemPrompts,
    writes,
    currentData: () => data,
    currentAiGateway: () => aiGateway,
    applied,
    get updateCalls() { return updateCalls; },
  };
}

function req(method: string, contentType?: string, url?: string): http.IncomingMessage {
  return { method, url, headers: contentType ? { "content-type": contentType } : {} } as unknown as http.IncomingMessage;
}

function jsonReq(method: string): http.IncomingMessage {
  return req(method, "application/json");
}

function res(): http.ServerResponse {
  return {} as unknown as http.ServerResponse;
}
