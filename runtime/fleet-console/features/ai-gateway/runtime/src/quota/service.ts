import type { AuthService } from "../auth/types.js";

import { fetchAntigravityUsage } from "../upstream/antigravity/quota.js";
import { fetchClaudeUsage } from "../upstream/anthropic/quota.js";
import { createCodexOAuth, type CodexOAuth } from "../oauth/codex/login.js";
import { createCursorOAuth, type CursorOAuth } from "../oauth/cursor/login.js";
import { createMuseCodeOAuth, type MuseCodeOAuth } from "../oauth/muse-code/login.js";
import { createXaiOAuth, type XaiOAuth } from "../oauth/xai/login.js";
import { defaultCredentialDeps, type CredentialResolverDeps } from "../transport/credentials.js";
import { deriveQuotaWindowRisk } from "./pressure.js";
import { QUOTA_LAST_GOOD_PROVIDERS, type QuotaLastGoodProviderId, type QuotaLastGoodStore } from "./last-good.js";
import type { ProviderDto, ProviderResult, ProviderSuccess, QuotaSummaryDto } from "./types.js";
import { sanitizeProviderError, type ProviderDeps } from "./windows.js";

export const QUOTA_CACHE_TTL_MS = 5 * 60_000;
/**
 * 배정 경로(`peekSummary`)가 믿는 값의 최대 나이. 패널의 stale 표시는 이 기한과 무관하게
 * 마지막 성공값을 잇는다 — 사람은 "N분 전 데이터" 표시로 나이를 판단하지만, 배정은 그러지 못한다.
 */
const STALE_TTL_MS = 1_800_000;

type ProviderId = QuotaLastGoodProviderId;

/**
 * 사용량 조회가 rate limit이 걸린 key endpoint인 공급자(Muse Code). 실패 뒤에는
 * stale 값의 유효기간과 무관하게 backoff가 끝날 때까지 강제 여부와 상관없이 upstream을
 * 부르지 않고, 연이은 강제 새로고침도 간격을 둔다 — 새로고침 연타가 무제한 호출이 되지 않게.
 */
const FORCE_GUARDED: ReadonlySet<ProviderId> = new Set<ProviderId>(["muse-code"]);
export const QUOTA_FORCE_MIN_INTERVAL_MS = 60_000;

export interface QuotaService {
  peekSummary(): QuotaSummaryDto | undefined;
  /** 로그인·로그아웃이 알려 준 확정값. 이전 진행 중 조회가 이 값을 되살리지 못한다. */
  record(id: ProviderId, value: ProviderResult): void;
  /**
   * 패널이 기다리지 않고 먼저 그릴 마지막 값. 나이 상한이 없다 — 사람은 "N분 전" 표시로
   * 나이를 판단한다. 다만 리셋이 지난 창과 만료된 크레딧은 이미 틀린 값이라 뺀다. 공급자 하나라도
   * 캐시에 없거나 남을 창이 없으면 undefined이고, 그때는 `getSummary`를 기다려야 한다.
   * `expired`는 TTL이 지난 공급자가 있어 다음 `getSummary`가 upstream을 부른다는 뜻이다.
   */
  readCachedSummary(): { readonly summary: QuotaSummaryDto; readonly expired: boolean } | undefined;
  getSummary(options?: {
    readonly force?: boolean;
    readonly forceProvider?: ProviderId;
  }): Promise<QuotaSummaryDto>;
}

export interface QuotaServiceDeps {
  readonly isClaudeConnected: () => Promise<boolean>;
  readonly fetchClaude: () => Promise<ProviderResult>;
  readonly fetchCodex: () => Promise<ProviderResult>;
  readonly fetchCursor?: () => Promise<ProviderResult>;
  readonly fetchXai?: () => Promise<ProviderResult>;
  readonly fetchAntigravity?: () => Promise<ProviderResult>;
  readonly fetchMuseCode?: () => Promise<ProviderResult>;
  /**
   * 마지막 성공 사용량. 호스트가 파일 자리를 정해 넘긴다. 없으면 이 프로세스 메모리만 쓴다.
   * 읽기에 실패하거나 파일이 깨져 있으면 빈 값으로 시작한다.
   */
  readonly lastGoodStore?: QuotaLastGoodStore;
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
}

/**
 * Deps for building the provider probes. `authService` is required here —
 * Muse Code reads the entry Fleet itself stores through it — so a host
 * that composes these collectors can never silently fall back to constructing a
 * default auth path inside the package.
 */
