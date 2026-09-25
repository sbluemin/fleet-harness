import type { AuthService } from "../auth/types.js";

import { fetchAntigravityUsage } from "../upstream/antigravity/quota.js";
import { fetchClaudeUsage } from "../upstream/anthropic/quota.js";
import { fetchCodexUsage } from "../upstream/codex/quota.js";
import { fetchMuseCodeUsage } from "../upstream/muse-code/quota.js";
import { fetchOpencodeUsage } from "../upstream/opencode-go/quota.js";
import { fetchXaiUsage } from "../upstream/xai/quota.js";
import { defaultCredentialDeps, type CredentialResolverDeps } from "../transport/credentials.js";
import { deriveQuotaWindowRisk } from "./pressure.js";
import type { ProviderDto, ProviderResult, ProviderSuccess, QuotaSummaryDto } from "./types.js";
import { sanitizeProviderError, type ProviderDeps } from "./windows.js";

export const QUOTA_CACHE_TTL_MS = 5 * 60_000;
const STALE_TTL_MS = 1_800_000;

type ProviderId = "antigravity" | "claude" | "codex" | "muse-code" | "opencode" | "xai";

/**
 * 사용량 조회가 rate limit이 걸린 key endpoint인 공급자(Muse Code). 실패 뒤에는
 * stale 값의 유효기간과 무관하게 backoff가 끝날 때까지 강제 여부와 상관없이 upstream을
 * 부르지 않고, 연이은 강제 새로고침도 간격을 둔다 — 새로고침 연타가 무제한 호출이 되지 않게.
 */
const FORCE_GUARDED: ReadonlySet<ProviderId> = new Set<ProviderId>(["muse-code"]);
export const QUOTA_FORCE_MIN_INTERVAL_MS = 60_000;

export interface QuotaService {
  peekSummary(): QuotaSummaryDto | undefined;
  getSummary(options?: {
    readonly force?: boolean;
    readonly forceProvider?: ProviderId;
  }): Promise<QuotaSummaryDto>;
}

export interface QuotaServiceDeps {
  readonly isClaudeConnected: () => Promise<boolean>;
  readonly fetchClaude: () => Promise<ProviderResult>;
  readonly fetchCodex: () => Promise<ProviderResult>;
  readonly fetchOpencode: () => Promise<ProviderResult>;
  readonly fetchXai?: () => Promise<ProviderResult>;
  readonly fetchAntigravity?: () => Promise<ProviderResult>;
  readonly fetchMuseCode?: () => Promise<ProviderResult>;
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
}

/**
 * Deps for building the provider probes. `authService` is required here —
 * OpenCode Go reads the key Fleet itself stores through it — so a host
 * that composes these collectors can never silently fall back to constructing a
 * default auth path inside the package.
 */
