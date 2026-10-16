import type { ProviderResult, QuotaWindow } from "../../quota/types.js";
import {
  expired,
  getJson,
  object,
  percent,
  safeTimestamp,
  titleCase,
  type ProviderDeps,
} from "../../quota/windows.js";

/** Console 로그인이 저장한 xAI 토큰. 조달·갱신은 호출자(`src/oauth/xai/`)의 몫이다. */
export interface XaiUsageCredentials {
  readonly accessToken: string;
  /** 있으면 `x-userid`로 보낸다. 없어도 요청은 나간다. */
  readonly userId?: string;
}

export const XAI_CLI_CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
export const XAI_CLI_SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";
const WEEKLY_PERIOD = "USAGE_PERIOD_TYPE_WEEKLY";

export type ParsedXaiCredits =
  | { readonly status: "weekly"; readonly window: QuotaWindow }
  | { readonly status: "other" };

/**
 * Decode `GET /v1/billing?format=credits`. The body is proto3 JSON: a genuine 0%
 * omits `creditUsagePercent` entirely. A present non-finite value is schema drift.
 * Non-weekly periods (legacy monthly) are valid but have no shared weekly pool.
 */
export function parseXaiCredits(payload: unknown): ParsedXaiCredits | null {
  const root = object(payload);
  const config = object(root?.config);
  const period = object(config?.currentPeriod);
  const periodType = typeof period?.type === "string" ? period.type.trim() : "";
  if (!config || !period || periodType.length === 0) return null;
  const startsAt = safeTimestamp(period.start);
  const resetsAt = safeTimestamp(period.end);
  if (startsAt === undefined || resetsAt === undefined || resetsAt <= startsAt) return null;
  if (periodType !== WEEKLY_PERIOD) return { status: "other" };

  let usedPercent = 0;
  if (config.creditUsagePercent !== undefined) {
    if (typeof config.creditUsagePercent !== "number" || !Number.isFinite(config.creditUsagePercent)) {
      return null;
    }
    usedPercent = percent(config.creditUsagePercent);
  }

  return {
    status: "weekly",
    window: {
      id: "weekly",
      usedPercent,
      resetsAt,
      period: {
        durationMs: resetsAt - startsAt,
        durationBasis: "upstream",
        startsAt,
        startsAtBasis: "upstream",
      },
    },
  };
}

/** OpenUsage reads the display string Grok already localizes for the CLI. */
export function parseXaiPlan(payload: unknown): string | undefined {
  return titleCase(object(payload)?.subscription_tier_display);
}

function creditsHeaders(credentials: XaiUsageCredentials): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${credentials.accessToken}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
  };
  if (credentials.userId) headers["x-userid"] = credentials.userId;
  return headers;
}

/**
 * 401/403은 `{ status: "expired" }`로 돌려준다. 강제 갱신 뒤 다시 부르는 것은 자격을 소유한
 * 호출자의 몫이다 — 이 조회는 자격을 읽거나 쓰지 않는다.
 */
export async function fetchXaiUsage(credentials: XaiUsageCredentials, deps: ProviderDeps = {}): Promise<ProviderResult> {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetch ?? fetch;
  try {
    const payload = await getJson(fetchImpl, XAI_CLI_CREDITS_URL, creditsHeaders(credentials));
    const parsed = parseXaiCredits(payload);
    if (!parsed) throw new Error("Grok returned an unsupported quota response");
    let plan: string | undefined;
    try {
      plan = parseXaiPlan(await getJson(fetchImpl, XAI_CLI_SETTINGS_URL, creditsHeaders(credentials)));
    } catch {
      // Plan metadata is display-only; its failure must not sink the usage snapshot.
      plan = undefined;
    }
    return {
      status: "ok",
      ...(plan ? { plan } : {}),
      windows: parsed.status === "weekly" ? [parsed.window] : [],
      fetchedAt: now(),
    };
  } catch (error) {
    const result = expired(error);
    if (result) return result;
    throw error;
  }
}
