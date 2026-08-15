import type { TokscaleModelEntry, TokscaleSession } from "./types.js";

export type ParseResult =
  | { readonly status: "ok" | "degraded"; readonly sessions: TokscaleSession[]; readonly skippedSessions: number }
  | { readonly status: "unreadable"; readonly sessions: []; readonly skippedSessions: number };

export type ModelsParseResult =
  | { readonly status: "ok" | "degraded"; readonly entries: TokscaleModelEntry[]; readonly skippedEntries: number }
  | { readonly status: "unreadable"; readonly entries: []; readonly skippedEntries: number };

const CLIENT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}(?:\[1[mM]\])?$/;
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

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function sanitizeClient(value: string): string {
  return CLIENT_RE.test(value) ? value : "other";
}

function sanitizeModels(value: readonly unknown[]): string[] {
  return value.filter((model): model is string => (
    typeof model === "string"
    && MODEL_RE.test(model)
    && !model.startsWith("/")
    && !model.includes("..")
    && !UUID_FRAGMENT_RE.test(model)
  ));
}

function parseSession(value: unknown): TokscaleSession | null {
  if (!isRecord(value)) return null;
  const models = value.models_used;
  if (
    typeof value.session_id !== "string"
    || typeof value.client !== "string"
    // workspace/workspace_label은 요구하지 않는다 — Theater 스코프는 Operation.theaterId로 걸므로
    // 이 필드를 쓰지 않고, tokscale은 workspace를 판정하지 못하면 null을 준다(실측: kimi 세션).
    // 필수로 두면 쓰지도 않는 필드 때문에 정상 사용량을 통째로 버리게 된다.
    || !isRepresentableTimestamp(value.created_at)
    || !isRepresentableTimestamp(value.last_active)
    || !isNonNegativeSafeInteger(value.total_input_tokens)
    || !isNonNegativeSafeInteger(value.total_output_tokens)
    || !isNonNegativeSafeInteger(value.total_cache_read)
    || !isNonNegativeFinite(value.total_cost)
    || !Array.isArray(models)
    || !isNonNegativeSafeInteger(value.message_count)
    || !isNonNegativeFinite(value.duration_minutes)
    || !isNullableString(value.title)
    || !isNullableString(value.task_category)
    || !isNullableString(value.description)
    || !isNullableString(value.complexity)
    || !isNullableString(value.task_group)
    || !isNullableString(value.summarized_at)
    || !isNullableString(value.fm_version)
  ) return null;

  return {
    sessionId: value.session_id,
    client: sanitizeClient(value.client),
    workspace: typeof value.workspace === "string" ? value.workspace : null,
    workspaceLabel: typeof value.workspace_label === "string" ? value.workspace_label : null,
    createdAt: value.created_at,
    lastActive: value.last_active,
    input: value.total_input_tokens,
    output: value.total_output_tokens,
    cacheRead: value.total_cache_read,
    costUsd: value.total_cost,
    models: sanitizeModels(models),
    messages: value.message_count,
    durationMinutes: value.duration_minutes,
  };
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
  const models = sanitizeModels(typeof value.model === "string" ? [value.model] : []);
  if (
    models.length !== 1
    || !isNonNegativeSafeInteger(value.input)
    || !isNonNegativeSafeInteger(value.output)
    || !isNonNegativeSafeInteger(value.cacheRead)
    || !isNonNegativeFinite(value.cost)
    || !isNonNegativeSafeInteger(value.messageCount)
  ) return null;
  return {
    modelId: models[0]!,
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
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