export interface AiGatewayQuotaCollectorDeps {
  readonly authService: AuthService;
  readonly credentialDeps?: CredentialResolverDeps;
  readonly museCode?: Pick<MuseCodeOAuth, "fetchUsage">;
  /** Console 로그인 자격을 소유한 인스턴스. 추론 라우터와 같은 것을 넘겨야 갱신이 한 번에 묶인다. */
  readonly codex?: Pick<CodexOAuth, "fetchUsage">;
  readonly xai?: Pick<XaiOAuth, "fetchUsage">;
  readonly cursor?: Pick<CursorOAuth, "fetchUsage">;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export interface AiGatewayQuotaCollectors {
  readonly fetchClaude: () => Promise<ProviderResult>;
  readonly fetchCodex: () => Promise<ProviderResult>;
  readonly fetchCursor: () => Promise<ProviderResult>;
  readonly fetchXai: () => Promise<ProviderResult>;
  readonly fetchAntigravity: () => Promise<ProviderResult>;
  readonly fetchMuseCode: () => Promise<ProviderResult>;
}

export function createAiGatewayQuotaCollectors(deps: AiGatewayQuotaCollectorDeps): AiGatewayQuotaCollectors {
  const providerDeps: ProviderDeps = {
    credentials: deps.credentialDeps ?? defaultCredentialDeps,
    ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };
  const museCode = deps.museCode ?? createMuseCodeOAuth(deps);
  const codex = deps.codex ?? createCodexOAuth(deps);
  const xai = deps.xai ?? createXaiOAuth(deps);
  const cursor = deps.cursor ?? createCursorOAuth(deps);
  return {
    fetchClaude: () => fetchClaudeUsage(providerDeps),
    fetchCodex: () => codex.fetchUsage(),
    fetchCursor: () => cursor.fetchUsage(),
    fetchXai: () => xai.fetchUsage(),
    fetchAntigravity: () => fetchAntigravityUsage(providerDeps),
    fetchMuseCode: () => museCode.fetchUsage(),
  };
}

interface CacheEntry {
  readonly value: ProviderDto;
  readonly expiresAt: number;
  /** `value`를 만든 조회가 끝난 시각. */
  readonly settledAt: number;
  /** 보호 대상 공급자만: 이 시각 전에는 upstream을 부르지 않는다. */
  readonly backoffUntil?: number;
  /**
   * upstream이 성공으로 답했다. 창이 없어 화면은 stale이어도, 강제 새로고침 간격은
   * 성공 응답과 같이 둔다.
   */
  readonly accepted?: boolean;
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
    cursor: deps.fetchCursor ?? (async () => ({ status: "signed_out" })),
    xai: deps.fetchXai ?? (async () => ({ status: "signed_out" })),
    antigravity: deps.fetchAntigravity ?? (async () => ({ status: "signed_out" })),
    "muse-code": deps.fetchMuseCode ?? (async () => ({ status: "signed_out" })),
  };
  const cache = new Map<ProviderId, CacheEntry>();
  const lastGood = new Map<ProviderId, ProviderSuccess>();
  if (deps.lastGoodStore) {
    try {
      const saved = deps.lastGoodStore.read();
      for (const id of QUOTA_LAST_GOOD_PROVIDERS) {
        const value = saved[id];
        if (value) lastGood.set(id, value);
      }
      // 읽기에서 걸러 낸 비밀·깨진 필드는 다음 성공을 기다리지 않고 파일에서도 뺀다.
      if (lastGood.size > 0) deps.lastGoodStore.write(saved);
    } catch {
      // 깨진 저장소는 없는 것과 같다. 다음 성공이 파일을 다시 쓴다.
    }
  }
  const inFlight = new Map<ProviderId, Promise<ProviderDto>>();
  /** 공급자별 마지막 추론 관측 시각. 그보다 먼저 시작한 조회는 관측값을 덮지 못한다. */
  const observedAt = new Map<ProviderId, number>();
  const revisions = new Map<ProviderId, number>();

  /**
   * 조회가 시작된 뒤 추론 관측이 들어왔다면 그 관측값. 조회 응답은 시작 시점의 upstream 상태라,
   * 늦게 도착해도 더 새로운 관측(예: 추론 전의 빈 key 응답 대 추론 직후의 사용량)을 이기면 안 된다.
   */
  function observationSince(id: ProviderId, startedAt: number): ProviderDto | undefined {
    const at = observedAt.get(id);
    return at !== undefined && at > startedAt ? cache.get(id)?.value : undefined;
  }

