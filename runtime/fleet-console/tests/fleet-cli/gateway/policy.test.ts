import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAiGatewaySettingsStore, type AiGatewaySettingsStore } from "@dotobokuri/core-ai-gateway";
import { afterEach, describe, expect, it } from "vitest";

import {
  GATEWAY_SET_KEYS,
  applyGatewaySetting,
  buildCompactCeilingChoices,
  resolveCompactCeilingChoice,
  describeGatewayPolicy,
  isGatewaySetKey,
  parseProviderPriority,
  writeProviderPriority,
} from "../../../cli/gateway/policy.js";

const dataDirs: string[] = [];

function createStore(): AiGatewaySettingsStore {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-policy-"));
  dataDirs.push(dataDir);
  return createAiGatewaySettingsStore({ dataDir });
}

afterEach(() => {
  while (dataDirs.length > 0) {
    const dataDir = dataDirs.pop();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  }
});

describe("fleet gateway set", () => {
  it("exposes exactly the scalar policy axes — model selection is not one of them", () => {
    expect([...GATEWAY_SET_KEYS]).toEqual([
      "xai-endpoint",
      "compact-ceiling",
      "wire-log",
      "cursor-diagnostics",
      "provider-priority",
    ]);
    expect(isGatewaySetKey("models")).toBe(false);
    expect(isGatewaySetKey(undefined)).toBe(false);
  });

  it("writes the xAI endpoint and refuses anything outside the pair", () => {
    const store = createStore();
    expect(applyGatewaySetting(store, "xai-endpoint", "direct")).toEqual({
      ok: true,
      summary: "xai-endpoint = direct",
    });
    expect(store.read().xaiEndpoint).toBe("direct");

    const rejected = applyGatewaySetting(store, "xai-endpoint", "somewhere-else");
    expect(rejected.ok).toBe(false);
    expect(store.read().xaiEndpoint).toBe("direct");
  });

  it("accepts auto, the named steps, and a custom percent for the compact ceiling", () => {
    const store = createStore();
    expect(applyGatewaySetting(store, "compact-ceiling", "early").ok).toBe(true);
    expect(store.read().compactCeiling).toBe("early");

    expect(applyGatewaySetting(store, "compact-ceiling", "82").ok).toBe(true);
    expect(store.read().compactCeiling).toBe(82);

    expect(applyGatewaySetting(store, "compact-ceiling", "auto").ok).toBe(true);
    expect(store.read().compactCeiling).toBeUndefined();

    expect(applyGatewaySetting(store, "compact-ceiling", "42").ok).toBe(false);
    expect(applyGatewaySetting(store, "compact-ceiling", "soon").ok).toBe(false);
  });

  it("keeps wire-log's off distinct from auto so an env toggle cannot revive it", () => {
    const store = createStore();
    expect(applyGatewaySetting(store, "wire-log", "off").ok).toBe(true);
    expect(store.read().wireLogEnabled).toBe(false);

    expect(applyGatewaySetting(store, "wire-log", "auto").ok).toBe(true);
    expect("wireLogEnabled" in store.read()).toBe(false);

    // cursor-diagnostics는 env 폴백이 없는 축이라 auto를 받지 않는다.
    expect(applyGatewaySetting(store, "cursor-diagnostics", "auto").ok).toBe(false);
    expect(applyGatewaySetting(store, "cursor-diagnostics", "on").ok).toBe(true);
    expect(store.read().cursorDiagnosticsEnabled).toBe(true);
  });

  it("parses a provider order and rejects unknown or repeated providers", () => {
    expect(parseProviderPriority("cursor,codex")).toEqual(["cursor", "codex"]);
    expect(parseProviderPriority(" cursor , codex ")).toEqual(["cursor", "codex"]);
    expect(parseProviderPriority("none")).toEqual([]);
    expect(parseProviderPriority("cursor,cursor")).toBe("invalid");
    expect(parseProviderPriority("anthropic")).toBe("invalid");
    expect(parseProviderPriority("")).toBe("invalid");
  });

  it("keeps the exposed models when only the spend priority changes", () => {
    // store.write는 넘긴 값으로 models 키를 통째로 덮는다. 우선순위만 바꾸는 저장이 현재
    // 선별을 함께 싣지 않으면 노출 모델이 전부 사라진다 — 그 경로를 여기서 못 박는다.
    const store = createStore();
    store.write({ models: [{ id: "gpt-5.6-luna", efforts: ["high"] }] });

    const result = applyGatewaySetting(store, "provider-priority", "cursor,codex");
    expect(result).toEqual({ ok: true, summary: "provider-priority = cursor → codex" });

    const stored = store.read();
    expect(stored.providerPriority).toEqual(["cursor", "codex"]);
    expect(stored.models).toEqual([{ id: "gpt-5.6-luna", efforts: ["high"] }]);
  });

  it("clears the priority without touching the models", () => {
    const store = createStore();
    store.write({ models: [{ id: "gpt-5.6-luna" }] });
    writeProviderPriority(store, ["codex"]);

    expect(applyGatewaySetting(store, "provider-priority", "none").ok).toBe(true);
    const stored = store.read();
    expect(stored.providerPriority ?? []).toEqual([]);
    expect(stored.models).toEqual([{ id: "gpt-5.6-luna" }]);
  });

  it("reports a missing value as invalid rather than writing a default", () => {
    const store = createStore();
    const result = applyGatewaySetting(store, "xai-endpoint", undefined);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("(missing)");
    expect(store.read().xaiEndpoint).toBeUndefined();
  });
});

