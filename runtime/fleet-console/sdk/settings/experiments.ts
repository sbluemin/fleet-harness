/**
 * 실험 기능 설정 — 코어 설정의 한 항목이지만 형태는 SDK가 소유한다.
 *
 * 기능은 코어와 플러그인에 흩어져 있는데 저장은 코어 general 설정 한 곳이다. 같은 정제기를
 * 서버·브라우저·플러그인이 나눠 쓰지 않으면 세 곳이 각자 다른 기본값을 갖게 되고, 그중 하나만 "꺼짐"을 "켜짐"으로 읽어도 옵트인 약속이 깨진다.
 *
 * 모델은 기능마다 고른다. 이미 자기 모델이 있는 표면 위의 기능(부관의 Console 읽기 —
 * 부관단 카드가 모델을 갖는다)은 별도 모델 필드가 없다.
 *
 * Cowork는 자기 컴포저에서 모델을 고르지 않는다 — 이 설정의 두 행(모델 + 강도)이
 * 유일한 좌표이고, 서버가 요청마다 여기서 읽어 세션에 싣는다.
 */

import { AGENT_EFFORTS, canonicalModelId, isAgentEffort, type AgentEffort } from "../models/index.js";

export type ComputerUseBackendId = "sky-computer-use" | "cua-driver";
export function isComputerUseBackendId(value: unknown): value is ComputerUseBackendId {
  return value === "sky-computer-use" || value === "cua-driver";
}

/**
 * 모델·강도 좌표를 가진 보조 AI 표면. 사령관의 자율 운영은 Theater 별로 켜고 끈다.
 * `analyst`는 옛 클라이언트·플러그인의 ID 호환만 남기며 활성 목록에는 싣지 않는다.
 */
export type ExperimentAideId = "cowork" | "analyst" | "commodore";

export const EXPERIMENT_AIDES: readonly ExperimentAideId[] = ["cowork", "commodore"];

/**
 * 보조 AI의 강도 어휘 — Agent SDK 세션이 받는 사다리 전체(low…max). 화면은 고른 모델의 사다리를 보이고, 실행은
 * 그 사다리 안으로 클램프한다(저장값은 고쳐 쓰지 않는다). `ultra`는 Claude Code 하네스 센티넬이라 여기 없다.
 */
export const EXPERIMENT_EFFORTS = AGENT_EFFORTS;
export type ExperimentEffort = AgentEffort;

export interface ExperimentAideSelection {
  readonly model: string;
  readonly effort: ExperimentEffort;
}

export interface ConsoleExperimentSettings {
  /**
   * 옛 클라이언트·플러그인 응답 호환 필드. 데스크톱은 항상 대화 중심 화면이라 저장된 값과
   * 무관하게 false다. true는 더 이상 캔버스 배치를 켜지 않는다.
   */
  readonly classicLayout: false;
  /** 로컬 Computer Use. 옵트인이 앱 읽기·조작 권한을 승인한다. */
  readonly computerUse: boolean;
  readonly computerUseBackend: ComputerUseBackendId;
  /** Wiki 초안 Cowork 대화의 모델·강도. 다음 턴부터 적용된다. */
  readonly coworkModel: string;
  readonly coworkEffort: ExperimentEffort;
  /** 옛 클라이언트·플러그인 응답 호환 필드. 기능은 퇴역했으며 저장값·요청값과 무관하게 기본 좌표다. */
  readonly analystModel: string;
  readonly analystEffort: ExperimentEffort;
  /** 옛 클라이언트·플러그인 응답 호환 필드. 사령관은 상시 제공하며 옛 false 값도 true로 해석한다. */
  readonly commodore: boolean;
  readonly commodoreModel: string;
  readonly commodoreEffort: ExperimentEffort;
}

/**
 * 보조 AI의 기본 좌표 — 판단이 드는 일이라 Sonnet, 강도는 일상 단인 medium. 모델은 Claude 네이티브
 * 1M 별칭이다. 별칭은 CLI가 스스로 풀므로 세대를 고정하지 않는다.
 */
export const DEFAULT_EXPERIMENT_AIDE_SELECTION: ExperimentAideSelection = { model: "sonnet[1m]", effort: "medium" };