export interface AiGatewayQuotaCollectorDeps {
  readonly authService: AuthService;
  readonly credentialDeps?: CredentialResolverDeps;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export interface AiGatewayQuotaCollectors {
  readonly fetchClaude: () => Promise<ProviderResult>;
  readonly fetchCodex: () => Promise<ProviderResult>;
  readonly fetchOpencode: () => Promise<ProviderResult>;
  readonly fetchXai: () => Promise<ProviderResult>;
  readonly fetchAntigravity: () => Promise<ProviderResult>;
  readonly fetchMuseCode: () => Promise<ProviderResult>;
}

export function createAiGatewayQuotaCollectors(deps: AiGatewayQuotaCollectorDeps): AiGatewayQuotaCollectors {
  const providerDeps: ProviderDeps = {
    credentials: deps.credentialDeps ?? defaultCredentialDeps,
    authService: deps.authService,
    ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };
  return {
    fetchClaude: () => fetchClaudeUsage(providerDeps),
    fetchCodex: () => fetchCodexUsage(providerDeps),
    fetchOpencode: () => fetchOpencodeUsage(providerDeps),
    fetchXai: () => fetchXaiUsage(providerDeps),
    fetchAntigravity: () => fetchAntigravityUsage(providerDeps),
    fetchMuseCode: () => fetchMuseCodeUsage(providerDeps),
  };
}

interface CacheEntry {
  readonly value: ProviderDto;
  readonly expiresAt: number;
  /** `value`를 만든 조회가 끝난 시각. */
  readonly settledAt: number;
  /** 보호 대상 공급자만: 이 시각 전에는 upstream을 부르지 않는다. */
  readonly backoffUntil?: number;
}

function isProviderSuccess(value: ProviderResult): value is ProviderSuccess {
  return value.status === "ok"
    && Array.isArray(value.windows)
    && typeof value.fetchedAt === "number";
}

export function createQuotaService(deps: QuotaServiceDeps): QuotaService {
  const now = deps.now ?? Date.now;
  const fetchers: Record<ProviderId, () => Promise<ProviderResult>> = {
    claude: deps.fetchClaude,
    codex: deps.fetchCodex,
    opencode: deps.fetchOpencode,
    xai: deps.fetchXai ?? (async () => ({ status: "signed_out" })),
    antigravity: deps.fetchAntigravity ?? (async () => ({ status: "signed_out" })),
    "muse-code": deps.fetchMuseCode ?? (async () => ({ status: "signed_out" })),
  };
  const cache = new Map<ProviderId, CacheEntry>();
  const lastGood = new Map<ProviderId, ProviderSuccess>();
  const inFlight = new Map<ProviderId, Promise<ProviderDto>>();

  async function load(id: ProviderId, force: boolean): Promise<ProviderDto> {
    if (id === "claude" && !await deps.isClaudeConnected()) {
      const value: ProviderDto = { status: "not_connected", method: (deps.platform ?? process.platform) === "darwin" ? "keychain" : "file" };
      cache.set(id, { value, expiresAt: now(), settledAt: now() });
      return value;
    }
    const cached = cache.get(id);
    if (cached && FORCE_GUARDED.has(id)) {
      if (cached.backoffUntil !== undefined && cached.backoffUntil > now()) {
        // stale 값이 backoff보다 먼저 만료될 수 있어도 backoff는 유지한다.
        const value = cached.value;
        const staleLapsed = value.status === "stale"
          && (typeof value.fetchedAt !== "number" || now() - value.fetchedAt > STALE_TTL_MS);
        return staleLapsed ? { status: "error", ...(value.message ? { message: value.message } : {}) } : value;
      }
      // 간격은 upstream이 답한 결과에만 둔다. 로컬 로그인 없음·읽기 실패는 로그인 즉시 갱신돼야 한다.
      const answered = cached.value.status === "ok" || cached.value.status === "no_subscription";
      if (force && answered && now() - cached.settledAt < QUOTA_FORCE_MIN_INTERVAL_MS) force = false;
    }
    if (!force && cached && cached.expiresAt > now()) {
      const staleStillValid = cached.value.status !== "stale"
        || (
          typeof cached.value.fetchedAt === "number"
          && now() - cached.value.fetchedAt <= STALE_TTL_MS
        );
      if (staleStillValid) return cached.value;
      cache.delete(id);
    }
    const pending = inFlight.get(id);
    if (pending) return pending;
    const task = fetchers[id]()
      .then((value) => {
        if (isProviderSuccess(value)) lastGood.set(id, value);
        const settledAt = now();
        cache.set(id, { value, expiresAt: settledAt + QUOTA_CACHE_TTL_MS, settledAt });
        return value;
      })
      .catch((error: unknown) => {
        const previous = lastGood.get(id);
        const message = sanitizeProviderError(error);
        const failedAt = now();
        const value: ProviderDto = previous && failedAt - previous.fetchedAt <= STALE_TTL_MS
          ? { ...previous, status: "stale", message }
          : { status: "error", message };
        const expiresAt = value.status === "stale" && previous
          ? Math.min(failedAt + QUOTA_CACHE_TTL_MS, previous.fetchedAt + STALE_TTL_MS)
          : failedAt + QUOTA_CACHE_TTL_MS;
        cache.set(id, {
          value,
          expiresAt,
          settledAt: failedAt,
          ...(FORCE_GUARDED.has(id) ? { backoffUntil: failedAt + QUOTA_CACHE_TTL_MS } : {}),
        });
        return value;
      })
      .finally(() => inFlight.delete(id));
    inFlight.set(id, task);
    return task;
  }

  /**
   * Risk is derived against `fetchedAt` rather than the current clock: a
   * summary can be served from cache for minutes, and re-timing the reading on
   * every read would let pace decay while nothing was actually spent.
   */
  function withRisk(provider: ProviderDto): ProviderDto {
    if (!provider.windows || provider.windows.length === 0) return provider;
    const at = typeof provider.fetchedAt === "number" && Number.isFinite(provider.fetchedAt)
      ? provider.fetchedAt
      : now();
    return {
      ...provider,
      windows: provider.windows.map((window) => ({ ...window, risk: deriveQuotaWindowRisk(window, at) })),
    };
  }

  return {
    peekSummary() {
      if (cache.size === 0) return undefined;
      const read = (id: ProviderId): ProviderDto => {
        const value = cache.get(id)?.value;
        if (!value || (typeof value.fetchedAt === "number" && now() - value.fetchedAt > STALE_TTL_MS)) {
          return { status: "error", message: "Quota has not been refreshed." };
        }
        return withRisk(value);
      };
      return { providers: {
        claude: read("claude"), codex: read("codex"),
        opencode: read("opencode"), xai: read("xai"), antigravity: read("antigravity"),
        "muse-code": read("muse-code"),
      } };
    },
    async getSummary(options = {}) {
      const [claude, codex, opencode, xai, antigravity, museCode] = await Promise.all([
        load("claude", options.force === true || options.forceProvider === "claude"),
        load("codex", options.force === true || options.forceProvider === "codex"),
        load("opencode", options.force === true || options.forceProvider === "opencode"),
        load("xai", options.force === true || options.forceProvider === "xai"),
        load("antigravity", options.force === true || options.forceProvider === "antigravity"),
        load("muse-code", options.force === true || options.forceProvider === "muse-code"),
      ]);
      return {
        providers: {
          claude: withRisk(claude),
          codex: withRisk(codex),
          opencode: withRisk(opencode),
          xai: withRisk(xai),
          antigravity: withRisk(antigravity),
          "muse-code": withRisk(museCode),
        },
      };
    },
  };
}
