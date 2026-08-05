import { describe, expect, it } from "vitest";

import {
  AI_GATEWAY_SETTINGS_STORAGE_KEY,
  createAiGatewaySettingsStore,
  normalizeAiGatewaySettings,
  parseAiGatewayUpdate,
  resolveAiGatewaySelection,
} from "../server/ai-gateway-settings.js";

describe("ai-gateway settings store", () => {
  it("normalizes malformed stored payloads to an unconfigured slot", () => {
    expect(normalizeAiGatewaySettings(undefined)).toEqual({ version: 1 });
    expect(normalizeAiGatewaySettings("everything")).toEqual({ version: 1 });
    expect(normalizeAiGatewaySettings({ version: 2, models: [{ id: "cursor--auto" }] })).toEqual({ version: 1 });
    expect(normalizeAiGatewaySettings({
      version: 1,
      models: [{ id: "" }, { id: 7 }, { id: "cursor--auto", effort: "max" }, "kimi--k3"],
      defaultModel: "",
      cursorDiagnosticsEnabled: true,
      wireLogEnabled: false,
    })).toEqual({
      version: 1,
      models: [{ id: "cursor--auto" }],
      cursorDiagnosticsEnabled: true,
      wireLogEnabled: false,
    });
    expect(normalizeAiGatewaySettings({
      version: 1,
      cursorDiagnosticsEnabled: false,
      wireLogEnabled: true,
    })).toEqual({ version: 1, wireLogEnabled: true });
    expect(normalizeAiGatewaySettings({
      version: 1,
      cursorDiagnosticsEnabled: false,
      wireLogEnabled: false,
    })).toEqual({ version: 1, wireLogEnabled: false });
    expect(normalizeAiGatewaySettings({
      version: 1,
      cursorDiagnosticsEnabled: false,
    })).toEqual({ version: 1 });
  });

  it("persists under the terminal plugin storage slot", async () => {
    const written: Record<string, unknown> = {};
    const store = createAiGatewaySettingsStore({
      readJson: async (_pluginId: string, key: string) => written[key],
      writeJson: async (_pluginId: string, key: string, value: unknown) => { written[key] = value; },
    } as never, "terminal");

    expect(await store.read()).toEqual({ version: 1 });
    await store.write({ models: [{ id: "cursor--claude-opus-5" }], defaultModel: "cursor--claude-opus-5" });
    expect(written[AI_GATEWAY_SETTINGS_STORAGE_KEY]).toEqual({
      version: 1,
      models: [{ id: "cursor--claude-opus-5" }],
      defaultModel: "cursor--claude-opus-5",
    });
    await store.writeCursorDiagnosticsEnabled(true);
    expect(await store.read()).toEqual({
      version: 1,
      models: [{ id: "cursor--claude-opus-5" }],
      defaultModel: "cursor--claude-opus-5",
      cursorDiagnosticsEnabled: true,
    });
    await store.write({ models: [{ id: "cursor--auto" }] });
    expect(await store.read()).toEqual({
      version: 1,
      models: [{ id: "cursor--auto" }],
      cursorDiagnosticsEnabled: true,
    });
    await store.write(undefined);
    expect(await store.read()).toEqual({
      version: 1,
      cursorDiagnosticsEnabled: true,
    });
    await store.writeCursorDiagnosticsEnabled(false);
    expect(await store.read()).toEqual({ version: 1 });

    await store.writeWireLogEnabled(false);
    expect(await store.read()).toEqual({ version: 1, wireLogEnabled: false });
    await store.write({ models: [{ id: "cursor--auto" }] });
    expect(await store.read()).toEqual({ version: 1, models: [{ id: "cursor--auto" }], wireLogEnabled: false });
    await store.writeCursorDiagnosticsEnabled(true);
    expect(await store.read()).toEqual({
      version: 1,
      models: [{ id: "cursor--auto" }],
      cursorDiagnosticsEnabled: true,
      wireLogEnabled: false,
    });
    await store.writeWireLogEnabled(undefined);
    expect(await store.read()).toEqual({
      version: 1,
      models: [{ id: "cursor--auto" }],
      cursorDiagnosticsEnabled: true,
    });
  });

  it("drops a stored effort the catalog no longer offers instead of echoing it back", () => {
    // 이 정규형이 설정 GET의 값이고 클라이언트는 무관한 편집에도 그대로 되돌려 보낸다.
    // 사다리 밖 단계를 남기면 검증기가 그 payload를 거부해, 카탈로그가 단계를 하나 빼는
    // 순간 그 모델을 지우기 전까지 AI Gateway 저장 전체가 400으로 잠긴다.
    expect(normalizeAiGatewaySettings({
      version: 1,
      models: [{ id: "kimi--k3-256k", efforts: ["xhigh"] }],
    })).toEqual({ version: 1, models: [{ id: "kimi--k3-256k" }] });
    expect(normalizeAiGatewaySettings({
      version: 1,
      models: [{ id: "kimi--k3-256k", efforts: ["max", "xhigh"] }],
    })).toEqual({ version: 1, models: [{ id: "kimi--k3-256k", efforts: ["max"] }] });
    // 정규화한 값은 검증기가 그대로 받아들여야 왕복이 닫힌다.
    expect(parseAiGatewayUpdate({ models: [{ id: "kimi--k3-256k", efforts: ["max"] }], defaultModel: "kimi--k3-256k" }).ok)
      .toBe(true);
  });

  it("keeps a narrowed effort selection and folds a whole-ladder one back to absent", () => {
    // 저장형이 하나여야 "전체 노출"이 두 가지 철자를 갖지 않는다.
    expect(parseAiGatewayUpdate({ models: [{ id: "kimi--k3", efforts: ["max", "low"] }] }))
      .toEqual({ ok: true, value: { models: [{ id: "kimi--k3", efforts: ["low", "max"] }] } });
    expect(parseAiGatewayUpdate({ models: [{ id: "kimi--k3", efforts: ["low", "high", "max"] }] }))
      .toEqual({ ok: true, value: { models: [{ id: "kimi--k3" }] } });
  });

  it("refuses an effort selection the model cannot be exposed at", () => {
    // kimi--k3의 사다리는 low/high/max다. 사다리 밖 단계를 받아두면 UI가 고를 수 없는
    // 상태가 저장되고, 정체성 0개인 빈 배열은 켜 둔 채 쓸 수 없는 모델을 만든다.
    expect(parseAiGatewayUpdate({ models: [{ id: "kimi--k3", efforts: ["xhigh"] }] })).toEqual({ ok: false });
    expect(parseAiGatewayUpdate({ models: [{ id: "kimi--k3", efforts: [] }] })).toEqual({ ok: false });
    expect(parseAiGatewayUpdate({ models: [{ id: "kimi--k3", efforts: ["max", "max"] }] })).toEqual({ ok: false });
    expect(parseAiGatewayUpdate({ models: [{ id: "kimi--k3", efforts: "max" }] })).toEqual({ ok: false });
    expect(parseAiGatewayUpdate({ models: [{ id: "kimi--k3", levels: ["max"] }] })).toEqual({ ok: false });
  });

  it("narrows the exposure map without touching the exposed model list", () => {
    const selection = resolveAiGatewaySelection({
      version: 1,
      models: [{ id: "kimi--k3", efforts: ["max"] }, { id: "cursor--auto" }],
    });
    // 좁히기는 정체성에만 적용된다 — 모델 자체는 그대로 노출되어야 /v1/models가 변하지 않는다.
    expect(selection.models.map((model) => model.id)).toEqual(["cursor--auto", "kimi--k3"]);
    expect(selection.effortExposure).toEqual({ "kimi--k3": ["max"] });
  });

  it("drops an exposure that stopped narrowing anything", () => {
    const whole = resolveAiGatewaySelection({
      version: 1,
      models: [{ id: "kimi--k3", efforts: ["low", "high", "max"] }],
    });
    const stale = resolveAiGatewaySelection({
      version: 1,
      models: [{ id: "kimi--k3", efforts: ["xhigh"] }],
    });
    expect(whole.effortExposure).toEqual({});
    expect(stale.effortExposure).toEqual({});
  });

  it("resolves stale ids out and keeps the default only when exposed", () => {
    const selection = resolveAiGatewaySelection({
      version: 1,
      models: [{ id: "cursor--claude-opus-5" }, { id: "cursor--retired-model" }],
      defaultModel: "cursor--retired-model",
    });
    expect(selection.models.map((model) => model.id)).toEqual(["cursor--claude-opus-5"]);
    expect(selection.defaultModel).toBeUndefined();
  });

  it("exposes enabled models in GATEWAY_PROVIDERS order, not Add-click order", () => {
    const selection = resolveAiGatewaySelection({
      version: 1,
      models: [
        { id: "cursor--grok-4.5-fast" },
        { id: "codex--gpt-5.6-sol-fast" },
        { id: "kimi--k3" },
        { id: "codex--gpt-5.6-luna-fast" },
      ],
      defaultModel: "cursor--grok-4.5-fast",
    });
    expect(selection.models.map((model) => model.id)).toEqual([
      "codex--gpt-5.6-sol-fast",
      "codex--gpt-5.6-luna-fast",
      "cursor--grok-4.5-fast",
      "kimi--k3",
    ]);
    expect(selection.defaultModel?.id).toBe("cursor--grok-4.5-fast");
  });
});
