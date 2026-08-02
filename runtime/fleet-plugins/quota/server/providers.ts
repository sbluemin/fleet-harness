import { KIMI_AUTH_PROVIDER_ID, KIMI_CODE_API_BASE_URL } from "@dotobokuri/core-ai-gateway";
import { createAuthService, DEFAULT_AUTH_PATH, type AuthService } from "@dotobokuri/core-infra";

import {
  defaultCredentialDeps,
  resolveClaudeCredentials,
  resolveCodexCredentials,
  resolveCursorCredentials,
  type CredentialResolverDeps,
} from "./credentials.js";
import type { ProviderDto, ProviderResult, QuotaWindow, ResetCredits, WindowId } from "./types.js";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 262_144;
const MAX_WINDOWS = 8;
const MAX_CREDIT_ENTRIES = 256;

export interface ProviderDeps {
  readonly credentials?: CredentialResolverDeps;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /**
   * Kimi is reached with the key Fleet itself stores, not another CLI's
   * credential file, so it reads through core-infra's auth surface — which owns
   * the file's shape and its symlink-guarded read — instead of parsing the file here.
   */
  readonly authService?: AuthService;
}

let sharedAuthService: AuthService | undefined;

function authServiceFor(deps: ProviderDeps): AuthService {
  return deps.authService ?? (sharedAuthService ??= createAuthService({ authPath: DEFAULT_AUTH_PATH }));
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
    const trimmed = value.trim();
    if (/^[1-9]\d{9,14}$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) result = parsed < 1e12 ? parsed * 1_000 : parsed;
    } else {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) result = parsed;
    }
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
  if (!pattern.test(trimmed)) return undefined;
  if (/^bearer /i.test(trimmed)) return undefined;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return undefined;
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(trimmed)) return undefined;
  return trimmed;
}

