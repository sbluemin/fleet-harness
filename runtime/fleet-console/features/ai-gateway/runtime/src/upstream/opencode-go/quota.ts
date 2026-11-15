import { OPENCODE_AUTH_PROVIDER_ID, OPENCODE_GO_USAGE_URL, OPENCODE_GO_USER_AGENT } from "./coordinates.js";
import type { AuthService } from "../../auth/types.js";
import type { ProviderResult, QuotaWindow, WindowId } from "../../quota/types.js";
import {
  HOUR_MS,
  WEEK_MS,
  expired,
  getJson,
  object,
  percent,
  providerHttpStatus,
  safeTimestamp,
  windowPeriod,
  type ProviderDeps,
} from "../../quota/windows.js";

// OpenCode names the windows (`rolling` / `weekly` / `monthly`) but never states
// their lengths. These match the product (5h session, Monday-UTC week, ~30d
// billing cycle) and ship as `catalog` — the same assumption OpenUsage attaches.
export const OPENCODE_SESSION_MS = 5 * HOUR_MS;
export const OPENCODE_MONTH_MS = 30 * 24 * HOUR_MS;

const WINDOWS: ReadonlyArray<{
  readonly field: "rolling" | "weekly" | "monthly";
  readonly id: WindowId;
  readonly durationMs: number;
}> = [
  { field: "rolling", id: "session", durationMs: OPENCODE_SESSION_MS },
  { field: "weekly", id: "weekly", durationMs: WEEK_MS },
  { field: "monthly", id: "cycle", durationMs: OPENCODE_MONTH_MS },
];

function windowPercent(row: Record<string, unknown>): number | undefined {
  const value = row.percent;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return percent(value);
}

/**
 * Decode `GET /inference/go/v1/usage`. A 200 always carries all three windows when the
 * key has Go; a missing or unquantifiable window is schema drift, not an empty
 * plan (that arrives as HTTP 403). `null` refuses to invent meters.
 */
export function parseOpencodeUsage(payload: unknown): {
  readonly windows: readonly QuotaWindow[];
  readonly cycleDays: number;
} | null {
  const usage = object(object(payload)?.usage);
  if (!usage) return null;
  const windows: QuotaWindow[] = [];
  for (const spec of WINDOWS) {
    const row = object(usage[spec.field]);
    if (!row) return null;
    const usedPercent = windowPercent(row);
    if (usedPercent === undefined) return null;
    const resetsAt = safeTimestamp(row.resetsAt);
    const period = windowPeriod(spec.durationMs, "catalog", resetsAt);
    windows.push({
      id: spec.id,
      usedPercent,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(period ? { period } : {}),
    });
  }
  return {
    windows,
    cycleDays: Math.round(OPENCODE_MONTH_MS / 86_400_000),
  };
}

/**
 * OpenCode Go is reached with a key Fleet itself stores, not another CLI's credential file, so
 * it reads through the injected auth service — which owns the file's shape and its guarded read.
 */
export async function fetchOpencodeUsage(
  deps: Omit<ProviderDeps, "credentials"> & { readonly authService: Pick<AuthService, "getApiKey"> },
): Promise<ProviderResult> {
  const apiKey = await deps.authService.getApiKey(OPENCODE_AUTH_PROVIDER_ID);
  if (!apiKey) return { status: "signed_out" };
  try {
    const usage = parseOpencodeUsage(await getJson(
      deps.fetch ?? fetch,
      OPENCODE_GO_USAGE_URL,
      { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "User-Agent": OPENCODE_GO_USER_AGENT },
    ));
    if (!usage) throw new Error("Provider response invalid");
    return {
      status: "ok",
      plan: "Go",
      cycleDays: usage.cycleDays,
      windows: usage.windows,
      fetchedAt: (deps.now ?? Date.now)(),
    };
  } catch (error) {
    // 403 is a valid key with no Go plan (`EntitlementError`). 401 is a rejected
    // key. `expired()` folds both into expired, so 403 is peeled off first.
    if (providerHttpStatus(error) === 403) return { status: "no_subscription" };
    const result = expired(error);
    if (result) return result;
    throw error;
  }
}
