import type { ModelCoordinate, ModelRoster, ModelRosterTarget, ResolvedWireCoordinate } from "../shared/models.js";
/** 서버 쪽 모델 로스터 읽기. 저장값을 매번 읽으므로 Gateway를 저장한 직후의 요청부터 새 로스터를 본다. */
export interface ModelRosterHost {
  roster(target: ModelRosterTarget): ModelRoster;
  /**
   * 저장 좌표를 로스터에 대조해 실행 좌표를 정한다. 저장값은 고쳐 쓰지 않는다. 로스터 밖이면 `fallback`
   * 좌표(생략하면 sonnet) 쪽으로 서고 `fallback:true`다 — 소비자는 그 사실을 실행 기록에 남긴다.
   */
  resolve(stored: ModelCoordinate, target: ModelRosterTarget, fallback?: ModelCoordinate): ResolvedWireCoordinate;
  /**
   * Claude 별칭 wire id(`opus[1m]` 따위)를 이 Console이 띄우는 Claude Code가 그 별칭을 푸는 정식 id로 바꾼다. 1M 표기는
   * 그대로 둔다. Agent SDK의 내장 CLI는 별칭을 자기 버전의 표로 풀므로, 터미널 세션과 같은 모델로 세워야 하는 세션만
   * 고르는 통로다. Claude 별칭이 아니거나 아직 못 풀었으면 받은 값을 그대로 돌려주고, 실패하지 않는다.
   */
  pinClaudeVersion?(wireModel: string): Promise<string>;
  /** 로스터가 바뀐 직후 울린다. 요청마다 읽지 않는 상주 작업이 쓰는 통로다. */
  subscribe?(listener: () => void): () => void;
}