function titleCase(value: unknown): string | undefined {
  const validated = validatedString(value, /^[A-Za-z0-9][A-Za-z0-9 .+-]{0,23}$/);
  if (!validated) return undefined;
  // Plan labels deliberately exclude money, so a bare number must never enter the DTO.
  if (/^\d+$/.test(validated)) return undefined;
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

export function parseCursorUsage(payload: unknown):
  | { readonly status: "ok"; readonly windows: readonly QuotaWindow[]; readonly cycleDays?: number }
  | { readonly status: "no_subscription" } {
  const root = object(payload);
  const planUsage = object(root?.planUsage);
  if (root?.enabled === false || !planUsage) return { status: "no_subscription" };
  const resetsAt = safeTimestamp(root?.billingCycleEnd);
  const windows: QuotaWindow[] = [];
  // Cursor bills one subscription through two pools. The scope-less window is
  // their sum: a caller picking an API-tier model must read the `api` window,
  // because the total can sit well below the pool that model actually draws from.
  for (const [value, scope, label] of [
    [planUsage.totalPercentUsed, undefined, undefined],
    [planUsage.autoPercentUsed, "auto", "Auto"],
    [planUsage.apiPercentUsed, "api", "API"],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    windows.push({
      id: "cycle",
      ...(scope ? { scope } : {}),
      ...(label ? { label } : {}),
      usedPercent: percent(value),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  }
  if (windows.length === 0) return { status: "no_subscription" };
  const cycleStart = safeTimestamp(root?.billingCycleStart);
  const cycleEnd = safeTimestamp(root?.billingCycleEnd);
  let cycleDays: number | undefined;
  if (cycleStart !== undefined && cycleEnd !== undefined && cycleEnd > cycleStart) {
    const days = Math.round((cycleEnd - cycleStart) / 86_400_000);
    if (days >= 1 && days <= 400) cycleDays = days;
  }
  return {
    status: "ok",
    windows,
    ...(cycleDays !== undefined ? { cycleDays } : {}),
  };
}

// Kimi reports every quantity as a decimal string ("100", "47"). `percent()`
// takes numbers only and answers 0 for anything else, so a raw field reaching it
// would silently render a full allowance as untouched.
function numeric(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^\d{1,15}$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const KIMI_TIME_UNIT_MINUTES: Readonly<Record<string, number>> = {
  TIME_UNIT_MINUTE: 1,
  TIME_UNIT_HOUR: 60,
  TIME_UNIT_DAY: 1_440,
};

// Only durations that land exactly on a Fleet window are mapped. An unrecognized
// unit or an off-grid duration is skipped rather than rounded to the nearest
// window: labelling an hourly allowance `session` would misreport it as the 5h one.
const KIMI_WINDOW_BY_MINUTES: Readonly<Record<number, WindowId>> = {
  300: "session",
  10_080: "weekly",
};

function kimiWindow(id: WindowId, detail: unknown): QuotaWindow | null {
  const row = object(detail);
  if (!row) return null;
  const limit = numeric(row.limit);
  if (limit === undefined || limit <= 0) return null;
  const remaining = numeric(row.remaining);
  const used = numeric(row.used) ?? (remaining === undefined ? undefined : limit - remaining);
  if (used === undefined) return null;
  const resetsAt = safeTimestamp(row.resetTime ?? row.resetAt);
  return {
    id,
    usedPercent: percent((used / limit) * 100),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

// `LEVEL_ADVANCED` / `TYPE_PURCHASE` carry an underscore, which the shared plan
// validator rejects; strip the enum prefix before it is offered as a label.
function kimiPlan(payload: Record<string, unknown>): string | undefined {
  const level = object(object(payload.user)?.membership)?.level;
  for (const candidate of [level, payload.subType]) {
    if (typeof candidate !== "string") continue;
    const bare = candidate.slice(candidate.indexOf("_") + 1).toLowerCase();
    const plan = titleCase(bare);
    if (plan) return plan;
  }
  return undefined;
}

export function parseKimiUsage(payload: unknown):
  | { readonly status: "ok"; readonly windows: readonly QuotaWindow[]; readonly plan?: string }
  | { readonly status: "no_subscription" } {
  const root = object(payload);
  if (!root) return { status: "no_subscription" };
  const windows: QuotaWindow[] = [];
  // The top-level block declares no duration anywhere in the payload, so it is
  // reported as the renewal cycle rather than asserting a length it never states.
  const cycle = kimiWindow("cycle", root.usage);
  if (cycle) windows.push(cycle);
  const limits = array(root.limits);
  for (let index = 0; index < limits.length && windows.length < MAX_WINDOWS; index += 1) {
    const entry = object(limits[index]);
    const frame = object(entry?.window);
    const duration = numeric(frame?.duration);
    const unit = typeof frame?.timeUnit === "string" ? KIMI_TIME_UNIT_MINUTES[frame.timeUnit] : undefined;
    if (duration === undefined || unit === undefined) continue;
    const id = KIMI_WINDOW_BY_MINUTES[duration * unit];
    if (!id || windows.some((window) => window.id === id)) continue;
    const window = kimiWindow(id, entry?.detail);
    if (window) windows.push(window);
  }
  if (windows.length === 0) return { status: "no_subscription" };
  const plan = kimiPlan(root);
  return { status: "ok", windows, ...(plan ? { plan } : {}) };
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

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      ...init,
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

async function getJson(fetchImpl: typeof fetch, url: string, headers: HeadersInit): Promise<unknown> {
  return requestJson(fetchImpl, url, { method: "GET", headers });
}

async function postJson(fetchImpl: typeof fetch, url: string, headers: HeadersInit): Promise<unknown> {
  return requestJson(fetchImpl, url, { method: "POST", headers, body: "{}" });
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

export async function fetchCursorUsage(deps: ProviderDeps = {}): Promise<ProviderResult> {
  const credentials = await resolveCursorCredentials(deps.credentials ?? defaultCredentialDeps);
  if (!credentials) return { status: "signed_out" };
  const headers = {
    Authorization: `Bearer ${credentials.accessToken}`,
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
  };
  try {
    const fetchImpl = deps.fetch ?? fetch;
    const usage = parseCursorUsage(await postJson(
      fetchImpl,
      "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
      headers,
    ));
    if (usage.status === "no_subscription") return { status: "no_subscription", method: credentials.method };
    let plan: string | undefined;
    try {
      const planRoot = object(await postJson(
        fetchImpl,
        "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo",
        headers,
      ));
      // 응답은 planName을 planInfo 아래에 중첩해 돌려준다. 루트 읽기는 과거 스키마 대비 폴백이다.
      plan = titleCase(object(planRoot?.planInfo)?.planName ?? planRoot?.planName);
    } catch {
      // Plan metadata is display-only; its failure must not sink the usage snapshot.
      plan = undefined;
    }
    return {
      status: "ok",
      method: credentials.method,
      ...(plan ? { plan } : {}),
      ...(usage.cycleDays !== undefined ? { cycleDays: usage.cycleDays } : {}),
      windows: usage.windows,
      fetchedAt: (deps.now ?? Date.now)(),
    };
  } catch (error) {
    const result = expired(error);
    if (result) return { ...result, method: credentials.method };
    throw error;
  }
}

export async function fetchKimiUsage(deps: ProviderDeps = {}): Promise<ProviderResult> {
  const apiKey = await authServiceFor(deps).getApiKey(KIMI_AUTH_PROVIDER_ID);
  if (!apiKey) return { status: "signed_out" };
  try {
    const usage = parseKimiUsage(await getJson(
      deps.fetch ?? fetch,
      `${KIMI_CODE_API_BASE_URL}/v1/usages`,
      { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    ));
    if (usage.status === "no_subscription") return { status: "no_subscription" };
    return {
      status: "ok",
      ...(usage.plan ? { plan: usage.plan } : {}),
      windows: usage.windows,
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
