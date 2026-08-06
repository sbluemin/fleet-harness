import {
  KIMI_AUTH_PROVIDER_ID,
  KIMI_CODE_API_BASE_URL,
  OPENCODE_AUTH_PROVIDER_ID,
} from "@dotobokuri/core-ai-gateway";
import { createAuthService, DEFAULT_AUTH_PATH, type AuthService } from "@dotobokuri/core-infra";

import {
  defaultCredentialDeps,
  resolveClaudeCredentials,
  resolveCodexCredentials,
  resolveCursorCredentials,
  type CredentialResolverDeps,
} from "./credentials.js";
import { scanOpencodeGoWindows, type OpencodeGoWindowsResult } from "./opencode-usage.js";
import type {
  ProviderDto,
  ProviderResult,
  QuotaWindow,
  QuotaWindowPeriod,
  ResetCredits,
  WindowDurationBasis,
  WindowId,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 262_144;
const MAX_WINDOWS = 8;
const MAX_CREDIT_ENTRIES = 256;
const TLS_CERT_ERROR_CODES: ReadonlySet<string> = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
]);

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;
// Claude states its window lengths only as block names (`five_hour`,
// `seven_day`), never as numbers, so these are product knowledge and ship with
// `durationBasis: "catalog"` — visibly an assumption that can go stale.
const CLAUDE_SESSION_MS = 5 * HOUR_MS;
const MAX_WINDOW_DURATION_MS = 400 * 24 * HOUR_MS;

function windowPeriod(
  durationMs: number,
  durationBasis: WindowDurationBasis,
  resetsAt?: number,
): QuotaWindowPeriod | undefined {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_WINDOW_DURATION_MS) return undefined;
  const rounded = Math.round(durationMs);
  // A fixed contiguous window starts one duration before it resets; the
  // `derived` tag keeps that assumption visible instead of passing it off as
  // an observed start.
  const startsAt = resetsAt !== undefined && resetsAt > rounded ? resetsAt - rounded : undefined;
  return {
    durationMs: rounded,
    durationBasis,
    ...(startsAt !== undefined ? { startsAt, startsAtBasis: "derived" as const } : {}),
  };
}

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
  /** 테스트가 opencode 로컬 사용량 스캔을 대체한다. */
  readonly scanOpencodeGoWindows?: () => Promise<OpencodeGoWindowsResult | null>;
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

