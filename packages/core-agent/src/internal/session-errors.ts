/**
 * session-errors — resume 실패 분류.
 *
 * imports -> types/interfaces -> constants -> functions 순서 준수.
 */

export type ResumeFailureKind =
  | "dead-session"
  | "capability-mismatch"
  | "auth"
  | "transport"
  | "model-config"
  | "timeout"
  | "abort"
  | "unknown";

const DEAD_SESSION_PATTERNS = [
  /session not found/i,
  /unknown session/i,
  /invalid session/i,
  /closed session/i,
  /expired session/i,
];
const AUTH_PATTERNS = [
  /auth/i,
  /login/i,
  /unauthorized/i,
  /permission denied/i,
  /invalid api key/i,
];

export function classifyResumeFailure(error: unknown): ResumeFailureKind {
  const message = extractErrorMessage(error);
  if (message === "Aborted") return "abort";
  if (DEAD_SESSION_PATTERNS.some((pattern) => pattern.test(message))) return "dead-session";
  if (/loadSession.*지원하지 않/i.test(message) || /session\/load.*지원하지 않/i.test(message)) {
    return "capability-mismatch";
  }
  if (/does not support session\/load/i.test(message) || /does not support loadSession/i.test(message)) {
    return "capability-mismatch";
  }
  if (AUTH_PATTERNS.some((pattern) => pattern.test(message))) return "auth";
  if (/spawn|initialize|transport|econn|pipe|closed/i.test(message)) return "transport";
  if (/model|config|mcp/i.test(message)) return "model-config";
  if (/timeout|timed out|유휴 상태/i.test(message)) return "timeout";
  return "unknown";
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}
