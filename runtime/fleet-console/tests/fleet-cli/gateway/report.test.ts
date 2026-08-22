import { buildAiGatewayCatalog } from "@dotobokuri/core-ai-gateway";
import { describe, expect, it } from "vitest";

import {
  buildGatewayStatusReport,
  collectGatewayModels,
  renderGatewayModelsJson,
  renderGatewayModelsText,
  renderGatewayStatusJson,
  renderGatewayStatusText,
  type GatewayCredentialReport,
} from "../../../cli/gateway/report.js";

function anyModelId(): string {
  const model = buildAiGatewayCatalog().providers.flatMap((provider) => provider.models).at(0);
  if (!model) throw new Error("catalog is empty");
  return model.id;
}

const CREDENTIALS: readonly GatewayCredentialReport[] = [
  { provider: "codex", source: "subscription", state: "present" },
  { provider: "kimi", source: "api-key", state: "absent" },
];

describe("gateway model report", () => {
  it("reports nothing exposed for empty settings", () => {
    expect(collectGatewayModels({ version: 1 })).toEqual([]);
    const text = renderGatewayModelsText([], { env: { NO_COLOR: "1" }, isTTY: true });
    expect(text).toContain("No models exposed");
    expect(text).toContain("fleet gateway");
  });

  it("carries the provider, effort exposure, and host-only mark of a stored model", () => {
    const id = anyModelId();
    const models = collectGatewayModels({ version: 1, models: [{ id, hostOnly: true }] });
    expect(models).toHaveLength(1);
    expect(models.at(0)).toMatchObject({ id, hostOnly: true });
    expect((models.at(0)?.provider ?? "").length).toBeGreaterThan(0);
  });

  it("drops a stored id that left the catalog", () => {
    expect(collectGatewayModels({ version: 1, models: [{ id: "retired-model" }] })).toEqual([]);
  });

  it("renders text without escape codes when color is disabled", () => {
    const models = collectGatewayModels({ version: 1, models: [{ id: anyModelId() }] });
    const text = renderGatewayModelsText(models, { env: { NO_COLOR: "1" }, isTTY: true });
    expect(text).toContain("1 exposed");
    expect(text).not.toContain("\x1b[");
  });

  it("emits the model list as JSON for scripts", () => {
    const models = collectGatewayModels({ version: 1, models: [{ id: anyModelId() }] });
    const parsed = JSON.parse(renderGatewayModelsJson(models)) as { readonly models: readonly unknown[] };
    expect(parsed.models).toHaveLength(1);
  });
});

describe("gateway status report", () => {
  it("counts exposed and delegable separately so host-only is visible", () => {
    const id = anyModelId();
    const report = buildGatewayStatusReport({
      settingsPath: "/tmp/ai-gateway.json",
      settings: { version: 1, models: [{ id, hostOnly: true }] },
      credentials: CREDENTIALS,
    });
    expect(report.exposed).toBe(1);
    expect(report.delegable).toBe(0);
    expect(report.providers.length).toBe(1);
  });

  it("tells a missing subscription apart from a provider that is not signed in", () => {
    const report = buildGatewayStatusReport({
      settingsPath: "/tmp/ai-gateway.json",
      settings: { version: 1 },
      credentials: CREDENTIALS,
    });
    const text = renderGatewayStatusText(report, { env: { NO_COLOR: "1" }, isTTY: true });
    expect(text).toContain("subscription found");
    expect(text).toContain("not signed in");
    expect(text).toContain("fleet gateway auth login");
    expect(text).toContain("/tmp/ai-gateway.json");
    expect(text).not.toContain("\x1b[");
  });

  it("names the empty selection instead of printing a bare zero", () => {
    const report = buildGatewayStatusReport({
      settingsPath: "/tmp/ai-gateway.json",
      settings: { version: 1 },
      credentials: [],
    });
    expect(renderGatewayStatusText(report, { env: { NO_COLOR: "1" }, isTTY: true })).toContain("none —");
  });

  it("emits the same report as JSON", () => {
    const report = buildGatewayStatusReport({
      settingsPath: "/tmp/ai-gateway.json",
      settings: { version: 1, xaiEndpoint: "direct" },
      credentials: CREDENTIALS,
    });
    const parsed = JSON.parse(renderGatewayStatusJson(report)) as {
      readonly policy: Record<string, string>;
      readonly credentials: readonly unknown[];
    };
    expect(parsed.policy["xai-endpoint"]).toBe("direct");
    expect(parsed.credentials).toHaveLength(2);
  });
});
