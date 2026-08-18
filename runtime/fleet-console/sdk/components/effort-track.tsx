// 강도 트랙의 원본은 composer 패키지로 옮겨 앉았다 — 컴포저 빌딩블록 한 벌(sdk/composer)의
// 일원이 됐기 때문이다. 이 경로는 기존 소비자(core client 셔임·플러그인)의 하위호환 재수출로 남는다.
export {
  EffortGaugeGlyph,
  EffortTrack,
  effortLadderPosition,
  gatedEffortNames,
  resolveRowEffort,
} from "../composer/effort-track.js";
export type { EffortTrackProps } from "../composer/effort-track.js";
