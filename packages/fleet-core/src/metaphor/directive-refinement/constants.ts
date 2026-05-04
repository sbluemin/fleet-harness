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

export function isValidReasoning(val: string): val is ReasoningLevel {
  return REASONING_LEVELS.includes(val as ReasoningLevel);
}
