import { stat } from "node:fs/promises";
import path from "node:path";

import {
  defaultCredentialDeps,
  optionalTrimmedString,
  type CredentialResolverDeps,
} from "../../transport/credentials.js";
import type { ProviderResult, QuotaWindow, WindowId } from "../../quota/types.js";
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
} from "../../quota/windows.js";
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
 * Gemini and third-party pools never share headroom; Argon has its own weekly
 * pool too. This table is also the reason `reported: false` exists. Fleet exposes
 * Gemini models only, and a pool none of them can spend is not this provider's
 * headroom: a host reading an exhausted `3p` window would route away from an
 * Antigravity allowance that is in fact untouched. Exposing a Claude or GPT model
 * here is what flips that flag, and the entries stay listed so that stays a
 * one-word change rather than a re-derivation.
 */
const BUCKETS: Readonly<Record<string, {
  readonly id: WindowId;
  readonly label: string;
  readonly durationMs: number;
  readonly reported: boolean;
}>> = Object.freeze({
  "gemini-5h": { id: "session", label: "Gemini", durationMs: SESSION_MS, reported: true },
  "gemini-weekly": { id: "weekly", label: "Gemini", durationMs: WEEK_MS, reported: true },
  "gemini-argon-wtu-weekly": { id: "weekly", label: "Gemini 4 Argon", durationMs: WEEK_MS, reported: true },
  "3p-5h": { id: "session", label: "Claude & GPT", durationMs: SESSION_MS, reported: false },
  "3p-weekly": { id: "weekly", label: "Claude & GPT", durationMs: WEEK_MS, reported: false },
});

/** Order the panel reads: within each spent pool, shorter cadences first. */
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

interface AntigravityQuotaDeps extends ProviderDeps {
  /** Existence-only probe; quota never needs to read installation or IDE files. */
  readonly stat?: (filePath: string) => Promise<unknown>;
}

/**
 * Avoid starting PowerShell for automatic quota reads on Windows without any
 * Antigravity footprint. These are hints, not proof of login: an unreadable path
 * must not hide a user's quota, and an explicit CLI override opts into probing.
 * This deliberately does not gate turns or cache absence across quota reads.
 */
async function hasWindowsAntigravityHint(
  deps: CredentialResolverDeps,
  statPath: NonNullable<AntigravityQuotaDeps["stat"]>,
): Promise<boolean> {
  if (optionalTrimmedString(deps.env.FLEET_ANTIGRAVITY_CLI)) return true;
  const home = deps.homedir();
  const appData = optionalTrimmedString(deps.env.APPDATA) ?? path.win32.join(home, "AppData", "Roaming");
  const localAppData = optionalTrimmedString(deps.env.LOCALAPPDATA) ?? path.win32.join(home, "AppData", "Local");
  const candidates = [
    path.win32.join(home, ".gemini", "antigravity-cli"),
    path.win32.join(appData, "Antigravity"),
    path.win32.join(appData, "Antigravity IDE"),
    path.win32.join(localAppData, "agy", "bin", "agy.exe"),
    path.win32.join(localAppData, "Programs", "Antigravity", "Antigravity.exe"),
    path.win32.join(localAppData, "Programs", "Antigravity", "antigravity.exe"),
  ];
  for (const candidate of candidates) {
    try {
      await statPath(candidate);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return true;
    }
  }
  return false;
}

/**
 * Read Antigravity usage.
 *
 * The credential is the one `agy` owns; Fleet only reads it. A 401/403 is retried
 * once behind a forced refresh, because the local expiry can lag the server's
 * view of the session.
 */
export async function fetchAntigravityUsage(deps: AntigravityQuotaDeps = {}): Promise<ProviderResult> {
  const credentialDeps = deps.credentials ?? defaultCredentialDeps;
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetch ?? fetch;
  if (credentialDeps.platform === "win32" && !await hasWindowsAntigravityHint(credentialDeps, deps.stat ?? stat)) {
    return { status: "signed_out" };
  }
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
