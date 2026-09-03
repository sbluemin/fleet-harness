import { describe, expect, it } from "vitest";

import { GATEWAY_MODELS } from "../../src/models.js";
import {
  buildAiGatewayCatalog,
  normalizeAiGatewaySettings,
  parseAiGatewayUpdate,
  resolveAiGatewaySelection,
} from "../../src/settings/index.js";

describe("ai-gateway settings", () => {
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

  it("normalizes host-only flags to the true-only stored form", () => {
    expect(normalizeAiGatewaySettings({
      version: 1,
      models: [
        { id: "kimi--k3", hostOnly: true },
        { id: "cursor--auto", hostOnly: false },
        { id: "codex--gpt-5.6-sol-fast", hostOnly: "yes" },
      ],
    })).toEqual({
      version: 1,
      models: [
        { id: "kimi--k3", hostOnly: true },
        { id: "cursor--auto" },
        { id: "codex--gpt-5.6-sol-fast" },
      ],
    });
    expect(normalizeAiGatewaySettings({
      version: 1,
      models: [{ id: "kimi--k3", efforts: ["max"], hostOnly: true }],
    })).toEqual({
      version: 1,
      models: [{ id: "kimi--k3", efforts: ["max"], hostOnly: true }],
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

  it("resolves stale ids out of the exposed selection", () => {
    const selection = resolveAiGatewaySelection({
      version: 1,
      models: [{ id: "cursor--grok-4.5" }, { id: "cursor--minimax-m3" }],
    });
    expect(selection.models.map((model) => model.id)).toEqual(["cursor--grok-4.5"]);
  });

  it("keeps host-only models on the wire while provider-sorting the delegation subset", () => {
    const selection = resolveAiGatewaySelection({
      version: 1,
      models: [
        { id: "cursor--grok-4.5-fast", hostOnly: true },
        { id: "codex--gpt-5.6-sol-fast" },
        { id: "kimi--k3" },
        { id: "codex--gpt-5.6-luna-fast" },
      ],
    });
    expect(selection.models.map((model) => model.id)).toEqual([
      "codex--gpt-5.6-sol-fast",
      "codex--gpt-5.6-luna-fast",
      "cursor--grok-4.5-fast",
      "kimi--k3",
    ]);
    expect(selection.delegationModels.map((model) => model.id)).toEqual([
      "codex--gpt-5.6-sol-fast",
      "codex--gpt-5.6-luna-fast",
      "kimi--k3",
    ]);
  });

  it("carries every model's capability class into the catalog, and null where the registry forbids one", () => {
    const catalog = buildAiGatewayCatalog();
    const projected = new Map(
      catalog.providers.flatMap((provider) => provider.models).map((model) => [model.id, model]),
    );
    for (const model of GATEWAY_MODELS) {
      expect(projected.get(model.id)?.capabilityClass).toBe(model.capabilityClass ?? null);
    }
    // 라우팅 별칭은 등급을 가질 수 없다. 그 부재는 결측이 아니라 그 자체가 사실이므로
    // 카탈로그가 끝까지 실어 나르고, 로스터는 등급 대신 부재를 표시한다.
    expect(projected.get("cursor--auto")?.capabilityClass).toBeNull();
    expect(new Set([...projected.values()].map((model) => model.capabilityClass)))
      .toEqual(new Set(["flagship", "standard", "light", null]));
  });

  it("keeps the ultra launch sentinel out of the settings catalog DTO", () => {
    // ultracode는 모델의 단이 아니라 Console launch의 하네스 능력이다 — 설정 UI가 고를 수 있는
    // 사다리에 서면 안 되고, Sol/Terra도 max에서 끝난다.
    const catalog = buildAiGatewayCatalog();
    const projected = new Map(
      catalog.providers.flatMap((provider) => provider.models).map((model) => [model.id, model]),
    );
    for (const model of projected.values()) {
      expect(model.effort?.levels ?? []).not.toContain("ultra");
    }
    expect(projected.get("codex--gpt-5.6-sol")?.effort?.levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(projected.get("codex--gpt-5.6-terra")?.effort?.levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("parses host-only flags and rejects malformed or unknown per-model keys", () => {
    expect(parseAiGatewayUpdate({ models: [{ id: "kimi--k3", hostOnly: true }] })).toEqual({
      ok: true,
      value: { models: [{ id: "kimi--k3", hostOnly: true }] },
    });
    expect(parseAiGatewayUpdate({ models: [{ id: "kimi--k3", hostOnly: false }] })).toEqual({
      ok: true,
      value: { models: [{ id: "kimi--k3" }] },
    });
    expect(parseAiGatewayUpdate({ models: [{ id: "kimi--k3", hostOnly: "yes" }] })).toEqual({ ok: false });
    expect(parseAiGatewayUpdate({ models: [{ id: "kimi--k3", unknown: true }] })).toEqual({ ok: false });
  });

  it("accepts providerPriority updates including an explicit clear", () => {
    expect(parseAiGatewayUpdate({ providerPriority: ["codex", "cursor"] })).toEqual({
      ok: true,
      value: { providerPriority: ["codex", "cursor"] },
    });
    expect(parseAiGatewayUpdate({
      models: [{ id: "kimi--k3" }],
      providerPriority: [],
    })).toEqual({
      ok: true,
      value: { models: [{ id: "kimi--k3" }], providerPriority: [] },
    });
  });

  it("rejects malformed providerPriority updates", () => {
    expect(parseAiGatewayUpdate({ providerPriority: "codex" })).toEqual({ ok: false });
    expect(parseAiGatewayUpdate({ providerPriority: ["unknown"] })).toEqual({ ok: false });
    expect(parseAiGatewayUpdate({ providerPriority: ["codex", "codex"] })).toEqual({ ok: false });
    expect(parseAiGatewayUpdate({ providerPriority: ["codex", 7] })).toEqual({ ok: false });
  });

  it("providerPriority round-trips and drops unknown providers and duplicates", () => {
    expect(normalizeAiGatewaySettings({
      version: 1,
      providerPriority: ["cursor", "codex", "cursor", "unknown", "kimi"],
    })).toEqual({ version: 1, providerPriority: ["cursor", "codex", "kimi"] });

    expect(normalizeAiGatewaySettings({
      version: 1,
      providerPriority: ["unknown", 7, ""],
    })).toEqual({ version: 1 });

    const selection = resolveAiGatewaySelection({
      version: 1,
      providerPriority: ["opencode", "codex"],
    });
    expect(selection.providerPriority).toEqual(["opencode", "codex"]);
  });

  // 카탈로그 프루닝 마이그레이션: stale id가 정규형에 남으면 GET→PUT 에코 경로에서
  // 검증기가 그 id를 거부해 AI Gateway 저장 전체가 400으로 잠긴다.
  it("drops models that left the catalog", () => {
    expect(normalizeAiGatewaySettings({
      version: 1,
      models: [
        { id: "opencode--qwen3.7-max" },
        { id: "opencode--muse-spark-1.2-contributor" },
        { id: "kimi--k3", efforts: ["max"] },
      ],
    })).toEqual({ version: 1, models: [{ id: "kimi--k3", efforts: ["max"] }] });
  });

  it("normalizes compactCeiling and drops invalid values", () => {
    expect(normalizeAiGatewaySettings({
      version: 1,
      compactCeiling: "early",
    })).toEqual({ version: 1, compactCeiling: "early" });
    expect(normalizeAiGatewaySettings({
      version: 1,
      compactCeiling: "late",
    })).toEqual({ version: 1, compactCeiling: "late" });
    expect(normalizeAiGatewaySettings({
      version: 1,
      compactCeiling: 94,
    })).toEqual({ version: 1, compactCeiling: 94 });
    expect(normalizeAiGatewaySettings({
      version: 1,
      compactCeiling: 69,
    })).toEqual({ version: 1 });
    expect(normalizeAiGatewaySettings({
      version: 1,
      compactCeiling: "auto",
    })).toEqual({ version: 1 });
  });

  it("accepts a legacy defaultModel key but drops it instead of storing it", () => {
    expect(parseAiGatewayUpdate({
      models: [{ id: "kimi--k3" }],
      defaultModel: "kimi--k3",
    })).toEqual({ ok: true, value: { models: [{ id: "kimi--k3" }] } });
    // defaultModel 단독은 빈 갱신으로 본다 — 저장할 축이 남지 않는다.
    expect(parseAiGatewayUpdate({ defaultModel: "kimi--k3" })).toEqual({ ok: true, value: undefined });
    // normalize는 저장된 레거시 defaultModel을 조용히 버린다.
    expect(normalizeAiGatewaySettings({
      version: 1,
      models: [{ id: "kimi--k3" }],
      defaultModel: "kimi--k3",
    })).toEqual({ version: 1, models: [{ id: "kimi--k3" }] });
    // 다른 모르는 키는 여전히 거부된다 — defaultModel만 무시의 예외다.
    expect(parseAiGatewayUpdate({ defaultModel: "kimi--k3", unknown: true })).toEqual({ ok: false });
  });
});

describe("xAI endpoint preference", () => {
  it("keeps a stored preference, including the one that matches the default", () => {
    expect(normalizeAiGatewaySettings({ version: 1, xaiEndpoint: "cli-proxy" }).xaiEndpoint).toBe("cli-proxy");
    // `direct` is not folded away: absence means never chosen, and a later default change must
    // not move an installation the user pinned.
    expect(normalizeAiGatewaySettings({ version: 1, xaiEndpoint: "direct" }).xaiEndpoint).toBe("direct");
  });

  it("drops an unknown endpoint rather than failing the whole file", () => {
    expect(normalizeAiGatewaySettings({ version: 1, xaiEndpoint: "somewhere-else" }).xaiEndpoint).toBeUndefined();
    expect(normalizeAiGatewaySettings({ version: 1, xaiEndpoint: 3 }).xaiEndpoint).toBeUndefined();
  });
});
