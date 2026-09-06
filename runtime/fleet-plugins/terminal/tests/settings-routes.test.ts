import type http from "node:http";

import type { GlobalOptionsData } from "@dotobokuri/core-infra";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { describe, expect, it } from "vitest";

import { normalizeAiGatewaySettings, type AiGatewayStoredSettings } from "@dotobokuri/core-ai-gateway";
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
  readonly wireLogEnabled?: boolean;
  readonly applyError?: boolean;
}

describe("terminal settings routes", () => {
  it("GET /plugins/terminal/settings returns terminal settings", async () => {
    const harness = createRouteHarness({
      data: { version: 1 },
    });
    await harness.handle({ req: req("GET"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(200);
    expect(harness.writes[0]?.body).toMatchObject({
      agentIdleDormantMinutes: 60,
      // 키가 없는 설정 파일은 플래그 없는 런치와 같은 뜻이다 — Claude Code 프롬프트가 켜진 세션.
      claudeCodeSystemPrompt: "on",
      // 승인 게이트는 그 반대다 — 저장된 적 없는 상태가 건너뛰기 동의를 대신할 수 없다.
      claudeCodeSkipPermissions: false,
      aiGateway: null,
      cursorDiagnosticsEnabled: false,
      wireLogEnabled: false,
      compactCeiling: null,
    });
    expect(harness.writes[0]?.body).not.toHaveProperty("consolePortMode");
  });

  it("PUT /plugins/terminal/settings stores the Claude Code permission opt-in", async () => {
    const harness = createRouteHarness({
      body: { claudeCodeSkipPermissions: true },
      data: { version: 1 },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(200);
    expect(harness.writes[0]?.body).toMatchObject({ claudeCodeSkipPermissions: true });
    expect(harness.currentData()).toEqual({ version: 1, claudeCodeSkipPermissions: true });
  });

  it("PUT /plugins/terminal/settings rejects payloads with unknown extra keys", async () => {
    const harness = createRouteHarness({ body: { cursorDiagnosticsEnabled: true, consolePortMode: "static" } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings enforces terminal-origin authorization", async () => {
    const harness = createRouteHarness({ terminalAuthorized: false, body: { cursorDiagnosticsEnabled: true } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes).toEqual([{ status: 401, body: { error: "unauthorized" } }]);
    expect(harness.updateCalls).toBe(0);
  });
});

function createRouteHarness(options: HarnessOptions = {}) {
  const writes: WriteJsonCall[] = [];
  const routers = new Map<string, Parameters<FleetPluginServerContext["registerRouter"]>[1]>();
  let data = options.data ?? { version: 1 };
  let aiGateway: AiGatewayStoredSettings = options.aiGateway ?? { version: 1 };
  let updateCalls = 0;
  const applied: boolean[] = [];
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
        resolveTerminalSocketRole: () => "control" as const,
        isWriteAdmitted: () => true,
        expectedOrigin: () => "http://127.0.0.1:1",
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
      path: "/test/ai-gateway.json",
      read: () => aiGateway,
      // 실 store(core-ai-gateway settings-store)의 write와 같은 보존 규칙을 지킨다.
      // 여기서 wireLogEnabled를 빠뜨리면 모델만 바꾼 PUT이 로깅을 끈 것처럼 보이고,
      // 하네스는 프로덕션에 없는 동작을 상대로 green이 된다.
      write: (value) => {
        updateCalls += 1;
        aiGateway = normalizeAiGatewaySettings({
          version: 1,
          ...(aiGateway.cursorDiagnosticsEnabled === true
            ? { cursorDiagnosticsEnabled: true }
            : {}),
          ...(typeof aiGateway.wireLogEnabled === "boolean"
            ? { wireLogEnabled: aiGateway.wireLogEnabled }
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
          ...(value ?? {}),
        });
        return aiGateway;
      },
      writeCursorDiagnosticsEnabled: (enabled) => {
        updateCalls += 1;
        aiGateway = normalizeAiGatewaySettings({
          ...aiGateway,
          cursorDiagnosticsEnabled: enabled,
        });
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
  const handle = routers.get("settings");
  if (!handle) throw new Error("settings router was not registered");
  return {
    handle,
    writes,
    currentData: () => data,
    currentAiGateway: () => aiGateway,
    applied,
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
