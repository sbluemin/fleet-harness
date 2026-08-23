import { AI_GATEWAY_ROUTE_SEGMENT, toClaudeGatewayModelId, type GatewayModel } from "@dotobokuri/core-ai-gateway";
import { NATIVE_CLAUDE_MODEL_ALIASES } from "@dotobokuri/fleet-admiral";
import type { AnalystSession as AnalystSessionInstance } from "@dotobokuri/fleet-analyst";

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
/**
 * 분석가 백엔드의 id.
 *
 * 예전에는 탐지된 Agent CLI를 골랐지만 이제 분석가는 AI Gateway 위에서만 돈다. 클라이언트는 이
 * 값을 불투명 문자열로만 다루므로 항목이 하나로 줄어도 화면 계약은 그대로다.
 */
export type AnalystCliId = "claude";
const ANALYST_GATEWAY_CLI_ID: AnalystCliId = "claude";

/**
 * 분석가의 기본 선택.
 *
 * 오늘의 기본값은 `opus[1m]`/`xhigh`였다. 소유자가 sonnet/low로 낮추기로 정했으므로 여기서
 * 한 곳으로 고정한다. 강도 사다리는 ANALYST_EFFORT_LEVELS가 자른다.
 */
const ANALYST_DEFAULT_MODEL = "sonnet";
const ANALYST_DEFAULT_EFFORT = "low";
/**
 * 분석가가 여는 강도. Quick Launch 트랙의 일상 단과 같고, xhigh·max·ultra는
 * 이 표면에 서지 않는다 — 카탈로그가 더 내놓아도 여기서 자른다.
 */
const ANALYST_EFFORT_LEVELS = ["low", "medium", "high"] as const;
export type AnalystEffortLevel = (typeof ANALYST_EFFORT_LEVELS)[number];

function clampAnalystEffortLevels(levels: readonly string[]): readonly string[] {
  return ANALYST_EFFORT_LEVELS.filter((level) => levels.includes(level));
}

function clampAnalystDefaultEffort(levels: readonly string[], fallback?: string | null): string | undefined {
  if (fallback && levels.includes(fallback)) return fallback;
  if (levels.includes(ANALYST_DEFAULT_EFFORT)) return ANALYST_DEFAULT_EFFORT;
  return levels[0];
}
/**
 * 분석가가 고를 수 있는 native Claude 별칭.
 *
 * Console Launch가 실제로 띄우는 로스터와 같은 출처를 쓴다. 예전에는 ACP 패키지의 모델
 * 레지스트리를 읽었는데, 그쪽은 Launch가 제공하지 않는 별칭까지 담고 있어 분석가만 다른 목록을
 * 보여 주고 있었다.
 */
const NATIVE_CLAUDE_LABELS: Readonly<Record<string, string>> = {
  "fable[1m]": "Claude Fable",
  sonnet: "Claude Sonnet",
  "opus[1m]": "Claude Opus [1M]",
};

export function nativeClaudeAnalystModels(): readonly {
  readonly modelId: string;
  readonly name: string;
  readonly effort: { readonly supported: true; readonly levels: readonly string[] };
}[] {
  return NATIVE_CLAUDE_MODEL_ALIASES.map((modelId) => ({
    modelId,
    name: NATIVE_CLAUDE_LABELS[modelId] ?? modelId,
    effort: { supported: true, levels: [...ANALYST_EFFORT_LEVELS] },
  }));
}

export type AnalysisSession = AnalystSessionInstance;
export type AnalysisEvent =
  | { readonly type: "connected" }
  | { readonly type: "chunk"; readonly text: string }
  | { readonly type: "thought"; readonly text: string }
  | { readonly type: "tool"; readonly title: string; readonly status: string }
  | { readonly type: "artifact"; readonly artifact: { readonly id: string; readonly title: string; readonly html: string; readonly createdAt: number } }
  | { readonly type: "complete" }
  | { readonly type: "error"; readonly error: { readonly code: string; readonly message: string } };

/**
 * AI gateway는 이 플러그인이 직접 서빙한다. 경로 조각은 core-ai-gateway가 소유하고, 어느
 * basePath 아래 마운트되는지는 여기가 안다.
 */
export function resolveAnalysisGatewayBaseUrl(origin: string): string {
  return `${origin.replace(/\/+$/u, "")}/plugins/terminal/${AI_GATEWAY_ROUTE_SEGMENT}`;
}

/**
 * 분석가가 고를 수 있는 모델.
 *
 * 두 갈래를 한 목록으로 낸다. native Claude 별칭은 게이트웨이 카탈로그에 없지만 라우터가 호출자
 * 자격증명으로 Anthropic에 원문 중계하므로 그대로 돌고, 오늘 분석가가 제공하던 선택지가 바로
 * 그것이다. 거기에 사용자가 Console에서 켠 게이트웨이 모델을 덧붙인다.
 */
export function buildAnalysisCatalog(
  nativeModels: readonly {
    readonly modelId: string;
    readonly name: string;
    readonly effort: { readonly supported: boolean; readonly levels?: readonly string[]; readonly default?: string | null };
  }[],
  gatewayModels: readonly GatewayModel[],
  available: boolean,
): AnalysisCatalog {
  const native = nativeModels.map((model) => {
    const effortLevels = model.effort.supported ? clampAnalystEffortLevels(model.effort.levels ?? []) : [];
    const defaultEffort = model.modelId === ANALYST_DEFAULT_MODEL
      ? clampAnalystDefaultEffort(effortLevels, ANALYST_DEFAULT_EFFORT)
      : model.effort.supported
        ? clampAnalystDefaultEffort(effortLevels, model.effort.default)
        : undefined;
    return {
      id: model.modelId,
      label: model.name,
      effortLevels,
      ...(defaultEffort ? { defaultEffort } : {}),
    };
  });
  const gateway = gatewayModels.map((model) => {
    const effortLevels = model.effort.supported ? clampAnalystEffortLevels(model.effort.levels) : [];
    return {
      id: toClaudeGatewayModelId(model),
      label: model.displayName,
      // 게이트웨이 모델 스키마에는 기본 강도가 없다. 없는 값을 지어내면 사용자가 고르지 않은
      // 강도로 돈다. 클램프 후 단이 비면 강도 없는 모델과 같다.
      effortLevels,
    };
  });
  const models = [...native, ...gateway];
  return {
    clis: [{
      cliId: ANALYST_GATEWAY_CLI_ID,
      label: "AI Gateway",
      // 고를 모델이 없거나 Console이 아직 리슨 전이면 시작할 수 없다.
      available: available && models.length > 0,
      defaultModel: models.some((model) => model.id === ANALYST_DEFAULT_MODEL)
        ? ANALYST_DEFAULT_MODEL
        : models[0]?.id ?? "",
      models,
    }],
  };
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
