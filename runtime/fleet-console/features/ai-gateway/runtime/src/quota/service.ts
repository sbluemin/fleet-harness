import type { AuthService } from "../auth/types.js";

import { fetchAntigravityUsage } from "../upstream/antigravity/quota.js";
import { fetchClaudeUsage } from "../upstream/anthropic/quota.js";
import { fetchCodexUsage } from "../upstream/codex/quota.js";
import { fetchMuseCodeUsage } from "../upstream/muse-code/quota.js";
import { fetchOpencodeUsage } from "../upstream/opencode-go/quota.js";
import { fetchXaiUsage } from "../upstream/xai/quota.js";
import { defaultCredentialDeps, type CredentialResolverDeps } from "../transport/credentials.js";
import { deriveQuotaWindowRisk } from "./pressure.js";
import type { ProviderDto, ProviderResult, ProviderSuccess, QuotaSummaryDto, QuotaWindow } from "./types.js";
import { sanitizeProviderError, type ProviderDeps } from "./windows.js";

export const QUOTA_CACHE_TTL_MS = 5 * 60_000;
/**
 * 배정 경로(`peekSummary`)가 믿는 값의 최대 나이. 패널의 stale 표시는 이 기한과 무관하게
 * 마지막 성공값을 잇는다 — 사람은 "N분 전 데이터" 표시로 나이를 판단하지만, 배정은 그러지 못한다.
 */
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
  /**
   * 추론 응답이 함께 알려 준 사용량을 조회 결과처럼 기록한다. upstream이 방금 답한 값이라
   * backoff를 풀고, 요금제·로그인 방식은 마지막 조회 값을 잇는다.
   */
  observe(id: ProviderId, windows: readonly QuotaWindow[]): void;
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
      // stale 값이 backoff보다 먼저 낡아도 backoff는 유지한다.
      if (cached.backoffUntil !== undefined && cached.backoffUntil > now()) return presentable(cached.value);
      // 간격은 upstream이 답한 결과에만 둔다. 로컬 로그인 없음·읽기 실패는 로그인 즉시 갱신돼야 한다.
      const answered = cached.value.status === "ok" || cached.value.status === "no_subscription";
      if (force && answered && now() - cached.settledAt < QUOTA_FORCE_MIN_INTERVAL_MS) force = false;
    }
    if (!force && cached && cached.expiresAt > now()) {
      const value = presentable(cached.value);
      if (value.status !== "error" || cached.value.status === "error") return value;
      cache.delete(id);
    }
    const pending = inFlight.get(id);
    if (pending) return pending;
    const task = fetchers[id]()
      .then((result) => {
        if (isProviderSuccess(result)) lastGood.set(id, result);
        const settledAt = now();
        // 예외 대신 오류 결과를 돌려주는 조회(자격 증명 저장소를 읽지 못함 등)도 실패다.
        const value = result.status === "error" ? staleOrError(id, result.message, settledAt) : result;
        cache.set(id, { value, expiresAt: settledAt + QUOTA_CACHE_TTL_MS, settledAt });
        return value;
      })
      .catch((error: unknown) => {
        const failedAt = now();
        const value = staleOrError(id, sanitizeProviderError(error), failedAt);
        cache.set(id, {
          value,
          expiresAt: failedAt + QUOTA_CACHE_TTL_MS,
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
   * 조회가 실패하면 마지막 성공값을 나이와 무관하게 잇는다. 단, 리셋 시각이 지난 창의 수치는
   * 이미 틀린 값이므로 뺀다. 읽을 창이 하나도 남지 않으면 오류다.
   */
  function staleOrError(id: ProviderId, message: string | undefined, at: number): ProviderDto {
    const previous = lastGood.get(id);
    const failure: ProviderDto = { status: "error", ...(message ? { message } : {}) };
    if (!previous) return failure;
    return presentable({ ...previous, status: "stale", ...(message ? { message } : {}) }, at, failure);
  }

  /** stale 값을 지금 시각에 맞춰 다듬는다. 리셋이 지나 남은 창이 없으면 `failure`를 돌려준다. */
  function presentable(value: ProviderDto, at = now(), failure?: ProviderDto): ProviderDto {
    if (value.status !== "stale") return value;
    const fallback = failure ?? { status: "error", ...(value.message ? { message: value.message } : {}) };
    const windows = value.windows ?? [];
    const current = windows.filter((window) => window.resetsAt === undefined || window.resetsAt > at);
    if (windows.length > 0 && current.length === 0) return fallback;
    return current.length === windows.length ? value : { ...value, windows: current };
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
    observe(id, windows) {
      if (windows.length === 0) return;
      const previous = lastGood.get(id) ?? cache.get(id)?.value;
      const observedAt = now();
      const value: ProviderSuccess = {
        status: "ok",
        ...(previous?.method ? { method: previous.method } : {}),
        ...(previous?.plan ? { plan: previous.plan } : {}),
        ...(previous?.cycleDays !== undefined ? { cycleDays: previous.cycleDays } : {}),
        windows,
        fetchedAt: observedAt,
      };
      lastGood.set(id, value);
      cache.set(id, { value, expiresAt: observedAt + QUOTA_CACHE_TTL_MS, settledAt: observedAt });
    },
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
