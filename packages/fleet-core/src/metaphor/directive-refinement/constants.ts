/**
 * directive-refinement/constants.ts — 타입, 상수, 검증
 */

export type ReasoningLevel = "off" | "low" | "medium" | "high";

export const REASONING_LEVELS: ReasoningLevel[] = ["off", "low", "medium", "high"];

export const REASONING_LABELS: Record<ReasoningLevel, string> = {
  off: "Off",
  low: "›  Low",
  medium: "»  Medium",
  high: "⋙  High",
};

/** 상태바 셰브론 색상 매핑 */
export const REASONING_COLORS: Record<ReasoningLevel, string> = {
  off: "dim",
  low: "success",
  medium: "warning",
  high: "error",
};

/**
 * @deprecated 이 커맨드는 더 이상 등록되지 않습니다. 대신 `fleet:metaphor:settings`를 사용하세요.
 */
export const REFINE_DIRECTIVE_COMMAND = "fleet:metaphor:directive";

export function isValidReasoning(val: string): val is ReasoningLevel {
  return REASONING_LEVELS.includes(val as ReasoningLevel);
}
