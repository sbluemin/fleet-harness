import { defaultCredentialDeps } from "../../transport/credentials.js";
import type { ProviderResult, QuotaWindow, ResetCredits } from "../../quota/types.js";
import {
  MAX_CREDIT_ENTRIES,
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
import { resolveCodexCredentials } from "./credentials.js";

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

/**
 * Codex `plan_type` is a product slug. OpenUsage maps the two Pro extra-usage
 * SKUs to the public 5x/20x labels; every other slug stays a title-cased name.
 */
function formatCodexPlan(value: unknown): string | undefined {
  if (typeof value !== "string") return titleCase(value);
  switch (value.trim().toLowerCase()) {
    case "prolite":
      return "Pro 5x";
    case "pro":
      return "Pro 20x";
    default:
      return titleCase(value);
  }
}

export function parseCodexUsage(payload: unknown): { readonly windows: readonly QuotaWindow[]; readonly plan?: string } {
  const root = object(payload) ?? {};
  const rateLimit = object(root.rate_limit) ?? {};
  return {
    windows: [
      codexWindow(rateLimit.primary_window, "session"),
      codexWindow(rateLimit.secondary_window, "weekly"),
    ].filter((row): row is QuotaWindow => row !== null),
    plan: formatCodexPlan(root.plan_type),
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
