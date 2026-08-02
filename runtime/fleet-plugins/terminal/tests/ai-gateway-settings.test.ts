import { describe, expect, it } from "vitest";

import {
  AI_GATEWAY_SETTINGS_STORAGE_KEY,
  createAiGatewaySettingsStore,
  normalizeAiGatewaySettings,
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
    })).toEqual({
      version: 1,
      models: [{ id: "cursor--auto" }],
    });
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
    expect(await store.read()).toEqual({
      version: 1,
      models: [{ id: "cursor--claude-opus-5" }],
      defaultModel: "cursor--claude-opus-5",
    });
    await store.write(undefined);
    expect(await store.read()).toEqual({ version: 1 });
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
});
