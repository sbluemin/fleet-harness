export type OperationsArrowShortcutAction =
  | "focus-previous"
  | "focus-next"
  | "triage-defer"
  | "triage-noop";

export function resolveOperationsArrowShortcutAction(
  triageActive: boolean,
  key: string,
): OperationsArrowShortcutAction | null {
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  if (triageActive) return key === "ArrowRight" ? "triage-defer" : "triage-noop";
  return key === "ArrowRight" ? "focus-next" : "focus-previous";
}
