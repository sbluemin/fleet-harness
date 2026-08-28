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
      aiGateway: null,
      cursorDiagnosticsEnabled: false,
      wireLogEnabled: false,
      compactCeiling: null,
    });
    expect(harness.writes[0]?.body).not.toHaveProperty("consolePortMode");
  });

  it("GET /plugins/terminal/settings ships the gateway catalog with Cursor Max Mode routes", async () => {
    const harness = createRouteHarness({ data: { version: 1 } });
    await harness.handle({ req: req("GET"), res: res(), pathname: "/plugins/terminal/settings" });
    const body = harness.writes[0]?.body as {
      readonly aiGatewayCatalog: { readonly providers: readonly { readonly id: string; readonly models: readonly { readonly id: string; readonly maxMode: boolean; readonly fast: boolean; readonly capabilityClass: string | null; readonly effort: unknown }[] }[] };
    };
    const providers = body.aiGatewayCatalog.providers;
    expect(providers.map((provider) => provider.id)).toEqual(["codex", "xai", "cursor", "opencode", "antigravity", "kimi"]);
    const allIds = providers.flatMap((provider) => provider.models.map((model) => model.id));
    // Cursor 경유 Opus/Fable Max Mode와 Kimi 프로바이더는 다른 경로다 — 둘 다 노출한다.
    expect(allIds).toContain("kimi--k3");
    // Antigravity는 Gemini만 노출한다. 같은 구독이 Claude·GPT-OSS도 서비스하지만
    // 카탈로그에 없으므로 설정 화면에도 뜨지 않아야 한다.
    expect(allIds).toContain("antigravity--gemini-3.7-flash");
    expect(allIds).toContain("antigravity--gemini-3.1-pro");
    expect(allIds.filter((id) => id.startsWith("antigravity--"))).toHaveLength(2);
    expect(allIds).toContain("xai--grok-4.6");
    expect(allIds).toContain("xai--grok-composer-2.5-fast");
    for (const id of [
      "cursor--auto",
      "cursor--composer-2.5",
      "cursor--composer-2.5-fast",
      "cursor--grok-4.5",
      "cursor--grok-4.5-fast",
      "cursor--claude-opus-5",
      "cursor--claude-fable-5",
    ]) {
      expect(allIds).toContain(id);
    }
    expect(allIds).not.toContain("cursor--kimi-k3-1m");
    const cursorModels = providers.find((provider) => provider.id === "cursor")?.models;
    for (const id of ["cursor--claude-opus-5-1m", "cursor--claude-fable-5-1m"]) {
      expect(allIds).toContain(id);
      expect(cursorModels?.find((model) => model.id === id)?.maxMode).toBe(true);
    }
    expect(cursorModels?.find((model) => model.id === "cursor--claude-opus-5")?.maxMode).toBe(false);
    const fastIds = allIds.filter((id) => id.endsWith("-fast"));
    expect(fastIds.length).toBeGreaterThan(0);
    // 등급은 이 응답으로만 브라우저에 닿는다 — 투영에서 잘리면 로스터 배지가 사라진다.
    expect(providers[0]?.models.find((model) => model.id === "codex--gpt-5.6-sol")?.capabilityClass).toBe("flagship");
    expect(providers.find((provider) => provider.id === "cursor")?.models.find((model) => model.id === "cursor--auto")?.capabilityClass).toBeNull();
  });

  it("PUT /plugins/terminal/settings updates the agent idle dormant threshold in global options", async () => {
    const harness = createRouteHarness({
      body: { agentIdleDormantMinutes: 30 },
      data: { version: 1 },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(200);
    expect(harness.writes[0]?.body).toMatchObject({ agentIdleDormantMinutes: 30 });
    expect(harness.currentData()).toEqual({ version: 1, agentIdleDormantMinutes: 30 });
  });

  it("PUT /plugins/terminal/settings stores the Claude Code system prompt switch", async () => {
    const harness = createRouteHarness({
      body: { claudeCodeSystemPrompt: "off" },
      data: { version: 1 },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(200);
    expect(harness.writes[0]?.body).toMatchObject({ claudeCodeSystemPrompt: "off" });
    expect(harness.currentData()).toEqual({ version: 1, claudeCodeSystemPrompt: "off" });
  });

  it("PUT /plugins/terminal/settings rejects a system prompt value outside the two modes", async () => {
    const harness = createRouteHarness({ body: { claudeCodeSystemPrompt: "append" }, data: { version: 1 } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings rejects non-boolean payloads", async () => {
    const harness = createRouteHarness({ body: { cursorDiagnosticsEnabled: "yes" } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings rejects payloads with unknown extra keys", async () => {
    const harness = createRouteHarness({ body: { cursorDiagnosticsEnabled: true, consolePortMode: "static" } });
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
      body: { agentIdleDormantMinutes: 60, cursorDiagnosticsEnabled: true },
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
    expect(harness.writes[0]?.body).toMatchObject({ agentIdleDormantMinutes: 120 });
    expect(harness.currentData()).toEqual({ version: 1, agentIdleDormantMinutes: 120 });
  });

  it("PUT /plugins/terminal/settings accepts null agentIdleDormantMinutes to disable auto-dormant", async () => {
    const harness = createRouteHarness({
      body: { agentIdleDormantMinutes: null },
      data: { version: 1, agentIdleDormantMinutes: 60 },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(200);
    expect(harness.writes[0]?.body).toMatchObject({ agentIdleDormantMinutes: null });
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
    expect(harness.writes[0]?.body).toMatchObject({ agentIdleDormantMinutes: 60 });
  });

  it("GET /plugins/terminal/settings returns a stored providerPriority", async () => {
    const harness = createRouteHarness({
      aiGateway: { version: 1, providerPriority: ["codex", "cursor"] },
    });
    await harness.handle({ req: req("GET"), res: res(), pathname: "/plugins/terminal/settings" });

    expect(harness.writes[0]).toMatchObject({
      status: 200,
      body: { aiGateway: { providerPriority: ["codex", "cursor"] } },
    });
  });

  it("PUT /plugins/terminal/settings persists compactCeiling independently of models", async () => {
    const harness = createRouteHarness({
      body: { compactCeiling: "early" },
      aiGateway: { version: 1, models: [{ id: "kimi--k3" }] },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]).toMatchObject({
      status: 200,
      body: { compactCeiling: "early", aiGateway: { models: [{ id: "kimi--k3" }] } },
    });
    expect(harness.currentAiGateway()).toEqual({
      version: 1,
      models: [{ id: "kimi--k3" }],
      compactCeiling: "early",
    });
  });

  it("PUT /plugins/terminal/settings clears compactCeiling with null", async () => {
    const harness = createRouteHarness({
      body: { compactCeiling: null },
      aiGateway: { version: 1, compactCeiling: 94 },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]).toMatchObject({
      status: 200,
      body: { compactCeiling: null },
    });
    expect(harness.currentAiGateway()).toEqual({ version: 1 });
  });

  it("PUT /plugins/terminal/settings rejects an out-of-range compactCeiling", async () => {
    const harness = createRouteHarness({ body: { compactCeiling: 69 } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings stores a catalog-valid aiGateway selection", async () => {
    const harness = createRouteHarness({
      body: {
        aiGateway: {
          models: [
            { id: "cursor--grok-4.5" },
            { id: "kimi--k3-256k" },
          ],
        },
      },
      data: { version: 1 },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(200);
    expect(harness.writes[0]?.body).toMatchObject({
      aiGateway: {
        models: [
          { id: "cursor--grok-4.5" },
          { id: "kimi--k3-256k" },
        ],
      },
    });
    // 콘솔 durable state의 플러그인 슬롯에 저장되고, Fleet 전역 옵션은 건드리지 않는다.
    expect(harness.currentAiGateway()).toEqual({
      version: 1,
      models: [
        { id: "cursor--grok-4.5" },
        { id: "kimi--k3-256k" },
      ],
    });
    expect(harness.currentData()).toEqual({ version: 1 });
  });

  it("PUT /plugins/terminal/settings accepts hostOnly:true and GET echoes it", async () => {
    const harness = createRouteHarness({
      body: {
        aiGateway: {
          models: [{ id: "cursor--auto", hostOnly: true }],
        },
      },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(200);
    expect(harness.writes[0]?.body).toMatchObject({
      aiGateway: {
        models: [{ id: "cursor--auto", hostOnly: true }],
      },
    });
    expect(harness.currentAiGateway()).toEqual({
      version: 1,
      models: [{ id: "cursor--auto", hostOnly: true }],
    });

    await harness.handle({ req: req("GET"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[1]?.status).toBe(200);
    expect(harness.writes[1]?.body).toMatchObject({
      aiGateway: {
        models: [{ id: "cursor--auto", hostOnly: true }],
      },
    });
  });

  it("PUT /plugins/terminal/settings accepts hostOnly:false and stores without the key", async () => {
    const harness = createRouteHarness({
      body: {
        aiGateway: {
          models: [{ id: "cursor--auto", hostOnly: false }],
        },
      },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(200);
    expect(harness.writes[0]?.body).toMatchObject({
      aiGateway: {
        models: [{ id: "cursor--auto" }],
      },
    });
    expect(harness.currentAiGateway()).toEqual({
      version: 1,
      models: [{ id: "cursor--auto" }],
    });
    expect(harness.currentAiGateway().models?.[0]).not.toHaveProperty("hostOnly");
  });

  it("PUT /plugins/terminal/settings rejects a non-boolean hostOnly", async () => {
    const harness = createRouteHarness({
      body: {
        aiGateway: {
          models: [{ id: "cursor--auto", hostOnly: "yes" }],
        },
      },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings preserves hostOnly when editing efforts", async () => {
    const harness = createRouteHarness({
      body: {
        aiGateway: {
          models: [
            { id: "cursor--auto", hostOnly: true },
            { id: "cursor--grok-4.5", efforts: ["high"] },
          ],
        },
      },
      aiGateway: {
        version: 1,
        models: [
          { id: "cursor--auto", hostOnly: true },
          { id: "cursor--grok-4.5", efforts: ["high"] },
        ],
      },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(200);
    expect(harness.writes[0]?.body).toMatchObject({
      aiGateway: {
        models: [
          { id: "cursor--auto", hostOnly: true },
          { id: "cursor--grok-4.5" },
        ],
      },
    });
    expect(harness.currentAiGateway()).toEqual({
      version: 1,
      models: [
        { id: "cursor--auto", hostOnly: true },
        { id: "cursor--grok-4.5", efforts: ["high"] },
      ],
    });
  });

  it("PUT /plugins/terminal/settings persists and echoes providerPriority", async () => {
    const harness = createRouteHarness({
      body: {
        aiGateway: {
          models: [{ id: "cursor--auto" }],
          providerPriority: ["opencode"],
        },
      },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });

    expect(harness.writes[0]).toMatchObject({
      status: 200,
      body: {
        aiGateway: {
          models: [{ id: "cursor--auto" }],
          providerPriority: ["opencode"],
        },
      },
    });
    expect(harness.currentAiGateway()).toEqual({
      version: 1,
      models: [{ id: "cursor--auto" }],
      providerPriority: ["opencode"],
    });
  });

  it("PUT /plugins/terminal/settings preserves providerPriority when the key is absent", async () => {
    const harness = createRouteHarness({
      body: { aiGateway: { models: [{ id: "kimi--k3" }] } },
      aiGateway: { version: 1, providerPriority: ["codex"] },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });

    expect(harness.currentAiGateway()).toEqual({
      version: 1,
      models: [{ id: "kimi--k3" }],
      providerPriority: ["codex"],
    });
    expect(harness.writes[0]?.body).toMatchObject({
      aiGateway: {
        models: [{ id: "kimi--k3" }],
        providerPriority: ["codex"],
      },
    });
  });

  it("PUT /plugins/terminal/settings explicitly clears providerPriority and replaces models", async () => {
    const harness = createRouteHarness({
      body: { aiGateway: { providerPriority: [] } },
      aiGateway: {
        version: 1,
        models: [{ id: "cursor--auto" }],
        providerPriority: ["codex"],
      },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });

    expect(harness.writes[0]).toMatchObject({ status: 200, body: { aiGateway: null } });
    expect(harness.currentAiGateway()).toEqual({ version: 1 });
  });

  it("PUT /plugins/terminal/settings rejects an invalid providerPriority", async () => {
    const harness = createRouteHarness({
      body: { aiGateway: { providerPriority: ["unknown"] } },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });

    expect(harness.writes).toEqual([{ status: 400, body: { error: "invalid_terminal_settings" } }]);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings toggles Cursor diagnostics without changing models", async () => {
    const harness = createRouteHarness({
      body: { cursorDiagnosticsEnabled: true },
      aiGateway: {
        version: 1,
        models: [{ id: "cursor--grok-4.5" }],
      },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });

    expect(harness.writes[0]).toMatchObject({
      status: 200,
      body: {
        cursorDiagnosticsEnabled: true,
        aiGateway: {
          models: [{ id: "cursor--grok-4.5" }],
        },
      },
    });
    expect(harness.currentAiGateway()).toEqual({
      version: 1,
      models: [{ id: "cursor--grok-4.5" }],
      cursorDiagnosticsEnabled: true,
    });
  });

  it("PUT /plugins/terminal/settings preserves Cursor diagnostics while changing models", async () => {
    const harness = createRouteHarness({
      body: { aiGateway: { models: [{ id: "cursor--auto" }] } },
      aiGateway: { version: 1, cursorDiagnosticsEnabled: true },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });

    expect(harness.currentAiGateway()).toEqual({
      version: 1,
      models: [{ id: "cursor--auto" }],
      cursorDiagnosticsEnabled: true,
    });
  });

  it("GET /plugins/terminal/settings returns the effective wire log runtime state", async () => {
    const harness = createRouteHarness({ wireLogEnabled: true });
    await harness.handle({ req: req("GET"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.body).toMatchObject({ wireLogEnabled: true });
  });

  it.each([true, false])("PUT /plugins/terminal/settings accepts wireLogEnabled=%s and persists it", async (enabled) => {
    const harness = createRouteHarness({ body: { wireLogEnabled: enabled } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(200);
    expect(harness.currentAiGateway()).toMatchObject({ version: 1, wireLogEnabled: enabled });
    expect(harness.applied).toEqual([enabled]);
  });

  it("PUT /plugins/terminal/settings rejects non-boolean wire log values", async () => {
    const harness = createRouteHarness({ body: { wireLogEnabled: "yes" } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings rolls durable wire log state back when apply fails", async () => {
    const harness = createRouteHarness({
      body: { wireLogEnabled: true },
      aiGateway: { version: 1, models: [{ id: "cursor--auto" }], wireLogEnabled: false },
      applyError: true,
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]).toEqual({ status: 500, body: { error: "wire_log_runtime_apply_failed" } });
    expect(harness.currentAiGateway()).toEqual({ version: 1, models: [{ id: "cursor--auto" }], wireLogEnabled: false });
    expect(harness.applied).toEqual([true]);
  });

  it("PUT /plugins/terminal/settings rejects non-boolean Cursor diagnostics values", async () => {
    const harness = createRouteHarness({ body: { cursorDiagnosticsEnabled: "yes" } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
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
      { models: [{ id: "cursor--grok-4.5", effort: "max" }] },
      { models: [{ id: "cursor--grok-4.5" }, { id: "cursor--grok-4.5" }] },
      { models: "all" },
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
    const harness = createRouteHarness({ terminalAuthorized: false, body: { cursorDiagnosticsEnabled: true } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes).toEqual([{ status: 401, body: { error: "unauthorized" } }]);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings rejects non-JSON content types", async () => {
    const harness = createRouteHarness({ body: { cursorDiagnosticsEnabled: true } });
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
