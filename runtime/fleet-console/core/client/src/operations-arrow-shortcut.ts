export type OperationsArrowShortcutAction =
  | "focus-previous"
  | "focus-next"
  | "triage-defer"
  | "triage-noop"
  | "maximize-toggle"
  | "minimize"
  | "triage-set-aside";

export function resolveOperationsArrowShortcutAction(
  triageActive: boolean,
  key: string,
): OperationsArrowShortcutAction | null {
  if (triageActive) {
    if (key === "ArrowRight") return "triage-defer";
    if (key === "ArrowDown") return "triage-set-aside";
    if (key === "ArrowLeft" || key === "ArrowUp") return "triage-noop";
    return null;
  }
  if (key === "ArrowRight") return "focus-next";
  if (key === "ArrowLeft") return "focus-previous";
  if (key === "ArrowUp") return "maximize-toggle";
  if (key === "ArrowDown") return "minimize";
  return null;
}
