import { defaultCredentialDeps } from "../transport/credentials.js";
import type { ProviderResult, QuotaWindow, WindowId } from "../quota/types.js";
import {
  HOUR_MS,
  WEEK_MS,
  array,
  expired,
  object,
  postJson,
  safeTimestamp,
  windowPeriod,
  type ProviderDeps,
} from "../quota/windows.js";
import {
  ANTIGRAVITY_DAILY_API,
  ANTIGRAVITY_PROD_API,
  antigravityUserAgent,
  resolveAntigravityAuth,
  type AntigravityCredentials,
} from "./credentials.js";
import { createAntigravityCodeAssistCache } from "./code-assist.js";

/**
 * Antigravity's own usage RPC.
 *
 * The daily host is what the IDE calls and the only one observed to answer the
 * summary shape; the production host is kept as a fallback for builds that have
 * not been cut over. Both are the same subscription.
 */
export const ANTIGRAVITY_QUOTA_SUMMARY_URLS: readonly string[] = Object.freeze([
  `${ANTIGRAVITY_DAILY_API}/v1internal:retrieveUserQuotaSummary`,
  `${ANTIGRAVITY_PROD_API}/v1internal:retrieveUserQuotaSummary`,
]);

/** 5-hour rolling window, the shorter of the two cadences Antigravity meters. */
const SESSION_MS = 5 * HOUR_MS;

/**
 * The buckets Antigravity reports, and what each one actually meters.
 *
 * Binding is on `bucketId` alone. The sibling `displayName` ("Five Hour Limit
 * Remaining") and `window` ("5h") are presentation, and a build that relabels
 * them must not silently move a reading onto the wrong pool.
 *
 * The two pools never share headroom — the response's own description says
 * "Within each group, models share a weekly limit and a 5-hour limit" — so this
 * table is also the reason `reported: false` exists. Fleet exposes Gemini models
 * only, and a pool none of them can spend is not this provider's headroom: a
 * host reading an exhausted `3p` window would route away from an Antigravity
 * allowance that is in fact untouched. Exposing a Claude or GPT model here is
 * what flips that flag, and the entries stay listed so that stays a one-word
 * change rather than a re-derivation.
 */
const BUCKETS: Readonly<Record<string, {
  readonly id: WindowId;
  readonly label: string;
  readonly durationMs: number;
  readonly reported: boolean;
}>> = Object.freeze({
  "gemini-5h": { id: "session", label: "Gemini", durationMs: SESSION_MS, reported: true },
  "gemini-weekly": { id: "weekly", label: "Gemini", durationMs: WEEK_MS, reported: true },
  "3p-5h": { id: "session", label: "Claude & GPT", durationMs: SESSION_MS, reported: false },
  "3p-weekly": { id: "weekly", label: "Claude & GPT", durationMs: WEEK_MS, reported: false },
});

/** Order the panel reads: both cadences of the spent pool, shortest first. */
const BUCKET_ORDER: readonly string[] = Object.freeze(
  Object.keys(BUCKETS).filter((bucketId) => BUCKETS[bucketId]?.reported === true),
);

function usedPercentFromRemaining(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round((1 - clamped) * 100);
}

/**
 * Decode `POST /v1internal:retrieveUserQuotaSummary`.
 *
 * The body is `{groups:[{buckets:[{bucketId,remainingFraction,resetTime}]}]}`;
 * some builds wrap it once more in `response`. An unknown `bucketId` is skipped
 * rather than guessed at, and a bucket missing `remainingFraction` drops only its
 * own row — a partial answer is still a true answer about the rows it carries.
 */
export function parseAntigravityQuotaSummary(payload: unknown): readonly QuotaWindow[] | null {
  const root = object(payload);
  const groups = array(root?.groups ?? object(root?.response)?.groups);
  if (root === null) return null;
  if (!Array.isArray(root.groups) && !Array.isArray(object(root.response)?.groups)) return null;

  const byBucket = new Map<string, QuotaWindow>();
  for (const rawGroup of groups) {
    for (const rawBucket of array(object(rawGroup)?.buckets)) {
      const bucket = object(rawBucket);
      const bucketId = typeof bucket?.bucketId === "string" ? bucket.bucketId.trim() : "";
      const known = BUCKETS[bucketId];
      // First reading of a bucket wins; a duplicate id is drift, not a second pool.
      if (!known?.reported || byBucket.has(bucketId)) continue;
      const usedPercent = usedPercentFromRemaining(bucket?.remainingFraction);
      if (usedPercent === undefined) continue;
      const resetsAt = safeTimestamp(bucket?.resetTime);
      const period = windowPeriod(known.durationMs, "catalog", resetsAt);
      byBucket.set(bucketId, {
        id: known.id,
        label: known.label,
        usedPercent,
        ...(resetsAt === undefined ? {} : { resetsAt }),
        ...(period === undefined ? {} : { period }),
      });
    }
  }
  return BUCKET_ORDER.flatMap((bucketId) => {
    const window = byBucket.get(bucketId);
    return window ? [window] : [];
  });
}

function quotaHeaders(credentials: AntigravityCredentials): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${credentials.accessToken}`,
    "User-Agent": antigravityUserAgent(),
  };
}

const codeAssistCache = createAntigravityCodeAssistCache();

/**
 * Read Antigravity usage.
 *
 * The credential is the one `agy` owns; Fleet only reads it. A 401/403 is retried
 * once behind a forced refresh, because the local expiry can lag the server's
 * view of the session.
 */
export async function fetchAntigravityUsage(deps: ProviderDeps = {}): Promise<ProviderResult> {
  const credentialDeps = deps.credentials ?? defaultCredentialDeps;
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetch ?? fetch;
  const auth = await resolveAntigravityAuth(credentialDeps, { now });
  if (auth.status !== "ok") return { status: auth.status };

  const load = async (credentials: AntigravityCredentials): Promise<unknown> => {
    let lastError: unknown;
    for (const url of ANTIGRAVITY_QUOTA_SUMMARY_URLS) {
      try {
        return await postJson(fetchImpl, url, quotaHeaders(credentials));
      } catch (error) {
        // An expired credential is the same on every host; stop rather than
        // spend a second call proving it.
        if (expired(error)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  };

  try {
    let credentials = auth.credentials;
    let payload: unknown;
    try {
      payload = await load(credentials);
    } catch (error) {
      if (!expired(error)) throw error;
      const retried = await resolveAntigravityAuth(credentialDeps, { now, forceRefresh: true });
      if (retried.status !== "ok") return { status: "expired" };
      credentials = retried.credentials;
      try {
        payload = await load(credentials);
      } catch (retryError) {
        const result = expired(retryError);
        if (result) return result;
        throw retryError;
      }
    }
    const windows = parseAntigravityQuotaSummary(payload);
    if (!windows) throw new Error("Antigravity returned an unsupported quota response");
    // Onboarding only carries the plan label here, so a failed read costs a
    // caption and never the usage snapshot itself.
    const plan = (await codeAssistCache.read(fetchImpl, credentials.accessToken)).plan;
    return {
      status: "ok",
      method: credentials.method,
      ...(plan ? { plan } : {}),
      windows,
      fetchedAt: now(),
    };
  } catch (error) {
    const result = expired(error);
    if (result) return result;
    throw error;
  }
}
