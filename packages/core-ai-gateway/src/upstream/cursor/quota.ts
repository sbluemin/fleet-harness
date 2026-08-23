import { defaultCredentialDeps } from "../../transport/credentials.js";
import type { ProviderResult, QuotaWindow, QuotaWindowPeriod } from "../../quota/types.js";
import {
  expired,
  object,
  percent,
  postJson,
  safeTimestamp,
  titleCase,
  windowPeriod,
  type ProviderDeps,
} from "../../quota/windows.js";
import { resolveCursorCredentials } from "./credentials.js";

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
