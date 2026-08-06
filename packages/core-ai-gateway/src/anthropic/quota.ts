import { defaultCredentialDeps } from "../transport/credentials.js";
import type {
  ProviderResult,
  QuotaWindow,
} from "../quota/types.js";
import {
  HOUR_MS,
  MAX_CREDIT_ENTRIES,
  MAX_WINDOWS,
  WEEK_MS,
  array,
  expired,
  getJson,
  modelLabel,
  object,
  percent,
  safeTimestamp,
  titleCase,
  windowPeriod,
  type ProviderDeps,
} from "../quota/windows.js";
import { resolveClaudeCredentials } from "./credentials.js";

// Claude states its window lengths only as block names (`five_hour`,
// `seven_day`), never as numbers, so these are product knowledge and ship with
// `durationBasis: "catalog"` — visibly an assumption that can go stale.
export const CLAUDE_SESSION_MS = 5 * HOUR_MS;

function firstClaudePercent(row: Record<string, unknown>): number | undefined {
  for (const key of ["percent", "used_percentage", "utilization"] as const) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return percent(value);
  }
  return undefined;
}

function claudeWindow(
  id: QuotaWindow["id"],
  source: unknown,
  durationMs: number,
  label?: string,
): QuotaWindow | null {
  const row = object(source);
  if (!row) return null;
  const usedPercent = firstClaudePercent(row);
  if (usedPercent === undefined) return null;
  const resetsAt = safeTimestamp(row.resets_at);
  const period = windowPeriod(durationMs, "catalog", resetsAt);
  return {
    id,
    ...(label ? { label } : {}),
    usedPercent,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(period ? { period } : {}),
  };
}

export function parseClaudeUsage(payload: unknown): { readonly windows: readonly QuotaWindow[] } {
  const root = object(payload) ?? {};
  const namedSession = claudeWindow("session", root.five_hour, CLAUDE_SESSION_MS);
  const namedWeekly = claudeWindow("weekly", root.seven_day, WEEK_MS);
  let fallbackSession: QuotaWindow | null = null;
  let fallbackWeekly: QuotaWindow | null = null;
  const modelWindows: QuotaWindow[] = [];
  const limits = array(root.limits);
  for (
    let index = 0;
    index < limits.length && index < MAX_CREDIT_ENTRIES;
    index += 1
  ) {
    const item = limits[index];
    const limit = object(item);
    if (!limit) continue;
    if (limit.kind === "session" && !namedSession && !fallbackSession) {
      fallbackSession = claudeWindow("session", limit, CLAUDE_SESSION_MS);
      continue;
    }
    if (limit.kind === "weekly_all" && !namedWeekly && !fallbackWeekly) {
      fallbackWeekly = claudeWindow("weekly", limit, WEEK_MS);
      continue;
    }
    if (limit.kind === "weekly_scoped" && modelWindows.length < MAX_WINDOWS) {
      const model = object(object(limit.scope)?.model);
      const row = claudeWindow("model", limit, WEEK_MS, modelLabel(model?.display_name));
      if (row) modelWindows.push(row);
    }
  }
  if (modelWindows.length === 0) {
    for (const alias of [root.fable_weekly, root.fable_seven_day, root.seven_day_fable]) {
      const row = claudeWindow("model", alias, WEEK_MS, "Fable");
      if (row) {
        modelWindows.push(row);
        break;
      }
    }
  }
  const windows: QuotaWindow[] = [];
  for (const row of [namedSession ?? fallbackSession, namedWeekly ?? fallbackWeekly, ...modelWindows]) {
    if (row) windows.push(row);
    if (windows.length === MAX_WINDOWS) break;
  }
  return { windows };
}

export async function fetchClaudeUsage(deps: ProviderDeps = {}): Promise<ProviderResult> {
  const credentials = await resolveClaudeCredentials(deps.credentials ?? defaultCredentialDeps);
  if (!credentials) return { status: "signed_out" };
  if (credentials.expiresAt !== undefined && credentials.expiresAt <= (deps.now ?? Date.now)()) {
    return { status: "expired", method: credentials.method };
  }
  try {
    const parsed = parseClaudeUsage(await getJson(
      deps.fetch ?? fetch,
      "https://api.anthropic.com/api/oauth/usage",
      {
        Authorization: `Bearer ${credentials.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.1.0",
      },
    ));
    return {
      status: "ok",
      method: credentials.method,
      plan: titleCase(credentials.subscriptionType),
      windows: parsed.windows,
      fetchedAt: (deps.now ?? Date.now)(),
    };
  } catch (error) {
    const result = expired(error);
    if (result) return { ...result, method: credentials.method };
    throw error;
  }
}
