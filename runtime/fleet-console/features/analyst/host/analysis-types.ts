import { AI_GATEWAY_ROUTE_SEGMENT } from "@fleet-console/ai-gateway";
import type { AnalystSession as AnalystSessionInstance } from "@fleet-console/analyst";
import {
  clampRosterEffort,
  resolveRosterCoordinate,
  rosterRowEfforts,
  rosterRows,
  type ModelCoordinate,
  type ModelRoster,
  type ResolvedModelCoordinate,
} from "@fleet-console/sdk/models";
import { experimentAideSelection, type ConsoleExperimentSettings } from "@fleet-console/sdk/settings";

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
/**
 * 분석가가 실제로 도는 좌표. Settings › 실험 기능 › AI 확장 › Session Analyst의 값을 카탈로그와 대조한
 * 결과다 — 목록 밖 모델이면 Sonnet(없으면 첫 모델)으로 내려가고 `fallback`이 참이 된다. 패널은 이 값을
 * 고르지 않고 보여 주기만 하며, 시작 요청은 이 값으로 돈다.
 */
export type AnalysisSelection = { readonly cliId: AnalystCliId; readonly model: string; readonly effort: string; readonly fallback: boolean };
export type AnalysisCatalog = { readonly clis: readonly AnalysisCatalogCli[]; readonly selection?: AnalysisSelection };
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
 * 분석가의 기본 선택 — 소유자가 정한 sonnet/low. 강도는 모델 로스터 행의 사다리 전체를 쓰고, 사다리에 low가 없으면
 * 실행 시점 클램프(그 이하의 가장 높은 단, 없으면 첫 단)가 정한다.
 */
const ANALYST_DEFAULT_MODEL = "sonnet";
const ANALYST_DEFAULT_EFFORT = "low";
const ANALYST_DEFAULT_COORDINATE: ModelCoordinate = { model: ANALYST_DEFAULT_MODEL, effort: ANALYST_DEFAULT_EFFORT };
export type AnalysisSession = AnalystSessionInstance;
/** 사람이 아닌 질문자 — Console Use 로 물은 Operation. 제목만 싣는다. */
export type AnalysisOrigin = { readonly kind: "operation"; readonly operationId: string; readonly title: string } | { readonly kind: "plugin"; readonly pluginId: string };

export type AnalysisEvent =
  | { readonly type: "connected" }
  /** 원장 항목: 질문 하나가 접수됐다. 사람의 질문도 에이전트의 질문도 같은 원장에 서고, 패널은 이것을 그린다. */
  | { readonly type: "user"; readonly text: string; readonly at: number; readonly by?: AnalysisOrigin }
  | { readonly type: "chunk"; readonly text: string }
  | { readonly type: "thought"; readonly text: string }
  | { readonly type: "tool"; readonly title: string; readonly status: string }
  | { readonly type: "artifact"; readonly artifact: { readonly id: string; readonly title: string; readonly html: string; readonly createdAt: number } }
  | { readonly type: "complete" }
  | { readonly type: "error"; readonly error: { readonly code: string; readonly message: string } };

/** 원장 한 줄 — 사건과 그 시각. 분석가 세션과 수명을 같이한다(초기화·중지에 비움). */
export type AnalysisJournalEntry = { readonly at: number; readonly event: Exclude<AnalysisEvent, { readonly type: "connected" } | { readonly type: "thought" }> };

/**
 * AI gateway는 이 플러그인이 직접 서빙한다. 경로 조각은 core-ai-gateway가 소유하고, 어느
 * basePath 아래 마운트되는지는 여기가 안다.
 */
export function resolveAnalysisGatewayBaseUrl(origin: string): string {
  return `${origin.replace(/\/+$/u, "")}/api/v1/${AI_GATEWAY_ROUTE_SEGMENT}`;
}

/**
 * 분석가가 고를 수 있는 모델 — 모델 로스터(`agent` 대상)를 그대로 편다. Settings › AI Gateway에서 켠 모델이
 * 곧 이 목록이고, 행 id는 정준 id다. 로스터가 비어도 시작은 막지 않는다 — 실행은 최후 폴백(sonnet)으로 서고
 * 선택의 `fallback`이 그 사실을 드러낸다.
 */
export function buildAnalysisCatalog(
  roster: ModelRoster,
  available: boolean,
  settings: ConsoleExperimentSettings,
  resolve: (stored: ModelCoordinate) => ResolvedModelCoordinate = (stored) => resolveRosterCoordinate(roster, stored, ANALYST_DEFAULT_COORDINATE),
): AnalysisCatalog {
  const models = rosterRows(roster).map((row) => {
    const effortLevels = rosterRowEfforts(row);
    const defaultEffort = clampRosterEffort(effortLevels, ANALYST_DEFAULT_EFFORT);
    return {
      id: row.launch.model ?? row.id,
      label: row.label,
      effortLevels,
      ...(defaultEffort ? { defaultEffort } : {}),
    };
  });
  const resolved = resolve(experimentAideSelection(settings, "analyst"));
  // 행이 있으면 해석이 이미 그 사다리 안으로 클램프했다. 로스터가 비어 최후 폴백이면 저장 강도를 그대로 싣는다.
  const effort = resolved.row ? resolved.effort ?? "" : resolved.effort ?? settings.analystEffort;
  return {
    clis: [{
      cliId: ANALYST_GATEWAY_CLI_ID,
      label: "AI Gateway",
      // Console이 아직 리슨 전이면 시작할 수 없다.
      available,
      defaultModel: resolved.model,
      models,
    }],
    selection: { cliId: ANALYST_GATEWAY_CLI_ID, model: resolved.model, effort, fallback: resolved.fallback },
  };
}

export function analysisError(code: AnalysisErrorCode, message: string): AnalysisError {
  return { error: { code, message } };
}

/** 시작 요청 본문 — 좌표는 서버가 Settings에서 정하므로 출력 언어만 받는다. */
export function isAnalysisStartBody(value: unknown): value is { readonly language?: "en" | "ko" } {
  return isRecord(value) && hasExactKeys(value, ["language"]) && (value.language === undefined || value.language === "en" || value.language === "ko");
}

export function isMessageBody(value: unknown): value is { readonly text: string } {
  return isRecord(value) && hasExactKeys(value, ["text"]) && typeof value.text === "string" && value.text.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every((key) => keys.includes(key)) && keys.filter((key) => value[key] !== undefined).length === Object.keys(value).length; }
