/**
 * 실험 기능 설정 — 코어 설정의 한 항목이지만 형태는 SDK가 소유한다.
 *
 * 기능(Quick Launch·Terminal·Scuttlebutt)은 코어와 플러그인에 흩어져 있는데 저장은 코어 general
 * 설정 한 곳이다. 같은 정제기를 서버·브라우저·플러그인이 나눠 쓰지 않으면 세 곳이 각자 다른
 * 기본값을 갖게 되고, 그중 하나만 "꺼짐"을 "켜짐"으로 읽어도 옵트인 약속이 깨진다.
 *
 * 모델은 기능마다 고른다. 이미 자기 모델이 있는 표면 위의 기능(부관의 Console 읽기 —
 * 부관단 카드가 모델을 갖는다)은 별도 모델 필드가 없다.
 *
 * Cowork와 Session Analyst는 자기 컴포저에서 모델을 고르지 않는다 — 이 설정의 두 행(모델 + 강도)이
 * 유일한 좌표이고, 서버가 요청마다 여기서 읽어 세션에 싣는다.
 */

export type ComputerUseBackendId = "sky-computer-use" | "cua-driver";
export function isComputerUseBackendId(value: unknown): value is ComputerUseBackendId {
  return value === "sky-computer-use" || value === "cua-driver";
}

export type ExperimentFeatureId = "promptRefine" | "sessionWatch" | "consoleControl" | "computerUse";

export const EXPERIMENT_FEATURES: readonly ExperimentFeatureId[] = ["promptRefine", "sessionWatch", "consoleControl", "computerUse"];

/** AI를 쓰는 기능 — 설정 화면이 이 행에만 모델 선택기를 세운다. */
export type ExperimentModelFeatureId = "promptRefine" | "sessionWatch";

export const EXPERIMENT_MODEL_FEATURES: readonly ExperimentModelFeatureId[] = ["promptRefine", "sessionWatch"];

/** 항상 켜져 있어 스위치 없이 모델·강도만 고르는 보조 AI 표면. */
export type ExperimentAideId = "cowork" | "analyst";

export const EXPERIMENT_AIDES: readonly ExperimentAideId[] = ["cowork", "analyst"];

/** 보조 AI의 강도 사다리 — 부관단 카드와 같은 고정 3단. 강도를 받지 않는 모델은 무시한다. */
export const EXPERIMENT_EFFORTS = ["low", "medium", "high"] as const;
export type ExperimentEffort = (typeof EXPERIMENT_EFFORTS)[number];

export interface ExperimentAideSelection {
  readonly model: string;
  readonly effort: ExperimentEffort;
}

export interface ConsoleExperimentSettings {
  /** Quick Launch가 사용자의 요청을 명확한 작업 지시문으로 고쳐 쓴 초안을 내놓는다(메타 프롬프팅). */
  readonly promptRefine: boolean;
  readonly promptRefineModel: string;
  /** Operation마다 켜는 세션 분석가 관찰. */
  readonly sessionWatch: boolean;
  readonly sessionWatchModel: string;
  /** 켜져 있는 동안 Console MCP 실행과 제한된 자동 운영을 포괄 승인한다. */
  readonly consoleControl: boolean;
  /** 로컬 Computer Use. 옵트인이 앱 읽기·조작 권한을 승인한다. */
  readonly computerUse: boolean;
  readonly computerUseBackend: ComputerUseBackendId;
  /** Wiki 초안 Cowork 대화의 모델·강도. 다음 턴부터 적용된다. */
  readonly coworkModel: string;
  readonly coworkEffort: ExperimentEffort;
  /** Session Analyst 대화의 모델·강도. 새 분석 세션부터 적용된다. */
  readonly analystModel: string;
  readonly analystEffort: ExperimentEffort;
}

/**
 * 기본 모델은 Claude 네이티브 별칭이다. 별칭은 CLI가 스스로 풀므로 세대를 고정하지 않는다.
 * 고쳐 쓰기는 판단이 드는 일이라 sonnet을 기본으로 둔다.
 */
export const DEFAULT_EXPERIMENT_MODELS: Readonly<Record<ExperimentModelFeatureId, string>> = {
  promptRefine: "sonnet",
  sessionWatch: "sonnet",
};

/** 보조 AI의 기본 좌표 — 판단이 드는 일이라 sonnet, 강도는 일상 단인 medium. */
export const DEFAULT_EXPERIMENT_AIDE_SELECTION: ExperimentAideSelection = { model: "sonnet", effort: "medium" };

