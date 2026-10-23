import type { ConsoleExperimentSettings, ExperimentModelOption } from "./experiments.js";
/**
 * 실험 기능 설정의 읽기. 설정 자체는 코어 general 설정이고 소유자도 코어다 — 플러그인은 무엇이
 * 켜져 있고 어느 좌석에 무엇이 앉았는지만 읽는다. 아직 읽히지 않았으면 null이며, 그때는 전부
 * 꺼진 것으로 다뤄야 한다(옵트인의 기본은 꺼짐).
 */
export interface ClientExperimentsCapability {
  read(): ConsoleExperimentSettings | null;
  subscribe(listener: () => void): () => void;
  /** 설정 저장 — 코어의 general 설정 한 필드를 통째로 바꾼다. 플러그인은 자기 행만 고쳐 넘긴다. */
  update(next: ConsoleExperimentSettings): Promise<boolean>;
  /**
   * 코어가 experiments 필드를 지금 저장 중인지. 같은 필드의 겹친 저장은 코어가 거절하므로(false),
   * 플러그인 행은 이 동안 자기 컨트롤을 잠가 눌린 값이 조용히 버려지는 일을 막는다.
   */
  saving(): boolean;
  /**
   * 모델 선택지 — 모델 로스터(`agent` 대상)를 옛 옵션 모양으로 편 것.
   * @deprecated `ctx.models.read("agent")`와 `AI Gateway ModelCoordinatePicker`를 쓴다.
   * Fleet 1.215.0에서 제거한다.
   */
  modelOptions(): Promise<readonly ExperimentModelOption[]>;
}


export interface ClientPreferencesCapability {
  read<T>(key: string, fallback: T): T;
  write<T>(key: string, value: T): void;
}


export interface ClientSettingsCapability {
  read(): Promise<Record<string, unknown> | null>;
  write(value: Record<string, unknown>): Promise<void>;
}
