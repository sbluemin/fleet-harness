/**
 * OS 감속 모션 — 전환·pulse를 줄일지 화면마다 같은 규칙으로 한 번 읽는다.
 * commodore가 소유하는 판정이라 core 내부 경로를 위로 import하지 않는다.
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}