function findCauseCode(error: unknown): string | undefined {
  let current: unknown = error;
  const seen = new Set<object>();
  for (let depth = 0; depth <= 4; depth += 1) {
    if (current === null || typeof current !== "object") return undefined;
    if (seen.has(current)) return undefined;
    seen.add(current);
    if (Object.prototype.hasOwnProperty.call(current, "code")) {
      const code = (current as Record<string, unknown>).code;
      if (typeof code === "string") return code;
    }
    current = (current as Record<string, unknown>).cause;
  }
  return undefined;
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

function codexWindow(source: unknown, fallbackId: "session" | "weekly"): QuotaWindow | null {
  const row = object(source);
  if (!row) return null;
  const seconds = typeof row.limit_window_seconds === "number" && Number.isFinite(row.limit_window_seconds)
    ? row.limit_window_seconds
    : 0;
  const minutes = seconds / 60;
  const id = minutes >= 240 && minutes <= 360
    ? "session"
    : minutes >= 8_064 && minutes <= 12_096 ? "weekly" : fallbackId;
  const resetsAt = safeTimestamp(row.reset_at);
  // The upstream states the window length itself, so it ships as `upstream`.
  const period = seconds > 0 ? windowPeriod(seconds * 1_000, "upstream", resetsAt) : undefined;
  return {
    id,
    usedPercent: percent(row.used_percent),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(period ? { period } : {}),
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
  const cycleStart = safeTimestamp(root?.billingCycleStart);
  let cycleDays: number | undefined;
  let period: QuotaWindowPeriod | undefined;
  if (cycleStart !== undefined && resetsAt !== undefined && resetsAt > cycleStart) {
    const days = Math.round((resetsAt - cycleStart) / 86_400_000);
    if (days >= 1 && days <= 400) {
      cycleDays = days;
      // Both boundaries are upstream facts, so the month-length variation of a
      // billing cycle is preserved rather than approximated by a constant.
      period = {
        durationMs: resetsAt - cycleStart,
        durationBasis: "upstream",
        startsAt: cycleStart,
        startsAtBasis: "upstream",
      };
    }
  }
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
      ...(period ? { period } : {}),
    });
  }
  if (windows.length === 0) return { status: "no_subscription" };
  // Saying in-band that the scope-less figure sums the pools keeps headroom
  // math from counting the same allowance twice. A scope-less window with no
  // scoped sibling is the whole allowance, not a sum, so it stays untagged.
  const taggedWindows = windows.some((window) => window.scope !== undefined)
    ? windows.map((window) => window.scope === undefined ? { ...window, isAggregate: true as const } : window)
    : windows;
  return {
    status: "ok",
    windows: taggedWindows,
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

function kimiWindow(
  id: WindowId,
  detail: unknown,
  duration?: { readonly ms: number; readonly basis: WindowDurationBasis },
): QuotaWindow | null {
  const row = object(detail);
  if (!row) return null;
  const limit = numeric(row.limit);
  if (limit === undefined || limit <= 0) return null;
  const remaining = numeric(row.remaining);
  const used = numeric(row.used) ?? (remaining === undefined ? undefined : limit - remaining);
  if (used === undefined) return null;
  const resetsAt = safeTimestamp(row.resetTime ?? row.resetAt);
  const period = duration ? windowPeriod(duration.ms, duration.basis, resetsAt) : undefined;
  return {
    id,
    usedPercent: percent((used / limit) * 100),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(period ? { period } : {}),
    // Kimi quantifies in plain counts, never money, so the absolute figures may
    // ship; they are what lets a consumer size one more run against the bucket.
    amounts: { used: String(Math.max(0, used)), limit: String(limit) },
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
  // The top-level block declares no duration anywhere in the payload. Fleet's
  // product knowledge says the renewal cycle is the weekly total, so the length
  // ships tagged `catalog` — visibly an assumption, never an upstream fact.
  const cycle = kimiWindow("cycle", root.usage, { ms: WEEK_MS, basis: "catalog" });
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
    const window = kimiWindow(id, entry?.detail, { ms: duration * unit * 60_000, basis: "upstream" });
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

/**
 * OpenCode Go는 API 키로 접근 가능한 사용량 엔드포인트를 노출하지 않는다(2026-08-03
 * 확정 — `/zen/go/v1` 라우트 소스의 표면은 models/messages/responses/chat뿐이고 usage
 * 후보 경로는 전부 SPA 폴백). 따라서 OpenUsage와 같은 방식으로 opencode CLI의 로컬
 * SQLite 로그에서 관측 스펜딩을 합산해 플랜 캡 대비 창을 만든다(opencode-usage.ts).
 * 로컬 데이터가 없거나 읽기 실패하면 창 없는 ok로 강등하고, 클라이언트가 그 상태를
 * 안내로 그린다. 가짜 창은 합성하지 않는다.
 */
export async function fetchOpencodeUsage(deps: ProviderDeps = {}): Promise<ProviderResult> {
  const apiKey = await authServiceFor(deps).getApiKey(OPENCODE_AUTH_PROVIDER_ID);
  if (!apiKey) return { status: "signed_out" };
  const now = deps.now ?? Date.now;
  try {
    const scan = await (deps.scanOpencodeGoWindows ?? (() => scanOpencodeGoWindows({ now })))();
    if (scan !== null) {
      return {
        status: "ok",
        plan: "Go",
        cycleDays: scan.cycleDays,
        windows: scan.windows,
        fetchedAt: now(),
      };
    }
  } catch {
    // DB가 존재하는데 읽지 못했다 — 0 사용량으로 오독하느니 창 없는 상태로 강등한다.
  }
  return {
    status: "ok",
    plan: "Go",
    windows: [],
    fetchedAt: now(),
  };
}

export function sanitizeProviderError(error: unknown): string {
  if (error instanceof ProviderResponseTooLargeError) return "Provider response too large";
  if (error instanceof DOMException && error.name === "AbortError") return "Provider request timed out";
  if (error instanceof ProviderHttpError && error.statusCode !== undefined) {
    return `Provider request failed (${error.statusCode})`;
  }
  // TLS 검사 프록시 등 인증서 검증 실패는 원인 코드를 남긴다 — 일반화하면 사용자가 원인을 찾을 수 없다(issue #531).
  const causeCode = findCauseCode(error);
  if (causeCode !== undefined && TLS_CERT_ERROR_CODES.has(causeCode)) {
    return `Certificate verification failed (${causeCode})`;
  }
  return "Provider request failed";
}
