import {
  defaultCredentialDeps,
  resolveClaudeCredentials,
  resolveCodexCredentials,
  type CredentialResolverDeps,
} from "./credentials.js";
import type { ProviderDto, ProviderResult, QuotaWindow, ResetCredits } from "./types.js";

const REQUEST_TIMEOUT_MS = 10_000;

export interface ProviderDeps {
  readonly credentials?: CredentialResolverDeps;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

class ProviderHttpError extends Error {
  constructor(readonly statusCode: number) {
    super(`Provider request failed (${statusCode})`);
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function safeTimestamp(value: unknown): number | undefined {
  let result: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) result = value < 1e12 ? value * 1_000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) result = parsed;
  }
  if (result === undefined || !Number.isFinite(result) || result < 0) return undefined;
  const rounded = Math.round(result);
  return Number.isSafeInteger(rounded) ? rounded : undefined;
}

function percent(value: unknown, fractionAware = false): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const normalized = fractionAware && value > 0 && value <= 1 ? value * 100 : value;
  return Math.min(100, Math.max(0, Math.round(normalized)));
}

function titleCase(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const capped = value.slice(0, 80);
  return `${capped[0]?.toUpperCase() ?? ""}${capped.slice(1)}`;
}

function claudeWindow(id: QuotaWindow["id"], source: unknown, label?: string): QuotaWindow | null {
  const row = object(source);
  if (!row) return null;
  return {
    id,
    ...(label ? { label: label.slice(0, 80) } : {}),
    usedPercent: row.used_percentage !== undefined
      ? percent(row.used_percentage)
      : percent(row.utilization, true),
    ...(safeTimestamp(row.resets_at) !== undefined ? { resetsAt: safeTimestamp(row.resets_at) } : {}),
  };
}

export function parseClaudeUsage(payload: unknown): { readonly windows: readonly QuotaWindow[] } {
  const root = object(payload) ?? {};
  const windows: QuotaWindow[] = [];
  const session = claudeWindow("session", root.five_hour);
  const weekly = claudeWindow("weekly", root.seven_day);
  if (session) windows.push(session);
  if (weekly) windows.push(weekly);
  for (const item of array(root.limits)) {
    const limit = object(item);
    if (limit?.kind !== "weekly_scoped") continue;
    const model = object(object(limit.scope)?.model);
    const label = typeof model?.display_name === "string" ? model.display_name : "Model";
    const row = claudeWindow("model", limit, label);
    if (row) windows.push(row);
  }
  if (!windows.some((row) => row.id === "model")) {
    const fallback = root.fable_weekly ?? root.fable_seven_day ?? root.seven_day_fable;
    const row = claudeWindow("model", fallback, "Fable");
    if (row) windows.push(row);
  }
  return { windows };
}

function codexWindow(source: unknown, fallbackId: "session" | "weekly"): QuotaWindow | null {
  const row = object(source);
  if (!row) return null;
  const seconds = typeof row.limit_window_seconds === "number" ? row.limit_window_seconds : 0;
  const minutes = seconds / 60;
  const id = minutes >= 240 && minutes <= 360
    ? "session"
    : minutes >= 8_064 && minutes <= 12_096 ? "weekly" : fallbackId;
  return {
    id,
    usedPercent: percent(row.used_percent),
    ...(safeTimestamp(row.reset_at) !== undefined ? { resetsAt: safeTimestamp(row.reset_at) } : {}),
  };
}

export function parseCodexUsage(payload: unknown): { readonly windows: readonly QuotaWindow[]; readonly plan?: string } {
  const root = object(payload) ?? {};
  const rateLimit = object(root.rate_limit) ?? {};
  return {
    windows: [
      codexWindow(rateLimit.primary_window, "session"),
      codexWindow(rateLimit.secondary_window, "weekly"),
    ].filter((row): row is QuotaWindow => row !== null),
    plan: titleCase(root.plan_type),
  };
}

export function parseResetCredits(payload: unknown): ResetCredits | undefined {
  const root = object(payload);
  if (!root || !Number.isSafeInteger(root.available_count) || (root.available_count as number) < 0) return undefined;
  const expiries = array(root.credits)
    .map(object)
    .filter((credit): credit is Record<string, unknown> => credit?.status === "available")
    .map((credit) => safeTimestamp(credit.expires_at))
    .filter((value): value is number => value !== undefined);
  return {
    available: root.available_count as number,
    ...(expiries.length > 0 ? { nextExpiresAt: Math.min(...expiries) } : {}),
  };
}

async function getJson(fetchImpl: typeof fetch, url: string, headers: HeadersInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
    if (!response.ok) throw new ProviderHttpError(response.status);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function expired(error: unknown): ProviderDto | null {
  return error instanceof ProviderHttpError && (error.statusCode === 401 || error.statusCode === 403)
    ? { status: "expired" }
    : null;
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

export async function fetchCodexUsage(deps: ProviderDeps = {}): Promise<ProviderResult> {
  const credentials = await resolveCodexCredentials(deps.credentials ?? defaultCredentialDeps);
  if (!credentials) return { status: "signed_out" };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.accessToken}`,
    "User-Agent": "codex-cli",
    "OpenAI-Beta": "codex-1",
    originator: "Codex Desktop",
  };
  if (credentials.accountId) headers["ChatGPT-Account-Id"] = credentials.accountId;
  try {
    const fetchImpl = deps.fetch ?? fetch;
    const usage = parseCodexUsage(await getJson(fetchImpl, "https://chatgpt.com/backend-api/wham/usage", headers));
    const credits = parseResetCredits(await getJson(
      fetchImpl,
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
      headers,
    ));
    return {
      status: "ok",
      plan: usage.plan,
      windows: usage.windows,
      ...(credits ? { credits } : {}),
      fetchedAt: (deps.now ?? Date.now)(),
    };
  } catch (error) {
    const result = expired(error);
    if (result) return result;
    throw error;
  }
}

export function sanitizeProviderError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "Provider request timed out";
  if (error instanceof ProviderHttpError) return `Provider request failed (${error.statusCode})`;
  return "Provider request failed";
}
