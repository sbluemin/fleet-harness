/**
 * 실험 기능 설정 — 코어 설정의 한 항목이지만 형태는 SDK가 소유한다.
 *
 * 기능(Quick Launch·Terminal·Scuttlebutt)은 코어와 플러그인에 흩어져 있는데 저장은 코어 general
 * 설정 한 곳이다. 같은 정제기를 서버·브라우저·플러그인이 나눠 쓰지 않으면 세 곳이 각자 다른
 * 기본값을 갖게 되고, 그중 하나만 "꺼짐"을 "켜짐"으로 읽어도 옵트인 약속이 깨진다.
 *
 * 모델은 기능마다 고른다. AI를 쓰는 기능은 자기 모델 필드를 갖고, 쓰지 않는 기능(컨텍스트 팩)은 없다.
 */

export type ExperimentFeatureId = "promptRefine" | "launchContextPack" | "sessionWatch" | "aideConsoleRead";

export const EXPERIMENT_FEATURES: readonly ExperimentFeatureId[] = ["promptRefine", "launchContextPack", "sessionWatch", "aideConsoleRead"];

/** AI를 쓰는 기능 — 설정 화면이 이 행에만 모델 선택기를 세운다. */
export type ExperimentModelFeatureId = "promptRefine" | "sessionWatch" | "aideConsoleRead";

export const EXPERIMENT_MODEL_FEATURES: readonly ExperimentModelFeatureId[] = ["promptRefine", "sessionWatch", "aideConsoleRead"];

export interface ConsoleExperimentSettings {
  /** Quick Launch가 사용자의 요청을 명확한 작업 지시문으로 고쳐 쓴 초안을 내놓는다(메타 프롬프팅). */
  readonly promptRefine: boolean;
  readonly promptRefineModel: string;
  /** Quick Launch가 런치 직전 Wiki·커밋 후보를 보여 준다 — 모델 없음. */
  readonly launchContextPack: boolean;
  /** Operation마다 켜는 세션 분석가 관찰. */
  readonly sessionWatch: boolean;
  readonly sessionWatchModel: string;
  /** Scuttlebutt 부관이 Console을 읽는다. */
  readonly aideConsoleRead: boolean;
  readonly aideConsoleReadModel: string;
}

/**
 * 기본 모델은 Claude 네이티브 별칭이다. 별칭은 CLI가 스스로 풀므로 세대를 고정하지 않는다.
 * 고쳐 쓰기는 판단이 드는 일이라 sonnet을 기본으로 둔다.
 */
export const DEFAULT_EXPERIMENT_MODELS: Readonly<Record<ExperimentModelFeatureId, string>> = {
  promptRefine: "sonnet",
  sessionWatch: "sonnet",
  aideConsoleRead: "sonnet",
};

export const DEFAULT_EXPERIMENT_SETTINGS: ConsoleExperimentSettings = {
  promptRefine: false,
  promptRefineModel: DEFAULT_EXPERIMENT_MODELS.promptRefine,
  launchContextPack: false,
  sessionWatch: false,
  sessionWatchModel: DEFAULT_EXPERIMENT_MODELS.sessionWatch,
  aideConsoleRead: false,
  aideConsoleReadModel: DEFAULT_EXPERIMENT_MODELS.aideConsoleRead,
};

/** 모델 선택지 — 플러그인이 내놓는 모델 한 줄. id는 Claude Code `--model`에 그대로 들어가는 값이다. */
export interface ExperimentModelOption {
  readonly id: string;
  readonly label: string;
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
  return {
    promptRefine: record.promptRefine === true,
    promptRefineModel: model("promptRefine"),
    launchContextPack: record.launchContextPack === true,
    sessionWatch: record.sessionWatch === true,
    sessionWatchModel: model("sessionWatch"),
    aideConsoleRead: record.aideConsoleRead === true,
    aideConsoleReadModel: model("aideConsoleRead"),
  };
}

/** 한 기능에 배정된 모델 id. */
export function experimentFeatureModel(settings: ConsoleExperimentSettings, feature: ExperimentModelFeatureId): string {
  return settings[`${feature}Model`];
}
