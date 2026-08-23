import { KIMI_AUTH_PROVIDER_ID, KIMI_CODE_API_BASE_URL } from "../../models.js";
import type { ProviderResult, QuotaWindow, WindowDurationBasis, WindowId } from "../../quota/types.js";
import {
  MAX_CREDIT_ENTRIES,
  MAX_WINDOWS,
  WEEK_MS,
  array,
  expired,
  getJson,
  object,
  percent,
  safeTimestamp,
  titleCase,
  windowPeriod,
  type ProviderDeps,
} from "../../quota/windows.js";

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

export async function fetchKimiUsage(deps: ProviderDeps = {}): Promise<ProviderResult> {
  if (deps.authService === undefined) {
    throw new Error("authService is required to probe Kimi usage; pass it via createAiGatewayQuotaCollectors");
  }
  const apiKey = await deps.authService.getApiKey(KIMI_AUTH_PROVIDER_ID);
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