  async function load(id: ProviderId, force: boolean): Promise<ProviderDto> {
    if (id === "claude" && !await deps.isClaudeConnected()) {
      const value: ProviderDto = { status: "not_connected", method: (deps.platform ?? process.platform) === "darwin" ? "keychain" : "file" };
      cache.set(id, { value, expiresAt: now(), settledAt: now() });
      forget(id);
      return value;
    }
    const cached = cache.get(id);
    if (cached && FORCE_GUARDED.has(id)) {
      // stale 값이 backoff보다 먼저 낡아도 backoff는 유지한다.
      if (cached.backoffUntil !== undefined && cached.backoffUntil > now()) return presentable(cached.value);
      // 간격은 upstream이 답한 결과에만 둔다. 로컬 로그인 없음·읽기 실패는 로그인 즉시 갱신돼야 한다.
      // 빈 성공을 stale로 이은 값도 그 답이다. 새로고침 연타가 key endpoint를 다시 두드리면 안 된다.
      const answered = cached.value.status === "ok"
        || cached.value.status === "no_subscription"
        || cached.accepted === true;
      if (force && answered && now() - cached.settledAt < QUOTA_FORCE_MIN_INTERVAL_MS) force = false;
    }
    if (!force && cached && cached.expiresAt > now()) {
      const value = presentable(cached.value);
      if (value.status !== "error" || cached.value.status === "error") return value;
      cache.delete(id);
    }
    const pending = inFlight.get(id);
    if (pending) return pending;
    const startedAt = now();
    const revision = revisions.get(id);
    const currentMutation = () => revisions.get(id) !== revision ? cache.get(id)?.value : undefined;
    const task = fetchers[id]()
      .then((result) => {
        const newer = currentMutation() ?? observationSince(id, startedAt);
        if (newer) return newer;
        const settledAt = now();
        const value = applySettled(id, result, settledAt);
        cache.set(id, {
          value,
          expiresAt: settledAt + QUOTA_CACHE_TTL_MS,
          settledAt,
          ...(isProviderSuccess(result) ? { accepted: true } : {}),
        });
        return value;
      })
      .catch((error: unknown) => {
        const newer = currentMutation() ?? observationSince(id, startedAt);
        if (newer) return newer;
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

  /** 창에 붙은 파생 판정은 저장하지 않는다. 읽는 쪽에서 다시 계산한다. */
  function stripDerived(value: ProviderSuccess): ProviderSuccess {
    return {
      ...value,
      windows: value.windows.map(({ risk: _risk, ...window }) => window),
    };
  }

  function persist(): void {
    const store = deps.lastGoodStore;
    if (!store) return;
    const providers: Partial<Record<ProviderId, ProviderSuccess>> = {};
    for (const id of QUOTA_LAST_GOOD_PROVIDERS) {
      const value = lastGood.get(id);
      if (value && value.windows.length > 0) providers[id] = stripDerived(value);
    }
    try {
      store.write(providers);
    } catch {
      // 디스크가 거절해도 이번 조회 결과는 메모리에 남긴다.
    }
  }

  /** 확정된 로그아웃·만료·구독 없음. 이전 계정 값이 파일에 남으면 재시작 뒤 되살아난다. */
  function forget(id: ProviderId): void {
    if (!lastGood.delete(id)) return;
    persist();
  }

  function remember(id: ProviderId, value: ProviderSuccess, at: number): void {
    lastGood.set(id, stripDerived(value));
    observedAt.set(id, at);
    persist();
  }

  /**
   * 창이 있는 성공만 마지막 값을 갈아 끼운다. 창이 없는 성공(Muse key가 진행 중인 창을
   * 빠뜨릴 때)은 이전 창을 지우지 않고, 실패와 같이 stale로 보이되 리셋이 지난 창은 뺀다.
   * 남는 창이 없으면 그 빈 성공 자체를 그대로 둔다. 요금제는 새 응답에 있을 때만 갈아 끼운다.
   */
  function applySettled(id: ProviderId, result: ProviderResult, at: number): ProviderDto {
    if (isProviderSuccess(result) && result.windows.length > 0) {
      const previous = lastGood.get(id);
      const value: ProviderSuccess = {
        ...result,
        ...(result.plan || !previous?.plan ? {} : { plan: previous.plan }),
        ...(result.method || !previous?.method ? {} : { method: previous.method }),
        ...(result.cycleDays !== undefined || previous?.cycleDays === undefined ? {} : { cycleDays: previous.cycleDays }),
        ...(result.credits || !previous?.credits ? {} : { credits: previous.credits }),
      };
      remember(id, value, at);
      return value;
    }
    if (isProviderSuccess(result)) return presentEmptySuccess(id, result, at);
    // 예외 대신 오류 결과를 돌려주는 조회(자격 증명 저장소를 읽지 못함 등)도 실패다.
    if (result.status === "error") return staleOrError(id, result.message, at);
    forget(id);
    return result;
  }

  /**
   * 빈 성공. 이전 창이 리셋 전이면 stale로 잇고, 하나도 남지 않으면 지금 응답(idle)을 그대로 둔다.
   * 오류로 바꾸지 않는다 — 구독은 살아 있고 단지 진행 중인 창이 없는 것이다.
   */
  function presentEmptySuccess(id: ProviderId, result: ProviderSuccess, at: number): ProviderDto {
    const previous = lastGood.get(id);
    const plan = result.plan ?? previous?.plan;
    const idle: ProviderDto = {
      status: "ok",
      windows: [],
      fetchedAt: result.fetchedAt,
      ...(plan ? { plan } : {}),
      ...(result.method ? { method: result.method } : {}),
    };
    if (!previous) return idle;
    if (result.plan && result.plan !== previous.plan) remember(id, { ...previous, plan: result.plan }, previous.fetchedAt);
    const kept = withoutLapsed({ ...lastGood.get(id)!, status: "stale", ...(plan ? { plan } : {}) }, at);
    if (kept === null || (kept.windows?.length ?? 0) === 0) {
      forget(id);
      return idle;
    }
    const survived = kept.windows ?? [];
    const creditsChanged = (kept.credits?.available !== previous.credits?.available)
      || (kept.credits?.nextExpiresAt !== previous.credits?.nextExpiresAt);
    if (survived.length !== previous.windows.length || creditsChanged) {
      const { status: _status, message: _message, ...rest } = kept;
      remember(id, { ...rest, status: "ok", windows: survived, fetchedAt: previous.fetchedAt }, previous.fetchedAt);
    }
    return kept;
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
    return withoutLapsed(value, at)
      ?? failure
      ?? { status: "error", ...(value.message ? { message: value.message } : {}) };
  }

  /** 리셋이 지난 창과 만료가 지난 크레딧을 뺀다. 창이 있었는데 하나도 남지 않으면 null. */
  function withoutLapsed(value: ProviderDto, at: number): ProviderDto | null {
    const windows = value.windows ?? [];
    const current = windows.filter((window) => window.resetsAt === undefined || window.resetsAt > at);
    if (windows.length > 0 && current.length === 0) return null;
    // 크레딧도 창과 같다. 가장 이른 만료가 지나면 남은 개수를 알 수 없으므로 뺀다.
    const creditsLapsed = value.credits?.nextExpiresAt !== undefined && value.credits.nextExpiresAt <= at;
    if (current.length === windows.length && !creditsLapsed) return value;
    const { credits, ...rest } = value;
    return { ...rest, windows: current, ...(credits && !creditsLapsed ? { credits } : {}) };
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
    record(id, value) {
      revisions.set(id, (revisions.get(id) ?? 0) + 1);
      const at = now();
      const settled = applySettled(id, value, at);
      cache.set(id, {
        value: settled,
        expiresAt: at + QUOTA_CACHE_TTL_MS,
        settledAt: at,
        ...(isProviderSuccess(value) ? { accepted: true } : {}),
      });
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
        claude: read("claude"), codex: read("codex"), cursor: read("cursor"),
        xai: read("xai"), antigravity: read("antigravity"),
        "muse-code": read("muse-code"),
      } };
    },
    readCachedSummary() {
      const at = now();
      let expired = false;
      const read = (id: ProviderId): ProviderDto | null => {
        const cached = cache.get(id);
        if (!cached) return null;
        // 다시 읽어도 upstream을 부르지 않는 항목(연결 전 Claude, backoff 중)은 갱신을 예고하지 않는다.
        const waitsOnUpstream = cached.value.status !== "not_connected"
          && (cached.backoffUntil === undefined || cached.backoffUntil <= at);
        if (cached.expiresAt <= at && waitsOnUpstream) expired = true;
        // stale은 조회 경로와 같은 판정(남은 창이 없으면 오류)을, 성공값은 창이 모두 지나면 기다림을 고른다.
        const value = cached.value.status === "stale" ? presentable(cached.value, at) : withoutLapsed(cached.value, at);
        return value === null ? null : withRisk(value);
      };
      const claude = read("claude");
      const codex = read("codex");
      const cursor = read("cursor");
      const xai = read("xai");
      const antigravity = read("antigravity");
      const museCode = read("muse-code");
      if (!claude || !codex || !cursor || !xai || !antigravity || !museCode) return undefined;
      return {
        summary: { providers: { claude, codex, cursor, xai, antigravity, "muse-code": museCode } },
        expired,
      };
    },
    async getSummary(options = {}) {
      const [claude, codex, cursor, xai, antigravity, museCode] = await Promise.all([
        load("claude", options.force === true || options.forceProvider === "claude"),
        load("codex", options.force === true || options.forceProvider === "codex"),
        load("cursor", options.force === true || options.forceProvider === "cursor"),
        load("xai", options.force === true || options.forceProvider === "xai"),
        load("antigravity", options.force === true || options.forceProvider === "antigravity"),
        load("muse-code", options.force === true || options.forceProvider === "muse-code"),
      ]);
      return {
        providers: {
          claude: withRisk(claude),
          codex: withRisk(codex),
          cursor: withRisk(cursor),
          xai: withRisk(xai),
          antigravity: withRisk(antigravity),
          "muse-code": withRisk(museCode),
        },
      };
    },
  };
}
