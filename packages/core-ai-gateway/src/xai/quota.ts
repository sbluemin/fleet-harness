import { defaultCredentialDeps } from "../transport/credentials.js";
import type { ProviderResult, QuotaWindow } from "../quota/types.js";
import {
  expired,
  getJson,
  object,
  percent,
  safeTimestamp,
  type ProviderDeps,
} from "../quota/windows.js";
import { resolveXaiCliCredentials } from "./credentials.js";

export const XAI_CLI_CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const WEEKLY_PERIOD = "USAGE_PERIOD_TYPE_WEEKLY";

export function parseXaiCredits(payload: unknown): QuotaWindow | null {
  const root = object(payload);
  const config = object(root?.config);
  const period = object(config?.currentPeriod);
  if (!config || !period || period.type !== WEEKLY_PERIOD) return null;
  const startsAt = safeTimestamp(period.start);
  const resetsAt = safeTimestamp(period.end);
  if (startsAt === undefined || resetsAt === undefined || resetsAt <= startsAt) return null;
  if (typeof config.creditUsagePercent !== "number"
    || !Number.isFinite(config.creditUsagePercent)) return null;
  return {
    id: "weekly",
    usedPercent: percent(config.creditUsagePercent),
    resetsAt,
    period: {
      durationMs: resetsAt - startsAt,
      durationBasis: "upstream",
      startsAt,
      startsAtBasis: "upstream",
    },
  };
}

export async function fetchXaiUsage(deps: ProviderDeps = {}): Promise<ProviderResult> {
  const credentials = await resolveXaiCliCredentials(
    deps.credentials ?? defaultCredentialDeps,
    deps.now ?? Date.now,
  );
  if (!credentials) return { status: "signed_out" };
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${credentials.accessToken}`,
      "X-XAI-Token-Auth": "xai-grok-cli",
    };
    if (credentials.userId) headers["x-userid"] = credentials.userId;
    const window = parseXaiCredits(await getJson(
      deps.fetch ?? fetch,
      XAI_CLI_CREDITS_URL,
      headers,
    ));
    if (!window) throw new Error("Grok returned an unsupported quota response");
    return {
      status: "ok",
      windows: [window],
      fetchedAt: (deps.now ?? Date.now)(),
    };
  } catch (error) {
    const result = expired(error);
    if (result) return result;
    throw error;
  }
}
