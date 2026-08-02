import type { AnalystSession as AnalystSessionInstance, AnalystSessionOptions } from "@dotobokuri/fleet-analyst";
import type { AgentCliStatus } from "./agent-cli-types.js";

export const ANALYSIS_ERROR_CODES = {
  captureMissing: "analysis_capture_missing",
  transcriptMissing: "analysis_transcript_missing",
  catalogInvalid: "analysis_catalog_invalid",
  sessionExists: "analysis_session_exists",
  sessionNotFound: "analysis_session_not_found",
  sessionBusy: "analysis_session_busy",
} as const;

export type AnalysisErrorCode = (typeof ANALYSIS_ERROR_CODES)[keyof typeof ANALYSIS_ERROR_CODES];
export type AnalysisError = { readonly error: { readonly code: AnalysisErrorCode; readonly message: string } };
export type AnalysisCatalog = { readonly clis: readonly AnalysisCatalogCli[] };
export type AnalysisCatalogCli = {
  readonly cliId: AnalystCliId;
  readonly label: string;
  readonly available: boolean;
  readonly defaultModel: string;
  readonly models: readonly AnalysisCatalogModel[];
};
export type AnalysisCatalogModel = { readonly id: string; readonly label: string; readonly effortLevels: readonly string[]; readonly defaultEffort?: string };
export type AnalystCliId = AnalystSessionOptions["cliId"];
export type AnalysisSession = AnalystSessionInstance;
export type AnalysisEvent =
  | { readonly type: "connected" }
  | { readonly type: "chunk"; readonly text: string }
  | { readonly type: "thought"; readonly text: string }
  | { readonly type: "tool"; readonly title: string; readonly status: string }
  | { readonly type: "artifact"; readonly artifact: { readonly id: string; readonly title: string; readonly html: string; readonly createdAt: number } }
  | { readonly type: "complete" }
  | { readonly type: "error"; readonly error: { readonly code: string; readonly message: string } };

export const ANALYST_CLI_ENTRIES: readonly { readonly binaryId: string; readonly cliId: AnalystCliId; readonly label?: string }[] = [
  { binaryId: "claude", cliId: "claude" },
  { binaryId: "cursor-agent", cliId: "cursor" },
];

export function buildAnalysisCatalog(
  statuses: readonly AgentCliStatus[],
  modelsFor: (cliId: AnalystCliId) => { readonly defaultModel: string; readonly models: readonly { readonly modelId: string; readonly name: string; readonly effort: { readonly supported: boolean; readonly levels?: readonly string[]; readonly default?: string | null } }[] },
): AnalysisCatalog {
  const statusById = new Map(statuses.map((status) => [status.id, status]));
  return { clis: ANALYST_CLI_ENTRIES.map(({ binaryId, cliId, label }) => {
    const provider = modelsFor(cliId);
    const status = statusById.get(binaryId);
    return {
      cliId,
      label: label ?? status?.displayName ?? cliId,
      available: status?.available === true,
      defaultModel: provider.defaultModel,
      models: provider.models.map((model) => ({
        id: model.modelId,
        label: model.name,
        effortLevels: model.effort.supported ? [...(model.effort.levels ?? [])] : [],
        ...(model.effort.supported && model.effort.default ? { defaultEffort: model.effort.default } : {}),
      })),
    };
  }) };
}

export function analysisError(code: AnalysisErrorCode, message: string): AnalysisError {
  return { error: { code, message } };
}

export function isAnalysisSelection(catalog: AnalysisCatalog, value: unknown): value is { readonly cliId: AnalystCliId; readonly model: string; readonly effort?: string; readonly language?: "en" | "ko" } {
  if (!isRecord(value) || !hasExactKeys(value, ["cliId", "model", "effort", "language"]) || typeof value.cliId !== "string" || typeof value.model !== "string" || (value.effort !== undefined && typeof value.effort !== "string") || (value.language !== undefined && value.language !== "en" && value.language !== "ko")) return false;
  const cli = catalog.clis.find((candidate) => candidate.cliId === value.cliId);
  if (!cli?.available) return false;
  const model = cli.models.find((candidate) => candidate.id === value.model);
  if (!model) return false;
  if (model.effortLevels.length === 0) return value.effort === undefined || value.effort === "";
  return typeof value.effort === "string" && value.effort.length > 0 && model.effortLevels.includes(value.effort);
}

export function isMessageBody(value: unknown): value is { readonly text: string } {
  return isRecord(value) && hasExactKeys(value, ["text"]) && typeof value.text === "string" && value.text.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every((key) => keys.includes(key)) && keys.filter((key) => value[key] !== undefined).length === Object.keys(value).length; }
