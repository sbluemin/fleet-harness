import {
  buildAiGatewayCatalog,
  resolveAiGatewaySelection,
  type AiGatewayCatalogModel,
  type AiGatewayStoredSettings,
  type GatewayModel,
  type GatewayProvider,
} from "@dotobokuri/core-ai-gateway";

import { GATEWAY_SET_KEYS, describeGatewayPolicy, type GatewaySetKey } from "./policy.js";
import { command, dim, optionRow, resolveColorEnabled, section, stripAnsi } from "../styles/tokens.js";

/** 자격증명 축은 공급자마다 조달 경로가 달라 하나의 판정으로 합쳐진다. */
export type GatewayCredentialState = "present" | "absent";

export interface GatewayCredentialReport {
  readonly provider: GatewayProvider;
  readonly state: GatewayCredentialState;
  /** 이 공급자의 자격증명이 어디서 오는지. `fleet gateway auth`가 다루는 축인지 구분한다. */
  readonly source: "subscription" | "api-key";
}

export interface GatewayModelReport {
  readonly id: string;
  readonly provider: GatewayProvider;
  readonly name: string;
  readonly contextWindow: number | null;
  readonly efforts: readonly string[];
  readonly hostOnly: boolean;
}

export interface GatewayRenderOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
}

export function collectGatewayModels(settings: AiGatewayStoredSettings): readonly GatewayModelReport[] {
  const catalog = buildAiGatewayCatalog();
  const catalogModels = new Map<string, { readonly model: AiGatewayCatalogModel; readonly provider: GatewayProvider }>();
  for (const provider of catalog.providers) {
    for (const model of provider.models) catalogModels.set(model.id, { model, provider: provider.id });
  }
  const selection = resolveAiGatewaySelection(settings);
  const hostOnlyIds = new Set(
    (settings.models ?? []).filter((entry) => entry.hostOnly === true).map((entry) => entry.id),
  );
  return selection.models.flatMap((model: GatewayModel) => {
    const entry = catalogModels.get(model.id);
    if (!entry) return [];
    return [{
      id: model.id,
      provider: entry.provider,
      name: entry.model.name,
      contextWindow: entry.model.contextWindow,
      efforts: selection.effortExposure[model.id] ?? entry.model.effort?.levels ?? [],
      hostOnly: hostOnlyIds.has(model.id),
    }];
  });
}

export function renderGatewayModelsText(
  models: readonly GatewayModelReport[],
  options: GatewayRenderOptions = {},
): string {
  const colorEnabled = resolveColorEnabled(options);
  if (models.length === 0) {
    return finish([
      dim("No models exposed. Run `fleet gateway` to choose some.", colorEnabled),
      "",
    ], colorEnabled);
  }
  const nameColumn = Math.max(...models.map((model) => model.name.length)) + 2;
  const lines: string[] = [
    dim(summarizeModelCount(models), colorEnabled),
    "",
  ];
  let lastProvider: GatewayProvider | undefined;
  for (const model of models) {
    if (model.provider !== lastProvider) {
      if (lastProvider !== undefined) lines.push("");
      lines.push(section(model.provider, colorEnabled));
      lastProvider = model.provider;
    }
    lines.push(
      `  ${command(model.name, colorEnabled)}${" ".repeat(Math.max(1, nameColumn - model.name.length))}${dim(describeModelAxes(model), colorEnabled)}`,
    );
  }
  lines.push("");
  return finish(lines, colorEnabled);
}

export function renderGatewayModelsJson(models: readonly GatewayModelReport[]): string {
  return `${JSON.stringify({ models }, null, 2)}\n`;
}

export interface GatewayStatusReport {
  readonly settingsPath: string;
  readonly exposed: number;
  readonly delegable: number;
  readonly providers: readonly GatewayProvider[];
  readonly policy: Readonly<Record<GatewaySetKey, string>>;
  readonly credentials: readonly GatewayCredentialReport[];
}

export function buildGatewayStatusReport(deps: {
  readonly settingsPath: string;
  readonly settings: AiGatewayStoredSettings;
  readonly credentials: readonly GatewayCredentialReport[];
}): GatewayStatusReport {
  const models = collectGatewayModels(deps.settings);
  return {
    settingsPath: deps.settingsPath,
    exposed: models.length,
    delegable: models.filter((model) => !model.hostOnly).length,
    providers: [...new Set(models.map((model) => model.provider))],
    policy: describeGatewayPolicy(deps.settings),
    credentials: deps.credentials,
  };
}

export function renderGatewayStatusText(
  report: GatewayStatusReport,
  options: GatewayRenderOptions = {},
): string {
  const colorEnabled = resolveColorEnabled(options);
  const lines: string[] = [
    section("MODELS", colorEnabled),
    optionRow(
      "exposed",
      report.exposed === 0
        ? "none — run `fleet gateway` to choose some"
        : `${report.exposed} · ${report.delegable} delegable · ${report.providers.join(", ")}`,
      colorEnabled,
    ),
    "",
    section("POLICY", colorEnabled),
    ...GATEWAY_SET_KEYS.map((key) => optionRow(key, report.policy[key], colorEnabled)),
    "",
    section("CREDENTIALS", colorEnabled),
    ...report.credentials.map((credential) => optionRow(
      credential.provider,
      describeCredential(credential),
      colorEnabled,
    )),
    "",
    section("SETTINGS", colorEnabled),
    `  ${dim(report.settingsPath, colorEnabled)}`,
    "",
  ];
  return finish(lines, colorEnabled);
}

export function renderGatewayStatusJson(report: GatewayStatusReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function describeCredential(credential: GatewayCredentialReport): string {
  if (credential.source === "api-key") {
    return credential.state === "present"
      ? "signed in"
      : "not signed in — `fleet gateway auth login`";
  }
  return credential.state === "present" ? "subscription found" : "no subscription found";
}

function describeModelAxes(model: GatewayModelReport): string {
  const axes = [
    formatContextWindow(model.contextWindow),
    model.efforts.length > 0 ? `effort ${model.efforts.join("·")}` : undefined,
    model.hostOnly ? "host-only" : undefined,
  ].filter((axis): axis is string => axis !== undefined);
  return axes.length > 0 ? axes.join("   ") : model.id;
}

function formatContextWindow(contextWindow: number | null): string | undefined {
  if (contextWindow === null || contextWindow <= 0) return undefined;
  if (contextWindow >= 1_000_000) return `${Math.round(contextWindow / 100_000) / 10}M`;
  return `${Math.round(contextWindow / 1_000)}k`;
}

function summarizeModelCount(models: readonly GatewayModelReport[]): string {
  const providers = [...new Set(models.map((model) => model.provider))].join(", ");
  const hostOnly = models.filter((model) => model.hostOnly).length;
  const hostOnlyNote = hostOnly > 0 ? ` · ${hostOnly} host-only` : "";
  return `${models.length} exposed · ${providers}${hostOnlyNote}`;
}

function finish(lines: readonly string[], colorEnabled: boolean): string {
  const text = lines.join("\n");
  return colorEnabled ? text : stripAnsi(text);
}
