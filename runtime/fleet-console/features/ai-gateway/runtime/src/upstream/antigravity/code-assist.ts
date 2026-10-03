import { credentialRecord, optionalTrimmedString } from "../../transport/credentials.js";
import { ANTIGRAVITY_PROD_API, antigravityUserAgent } from "./credentials.js";

/**
 * Cloud Code Assist onboarding: the one call that states which project a turn is
 * billed to and which tier the account is actually on.
 */
export const ANTIGRAVITY_LOAD_CODE_ASSIST_URL = `${ANTIGRAVITY_PROD_API}/v1internal:loadCodeAssist`;

const REQUEST_TIMEOUT_MS = 10_000;
/** Onboarding changes when a subscription changes, so an hour is generous but not stale. */
export const ANTIGRAVITY_CODE_ASSIST_TTL_MS = 3_600_000;
const MAX_PROJECT_ID_LENGTH = 128;

export interface AntigravityCodeAssist {
  /** `cloudaicompanionProject`, echoed on every turn envelope. */
  readonly projectId?: string;
  /** Display label for the tier the account is on right now. */
  readonly plan?: string;
}

/**
 * Tier ids Cloud Code Assist reports, mapped to what a person calls the plan.
 * The tier *name* is not usable: on a free account it reads `"Antigravity"`,
 * which names the product rather than the plan.
 */
const TIER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "free-tier": "Free",
  "legacy-tier": "Legacy",
  "standard-tier": "Standard",
  "g1-pro-tier": "Pro",
  "g1-ultra-tier": "Ultra",
});

/**
 * Turn a tier id into a plan label.
 *
 * Which id to pass is {@link antigravityPlanTierId}'s decision; this only names it.
 */
export function antigravityPlanLabel(tierId: unknown): string | undefined {
  const id = optionalTrimmedString(tierId)?.toLowerCase();
  if (!id) return undefined;
  const known = TIER_LABELS[id];
  if (known) return known;
  // An unknown tier id still says more than nothing; render it as a label
  // without inventing a marketing name for it.
  const bare = id.replace(/-tier$/, "").replace(/[-_]+/g, " ").trim();
  if (bare.length === 0 || bare.length > 24 || !/^[a-z0-9][a-z0-9 .+-]*$/.test(bare)) return undefined;
  return bare.replace(/(^|\s)([a-z0-9])/g, (_, lead: string, char: string) => `${lead}${char.toUpperCase()}`);
}

/**
 * Pick the tier id that names the plan the account holds.
 *
 * **`paidTier` is the subscription; `currentTier` is only onboarding.** Measured
 * 2026-10-03 on a Google AI Pro account, `loadCodeAssist` returned
 * `currentTier.id = "free-tier"` alongside `paidTier = {id: "g1-pro-tier", name:
 * "Google AI Pro"}`: a personal account onboards Code Assist on the free tier
 * whatever it pays for, so reading `currentTier` labels every subscriber "Free".
 * `paidTier`'s own upgrade text offering Ultra is the next step up from Pro, not
 * evidence the user lacks Pro. Gemini CLI resolves the tier the same way
 * (`paidTier?.id ?? currentTier.id`), and `currentTier` still answers for an
 * account Google reports no paid tier for.
 */
function antigravityPlanTierId(payload: Record<string, unknown>): string | undefined {
  return optionalTrimmedString(credentialRecord(payload.paidTier)?.id)
    ?? optionalTrimmedString(credentialRecord(payload.currentTier)?.id);
}

function projectId(value: unknown): string | undefined {
  const id = optionalTrimmedString(value);
  if (!id || id.length > MAX_PROJECT_ID_LENGTH) return undefined;
  // The envelope carries this verbatim; keep it to the shape GCP project ids take.
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ? id : undefined;
}

/** Read onboarding. Every field is optional: a turn still succeeds without them. */
export async function loadAntigravityCodeAssist(
  fetchImpl: typeof fetch,
  accessToken: string,
  signal?: AbortSignal,
): Promise<AntigravityCodeAssist> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetchImpl(ANTIGRAVITY_LOAD_CODE_ASSIST_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": antigravityUserAgent(),
      },
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
      signal: controller.signal,
    });
    if (!response.ok) {
      // The upstream gate holds this origin's permit until the body ends, and an
      // empty read is deliberately not cached, so a consistently rejecting
      // endpoint would leak one permit per turn and eventually make every turn
      // wait out the queue before it even starts.
      await response.body?.cancel().catch(() => undefined);
      return {};
    }
    const payload = credentialRecord(await response.json());
    if (!payload) return {};
    const project = projectId(payload.cloudaicompanionProject);
    const plan = antigravityPlanLabel(antigravityPlanTierId(payload));
    return {
      ...(project === undefined ? {} : { projectId: project }),
      ...(plan === undefined ? {} : { plan }),
    };
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export interface AntigravityCodeAssistCache {
  read(fetchImpl: typeof fetch, accessToken: string, signal?: AbortSignal): Promise<AntigravityCodeAssist>;
  clear(): void;
}

/**
 * Single-flight, TTL'd onboarding.
 *
 * Every turn envelope wants the project id, and onboarding is a full network
 * round trip; without this the gateway would pay one before each request. The
 * cache keys on the access token so a re-login cannot serve the previous
 * account's project, and it never caches an empty read — that is a failure, and
 * caching it would keep the project absent for the whole TTL.
 */
export function createAntigravityCodeAssistCache(
  now: () => number = Date.now,
  ttlMs: number = ANTIGRAVITY_CODE_ASSIST_TTL_MS,
): AntigravityCodeAssistCache {
  let entry: { token: string; value: AntigravityCodeAssist; expiresAt: number } | undefined;
  let inFlight: { token: string; task: Promise<AntigravityCodeAssist> } | undefined;
  return {
    async read(fetchImpl, accessToken, signal) {
      if (entry && entry.token === accessToken && entry.expiresAt > now()) return entry.value;
      if (inFlight && inFlight.token === accessToken) return inFlight.task;
      const task = loadAntigravityCodeAssist(fetchImpl, accessToken, signal)
        .then((value) => {
          if (value.projectId !== undefined || value.plan !== undefined) {
            entry = { token: accessToken, value, expiresAt: now() + ttlMs };
          }
          return value;
        })
        .finally(() => {
          if (inFlight?.token === accessToken) inFlight = undefined;
        });
      inFlight = { token: accessToken, task };
      return task;
    },
    clear() {
      entry = undefined;
      inFlight = undefined;
    },
  };
}
