import {
  defaultCredentialDeps,
  resolveClaudeCredentials,
  resolveCodexCredentials,
  type CredentialResolverDeps,
} from "./credentials.js";
import type { ProviderDto, ProviderResult, QuotaWindow, ResetCredits } from "./types.js";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 262_144;
const MAX_WINDOWS = 8;
const MAX_CREDIT_ENTRIES = 256;

export interface ProviderDeps {
  readonly credentials?: CredentialResolverDeps;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

class ProviderHttpError extends Error {
  constructor(readonly statusCode?: number) {
    super(statusCode === undefined ? "Provider request failed" : `Provider request failed (${statusCode})`);
  }
}

class ProviderResponseTooLargeError extends Error {
  constructor() {
    super("Provider response too large");
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

function percent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function validatedString(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return pattern.test(trimmed) ? trimmed : undefined;
}

function titleCase(value: unknown): string | undefined {
  const validated = validatedString(value, /^[A-Za-z0-9][A-Za-z0-9 .+-]{0,23}$/);
  if (!validated) return undefined;
  return `${validated[0]?.toUpperCase() ?? ""}${validated.slice(1)}`;
}

function modelLabel(value: unknown): string {
  return validatedString(value, /^[A-Za-z0-9][A-Za-z0-9 .+-]{0,39}$/) ?? "Model";
}

function firstClaudePercent(row: Record<string, unknown>): number | undefined {
  for (const key of ["percent", "used_percentage", "utilization"] as const) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return percent(value);
  }
  return undefined;
}

function claudeWindow(id: QuotaWindow["id"], source: unknown, label?: string): QuotaWindow | null {
  const row = object(source);
  if (!row) return null;
  const usedPercent = firstClaudePercent(row);
  if (usedPercent === undefined) return null;
  const resetsAt = safeTimestamp(row.resets_at);
  return {
    id,
    ...(label ? { label } : {}),
    usedPercent,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

export function parseClaudeUsage(payload: unknown): { readonly windows: readonly QuotaWindow[] } {
  const root = object(payload) ?? {};
  const namedSession = claudeWindow("session", root.five_hour);
  const namedWeekly = claudeWindow("weekly", root.seven_day);
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
      fallbackSession = claudeWindow("session", limit);
      continue;
    }
    if (limit.kind === "weekly_all" && !namedWeekly && !fallbackWeekly) {
      fallbackWeekly = claudeWindow("weekly", limit);
      continue;
    }
    if (limit.kind === "weekly_scoped" && modelWindows.length < MAX_WINDOWS) {
      const model = object(object(limit.scope)?.model);
      const row = claudeWindow("model", limit, modelLabel(model?.display_name));
      if (row) modelWindows.push(row);
    }
  }
  if (modelWindows.length === 0) {
    for (const alias of [root.fable_weekly, root.fable_seven_day, root.seven_day_fable]) {
      const row = claudeWindow("model", alias, "Fable");
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
  const credits = array(root.credits);
  let nextExpiresAt: number | undefined;
  for (let index = 0; index < credits.length && index < MAX_CREDIT_ENTRIES; index += 1) {
    const credit = object(credits[index]);
    if (credit?.status !== "available") continue;
    const expiry = safeTimestamp(credit.expires_at);
    if (expiry !== undefined && (nextExpiresAt === undefined || expiry < nextExpiresAt)) {
      nextExpiresAt = expiry;
    }
  }
  return {
    available: root.available_count as number,
    ...(nextExpiresAt !== undefined ? { nextExpiresAt } : {}),
  };
}

async function getJson(fetchImpl: typeof fetch, url: string, headers: HeadersInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: controller.signal,
      redirect: "error",
    });
    if (response.url !== "" && response.url !== url) throw new ProviderHttpError();
    if (!response.ok) throw new ProviderHttpError(response.status);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      controller.abort();
      throw new ProviderResponseTooLargeError();
    }
    if (!response.body) {
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        controller.abort();
        throw new ProviderResponseTooLargeError();
      }
      return JSON.parse(text);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        controller.abort();
        throw new ProviderResponseTooLargeError();
      }
      chunks.push(value);
    }
    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(body));
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
    let credits: ResetCredits | undefined;
    try {
      credits = parseResetCredits(await getJson(
        fetchImpl,
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
        headers,
      ));
    } catch {
      // Credits are a display-only extra; their failure must not sink the usage snapshot.
      credits = undefined;
    }
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
  if (error instanceof ProviderResponseTooLargeError) return "Provider response too large";
  if (error instanceof DOMException && error.name === "AbortError") return "Provider request timed out";
  if (error instanceof ProviderHttpError && error.statusCode !== undefined) {
    return `Provider request failed (${error.statusCode})`;
  }
  return "Provider request failed";
}
