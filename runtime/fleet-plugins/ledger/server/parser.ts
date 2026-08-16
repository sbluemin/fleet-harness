import type { TokscaleModelEntry, TokscaleSession } from "./types.js";

export type ParseResult =
  | { readonly status: "ok" | "degraded"; readonly sessions: TokscaleSession[]; readonly skippedSessions: number }
  | { readonly status: "unreadable"; readonly sessions: []; readonly skippedSessions: number };

export type ModelsParseResult =
  | { readonly status: "ok" | "degraded"; readonly entries: TokscaleModelEntry[]; readonly skippedEntries: number }
  | { readonly status: "unreadable"; readonly entries: []; readonly skippedEntries: number };

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}(?:\[1[mM]\])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_FRAGMENT_RE = /(?:^|[^0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:$|[^0-9a-f])/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRepresentableTimestamp(value: unknown): value is number {
  if (!isNonNegativeSafeInteger(value)) return false;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  const localYear = date.getFullYear();
  return localYear >= 0 && localYear <= 9999;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function canonicalSessionId(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value.toLowerCase() : null;
}

function safeModelId(value: unknown): string | null {
  if (
    typeof value !== "string"
    || !MODEL_RE.test(value)
    || value.startsWith("/")
    || value.includes("..")
    || UUID_FRAGMENT_RE.test(value)
  ) return null;
  return value;
}

function parseSession(value: unknown): TokscaleSession | null {
  if (!isRecord(value)) return null;
  const sessionId = canonicalSessionId(value.session_id);
  if (!sessionId || !isRepresentableTimestamp(value.last_active)) return null;
  return { sessionId, lastActive: value.last_active };
}

export function parseTokscaleOutput(stdout: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { status: "unreadable", sessions: [], skippedSessions: 0 };
  }
  if (!Array.isArray(parsed)) return { status: "unreadable", sessions: [], skippedSessions: 0 };
  const sessions = parsed.map(parseSession).filter((session): session is TokscaleSession => session !== null);
  const skippedSessions = parsed.length - sessions.length;
  if (parsed.length > 0 && sessions.length === 0) return { status: "unreadable", sessions: [], skippedSessions };
  return { status: skippedSessions > 0 ? "degraded" : "ok", sessions, skippedSessions };
}

function parseModelEntry(value: unknown): TokscaleModelEntry | null {
  if (!isRecord(value)) return null;
  const sessionId = canonicalSessionId(value.sessionId);
  const modelId = safeModelId(value.model);
  if (
    !sessionId
    || !modelId
    || value.client !== "claude"
    || !isNonNegativeSafeInteger(value.input)
    || !isNonNegativeSafeInteger(value.output)
    || !isNonNegativeSafeInteger(value.cacheRead)
    || !isNonNegativeSafeInteger(value.cacheWrite)
    || !isNonNegativeFinite(value.cost)
    || !isNonNegativeSafeInteger(value.messageCount)
  ) return null;
  return {
    sessionId,
    modelId,
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
    costUsd: value.cost,
    messages: value.messageCount,
  };
}

export function parseTokscaleModelsOutput(stdout: string): ModelsParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { status: "unreadable", entries: [], skippedEntries: 0 };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
    return { status: "unreadable", entries: [], skippedEntries: 0 };
  }
  const entries = parsed.entries
    .map(parseModelEntry)
    .filter((entry): entry is TokscaleModelEntry => entry !== null);
  const skippedEntries = parsed.entries.length - entries.length;
  if (parsed.entries.length > 0 && entries.length === 0) {
    return { status: "unreadable", entries: [], skippedEntries };
  }
  return { status: skippedEntries > 0 ? "degraded" : "ok", entries, skippedEntries };
}
