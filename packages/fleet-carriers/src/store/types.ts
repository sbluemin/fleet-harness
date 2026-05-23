import type { TaskForceCliType } from "../dispatch/types.js";

/** CLI별 설정 캐시 (CLI 변경 시 이전 설정 복원용) */
export type PerCliSettings = {
  model?: string;
  effort?: string;
  direct?: boolean;
};

/** 각 carrier별 모델 선택 설정 */
export interface ModelSelection {
  /** 선택된 모델 ID */
  model: string;
  /** Direct 모드 사용 여부 (codex 전용, ACP 우회) */
  direct?: boolean;
  /** Reasoning effort (codex, claude — SDK의 effort.levels 기반) */
  effort?: string;
  /** Task Force 백엔드별 커스텀 설정 (cliType → 모델 선택) */
  taskforce?: TaskForceConfig;
  /** CLI 변경 시 이전 설정 복원을 위한 CLI별 설정 캐시 */
  perCliSettings?: Partial<Record<string, PerCliSettings>>;
}

/** states.json의 models 키 전체 구조 */
export type SelectedModelsConfig = Record<string, ModelSelection>;

export type TaskForceSelection = Omit<ModelSelection, "taskforce">;

export type TaskForceConfig = Partial<Record<TaskForceCliType, TaskForceSelection>>;

/** states.json 통합 스키마 */
export interface FleetStates {
  /** states.json write generation (watcher echo suppression용) */
  _generation?: number;
  /** 모델 선택 설정 */
  models?: SelectedModelsConfig;
  /** carrier별 cliType 오버라이드 (defaultCliType과 다를 때만 저장) */
  cliTypeOverrides?: Record<string, string>;
  /** carrier별 사용자 지정 표시 이름 오버라이드 */
  carrierDisplayNames?: Record<string, string>;
}

export interface StoreLockOwner {
  pid: number;
  hostname: string;
  startedAt: number;
}

export interface FleetStoreSnapshot {
  generation: number;
  models: SelectedModelsConfig;
  cliTypeOverrides: Record<string, string>;
  carrierDisplayNames: Record<string, string>;
}

/** 로컬 프로세스가 직전에 기록한 states.json 지문(watcher echo 판별용, mtime+size 병합) */
export interface FleetStoreWriteFingerprint {
  generation: number;
  mtimeMs: number;
  size: number;
}
