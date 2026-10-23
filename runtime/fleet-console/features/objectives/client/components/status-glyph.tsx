/** 목표 행이 상태를 현재 활동 표식으로 옮길 때 쓰는 공통 상태 어휘. */
export type StatusGlyphState =
  | "fresh"
  | "running"
  | "background"
  | "awaiting"
  | "idle"
  | "unseen"
  | "ended"
  | "review"
  | "done";
