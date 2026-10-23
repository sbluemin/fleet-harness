import type { ConsoleExperimentSettings } from "./experiments.js";
/** 서버 쪽 실험 설정 읽기 — 저장값을 매번 읽으므로 설정을 바꾼 직후의 요청부터 새 값을 본다. */
export interface ExperimentsHost {
  read(): ConsoleExperimentSettings;
  /**
   * 저장 직후 호출된다. 요청마다 읽지 않는 상주 작업(감시자·타이머)이 옵트인 전환을 놓치지 않게
   * 하는 통로다 — 없는 호스트에서는 다음 읽기까지 옛 값이 유효하다.
   */
  subscribe?(listener: (settings: ConsoleExperimentSettings) => void): () => void;
}