describe("interactive compact ceiling choices", () => {
  it("offers only the three named steps when nothing custom is stored", () => {
    const choices = buildCompactCeilingChoices(undefined);
    expect(choices.options.map((option) => option.value)).toEqual(["auto", "early", "late"]);
    expect(choices.initialValue).toBe("auto");
  });

  it("preselects a stored named step", () => {
    expect(buildCompactCeilingChoices("late").initialValue).toBe("late");
  });

  it("surfaces a stored percent as its own choice instead of collapsing it into auto", () => {
    // 숫자를 auto로 접으면, xAI 엔드포인트만 바꾸러 들어온 사용자가 화면을 지나갔다는
    // 이유만으로 `set compact-ceiling 82`를 잃는다.
    const choices = buildCompactCeilingChoices(82);
    expect(choices.initialValue).toBe("custom");
    expect(choices.options.map((option) => option.value)).toEqual(["auto", "early", "late", "custom"]);
    expect(choices.options.at(3)?.label).toContain("82");
  });

  it("keeps the stored percent when the custom choice is accepted", () => {
    expect(resolveCompactCeilingChoice("custom", 82)).toBe(82);
    expect(resolveCompactCeilingChoice("auto", 82)).toBeUndefined();
    expect(resolveCompactCeilingChoice("early", 82)).toBe("early");
    // custom은 저장된 퍼센트가 있을 때만 화면에 오르지만, 없을 때 들어와도 auto로 안전하게 접힌다.
    expect(resolveCompactCeilingChoice("custom", undefined)).toBeUndefined();
    expect(resolveCompactCeilingChoice("custom", "late")).toBeUndefined();
  });
});

describe("gateway policy summary", () => {
  it("names the unset axes by what they fall back to", () => {
    expect(describeGatewayPolicy({ version: 1 })).toEqual({
      "xai-endpoint": "cli-proxy (default)",
      "compact-ceiling": "auto",
      "wire-log": "auto (env)",
      "cursor-diagnostics": "off",
      "provider-priority": "none",
    });
  });

  it("renders stored values in the same vocabulary the set command accepts", () => {
    expect(describeGatewayPolicy({
      version: 1,
      xaiEndpoint: "direct",
      compactCeiling: 82,
      wireLogEnabled: false,
      cursorDiagnosticsEnabled: true,
      providerPriority: ["cursor", "codex"],
    })).toEqual({
      "xai-endpoint": "direct",
      "compact-ceiling": "82%",
      "wire-log": "off",
      "cursor-diagnostics": "on",
      "provider-priority": "cursor → codex",
    });
  });
});
