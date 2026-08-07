import type { TerminalMessageKey } from "../i18n/index.js";
import type { SessionGoal } from "./types.js";

export async function setSessionGoal(
  sessionId: string,
  condition: string,
  checkLimit: number,
  signal?: AbortSignal,
): Promise<SessionGoal> {
  const response = await fetch(`/plugins/terminal/agent/sessions/${encodeURIComponent(sessionId)}/goal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ condition, checkLimit }),
    signal,
  });
  if (!response.ok) throw await goalApiError(response);
  const payload = await response.json() as { readonly goal?: SessionGoal };
  if (!payload.goal) throw new Error("terminal.goal.error.notLive");
  return payload.goal;
}

export async function clearSessionGoal(sessionId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`/plugins/terminal/agent/sessions/${encodeURIComponent(sessionId)}/goal`, {
    method: "DELETE",
    signal,
  });
  if (!response.ok) throw await goalApiError(response);
}

async function goalApiError(response: Response): Promise<Error> {
  const payload = await response.json().catch(() => null) as { readonly error?: unknown } | null;
  return new Error(goalErrorKey(typeof payload?.error === "string" ? payload.error : ""));
}

function goalErrorKey(error: string): TerminalMessageKey {
  if (error === "goal_unsupported") return "terminal.goal.error.unsupported";
  if (error === "goal_condition_too_long") return "terminal.goal.error.tooLong";
  return "terminal.goal.error.notLive";
}