export const DEFAULT_EXPERIMENT_SETTINGS: ConsoleExperimentSettings = {
  promptRefine: false,
  promptRefineModel: DEFAULT_EXPERIMENT_MODELS.promptRefine,
  sessionWatch: false,
  sessionWatchModel: DEFAULT_EXPERIMENT_MODELS.sessionWatch,
  consoleControl: false,
  computerUse: false,
  computerUseBackend: "sky-computer-use",
  coworkModel: DEFAULT_EXPERIMENT_AIDE_SELECTION.model,
  coworkEffort: DEFAULT_EXPERIMENT_AIDE_SELECTION.effort,
  analystModel: DEFAULT_EXPERIMENT_AIDE_SELECTION.model,
  analystEffort: DEFAULT_EXPERIMENT_AIDE_SELECTION.effort,
};

/**
 * 모델 선택지 — 플러그인이 내놓는 모델 한 줄. id는 Claude Code `--model`에 그대로 들어가는 값이다.
 * 나머지 필드는 설정 화면의 ModelPicker가 밴드·메타·강도 사다리를 그리는 데 쓰는 선택 정보다 —
 * 없으면 밴드는 id 형식(`cursor--…`)에서 읽고, 메타와 사다리는 비운다.
 */
export interface ExperimentModelOption {
  readonly id: string;
  readonly label: string;
  /** 프로바이더 밴드를 id 형식 대신 명시할 때. 런치 글리프 id(`claude`·`cursor`…)여야 한다. */
  readonly provider?: string;
  readonly contextWindow?: number | null;
  readonly effortLevels?: readonly string[];
}

/**
 * 선택지에 항상 서는 Claude 별칭. Gateway 모델은 그것을 아는 플러그인이 `experimentModelOptions`로
 * 덧붙인다 — 코어는 어떤 공급자가 켜져 있는지 모른다.
 */
export const CLAUDE_EXPERIMENT_MODEL_OPTIONS: readonly ExperimentModelOption[] = [
  { id: "fable[1m]", label: "Fable" },
  { id: "opus[1m]", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._\-\[\]:]{0,127}$/u;

export function isExperimentModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID.test(value);
}

export function isExperimentEffort(value: unknown): value is ExperimentEffort {
  return typeof value === "string" && (EXPERIMENT_EFFORTS as readonly string[]).includes(value);
}

/**
 * 저장값·요청 본문·응답을 같은 규칙으로 정제한다. 알 수 없는 값은 기본값으로 떨어진다 —
 * 모델 필드가 비거나 깨져 있어도 기능이 모델 없이 도는 상태는 존재하지 않는다.
 */
export function resolveExperimentSettings(value: unknown): ConsoleExperimentSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return DEFAULT_EXPERIMENT_SETTINGS;
  const record = value as Record<string, unknown>;
  const model = (feature: ExperimentModelFeatureId): string => {
    const raw = record[`${feature}Model`];
    return isExperimentModelId(raw) ? raw : DEFAULT_EXPERIMENT_MODELS[feature];
  };
  const aideModel = (aide: ExperimentAideId): string => {
    const raw = record[`${aide}Model`];
    return isExperimentModelId(raw) ? raw : DEFAULT_EXPERIMENT_AIDE_SELECTION.model;
  };
  const aideEffort = (aide: ExperimentAideId): ExperimentEffort => {
    const raw = record[`${aide}Effort`];
    return isExperimentEffort(raw) ? raw : DEFAULT_EXPERIMENT_AIDE_SELECTION.effort;
  };
  return {
    promptRefine: record.promptRefine === true,
    promptRefineModel: model("promptRefine"),
    sessionWatch: record.sessionWatch === true,
    sessionWatchModel: model("sessionWatch"),
    consoleControl: record.consoleControl === true,
    computerUse: record.computerUse === true,
    computerUseBackend: isComputerUseBackendId(record.computerUseBackend) ? record.computerUseBackend : "sky-computer-use",
    coworkModel: aideModel("cowork"),
    coworkEffort: aideEffort("cowork"),
    analystModel: aideModel("analyst"),
    analystEffort: aideEffort("analyst"),
  };
}

/** 한 보조 AI에 배정된 모델·강도. */
export function experimentAideSelection(settings: ConsoleExperimentSettings, aide: ExperimentAideId): ExperimentAideSelection {
  return { model: settings[`${aide}Model`], effort: settings[`${aide}Effort`] };
}

/** 한 기능에 배정된 모델 id. */
export function experimentFeatureModel(settings: ConsoleExperimentSettings, feature: ExperimentModelFeatureId): string {
  return settings[`${feature}Model`];
}
