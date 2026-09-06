import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAiGatewaySettingsStore, type AiGatewaySettingsStore } from "@dotobokuri/core-ai-gateway";
import { afterEach, describe, expect, it } from "vitest";

import {
  GATEWAY_SET_KEYS,
  applyGatewaySetting,
  buildCompactCeilingChoices,
  nextPriorityDefault,
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

  it("parses a provider order and rejects unknown or repeated providers", () => {
    expect(parseProviderPriority("cursor,codex")).toEqual(["cursor", "codex"]);
    expect(parseProviderPriority(" cursor , codex ")).toEqual(["cursor", "codex"]);
    expect(parseProviderPriority("none")).toEqual([]);
    expect(parseProviderPriority("cursor,cursor")).toBe("invalid");
    expect(parseProviderPriority("anthropic")).toBe("invalid");
    expect(parseProviderPriority("")).toBe("invalid");
  });
});

describe("interactive spend priority defaults", () => {
  const ALL = ["codex", "xai", "cursor", "opencode", "kimi"] as const;

  it("walks the stored order while it lasts, then terminates", () => {
    const stored = ["cursor", "codex"] as const;
    expect(nextPriorityDefault(stored, [], ALL)).toBe("cursor");
    expect(nextPriorityDefault(stored, ["cursor"], ALL.filter((p) => p !== "cursor"))).toBe("codex");
    // 저장된 둘을 다 지나면 기본은 Done이라, 부분 순위가 전체 랭킹으로 자라지 않는다.
    expect(nextPriorityDefault(stored, ["cursor", "codex"], ["xai", "opencode", "kimi"])).toBe("");
  });
});