/** 사령관의 기본 좌표는 고정이다. Theater 별 좌표만 이 값을 덮는다. */
const COMMODORE_DEFAULT_SELECTION: ExperimentAideSelection = Object.freeze({ model: "opus[1m]", effort: "high" });

export const DEFAULT_EXPERIMENT_SETTINGS: ConsoleExperimentSettings = {
  classicLayout: false,
  computerUse: false,
  computerUseBackend: "sky-computer-use",
  coworkModel: DEFAULT_EXPERIMENT_AIDE_SELECTION.model,
  coworkEffort: DEFAULT_EXPERIMENT_AIDE_SELECTION.effort,
  analystModel: DEFAULT_EXPERIMENT_AIDE_SELECTION.model,
  analystEffort: DEFAULT_EXPERIMENT_AIDE_SELECTION.effort,
  commodore: true,
  commodoreModel: COMMODORE_DEFAULT_SELECTION.model,
  commodoreEffort: COMMODORE_DEFAULT_SELECTION.effort,
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
 * @deprecated 모델 선택지의 원천은 모델 로스터(Settings › AI Gateway) 하나다. 내장 코드는 이 목록을 읽지 않는다.
 * Fleet 1.215.0에서 제거한다.
 */
export const CLAUDE_EXPERIMENT_MODEL_OPTIONS: readonly ExperimentModelOption[] = [
  { id: "fable[1m]", label: "Fable" },
  { id: "opus[1m]", label: "Opus" },
  { id: "sonnet[1m]", label: "Sonnet" },
  { id: "haiku[1m]", label: "Haiku" },
];

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._\-\[\]:]{0,127}$/u;

export function isExperimentModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID.test(value);
}

export function isExperimentEffort(value: unknown): value is ExperimentEffort {
  return isAgentEffort(value);
}

/**
 * 저장값·요청 본문·응답을 같은 규칙으로 정제한다. 알 수 없는 값은 기본값으로 떨어진다 —
 * 모델 필드가 비거나 깨져 있어도 기능이 모델 없이 도는 상태는 존재하지 않는다. 모르는 키는
 * 투영에서 빠지므로 다음 저장 때 디스크에서도 사라진다. 명시적인 응답 호환 필드는 남지만
 * 퇴역한 기능의 저장값은 읽지 않고 고정된 기본값으로 돌려준다.
 */
export function resolveExperimentSettings(value: unknown): ConsoleExperimentSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return DEFAULT_EXPERIMENT_SETTINGS;
  const record = value as Record<string, unknown>;
  const aideModel = (aide: ExperimentAideId): string => {
    const raw = record[`${aide}Model`];
    return isExperimentModelId(raw) ? canonicalModelId(raw) : DEFAULT_EXPERIMENT_AIDE_SELECTION.model;
  };
  const aideEffort = (aide: ExperimentAideId): ExperimentEffort => {
    const raw = record[`${aide}Effort`];
    return isExperimentEffort(raw) ? raw : DEFAULT_EXPERIMENT_AIDE_SELECTION.effort;
  };
  return {
    // 저장된 classicLayout 은 읽지 않는다. 필드는 v1 응답에 남기되 항상 false다.
    classicLayout: false,
    computerUse: record.computerUse === true,
    computerUseBackend: isComputerUseBackendId(record.computerUseBackend) ? record.computerUseBackend : "sky-computer-use",
    coworkModel: aideModel("cowork"),
    coworkEffort: aideEffort("cowork"),
    analystModel: DEFAULT_EXPERIMENT_AIDE_SELECTION.model,
    analystEffort: DEFAULT_EXPERIMENT_AIDE_SELECTION.effort,
    commodore: true,
    // 옛 설정과 응답의 필드 모양은 유지하되, 저장된 기본 좌표는 더 이상 읽지 않는다.
    commodoreModel: COMMODORE_DEFAULT_SELECTION.model,
    commodoreEffort: COMMODORE_DEFAULT_SELECTION.effort,
  };
}

/** 한 보조 AI에 배정된 모델·강도. */
export function experimentAideSelection(settings: ConsoleExperimentSettings, aide: ExperimentAideId): ExperimentAideSelection {
  if (aide === "commodore") return COMMODORE_DEFAULT_SELECTION;
  if (aide === "analyst") return DEFAULT_EXPERIMENT_AIDE_SELECTION;
  return { model: settings[`${aide}Model`], effort: settings[`${aide}Effort`] };
}
