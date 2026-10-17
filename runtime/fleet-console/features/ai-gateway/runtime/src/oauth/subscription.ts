import type { AuthService, AuthStorageEntry } from "../auth/types.js";
import type { ProviderResult } from "../quota/types.js";
import type { DevicePollResult } from "./device-code.js";
import { createLoginSessions, type LoginFlow, type LoginStart } from "./login-sessions.js";

/**
 * Console이 로그인해 받은 구독 자격의 공통 항목. `key`는 추론에 쓰는 access token이다.
 * 공급자 모듈이 계정 필드(account id 등)를 더한다. 갱신하는 공급자만 `refreshToken`을 둔다.
 */
export interface SubscriptionOAuthEntry extends AuthStorageEntry {
  readonly type: "oauth";
  readonly refreshToken?: string;
  readonly accessExpiresAt: number;
  readonly version: 1;
}

type Refreshable<E extends SubscriptionOAuthEntry> = E & { readonly refreshToken: string };

export interface SubscriptionTokenGrant {
  readonly accessToken: string;
  /** 응답이 회전한 값을 줄 때만 있다. 없으면 요청에 쓴 갱신 토큰을 유지한다. */
  readonly refreshToken?: string;
  readonly accessExpiresAt: number;
}

/** `rejected`는 갱신 토큰 자체가 거절됐다는 확정 답이다. 일시 실패는 예외로 던진다. */
export type SubscriptionRefreshOutcome =
  | { readonly status: "ok"; readonly grant: SubscriptionTokenGrant }
  | { readonly status: "rejected" };

export type SubscriptionCredentialOrigin = "fleet" | "cli";

export type SubscriptionAuthResult<E extends SubscriptionOAuthEntry> =
  | { readonly status: "ok"; readonly entry: E; readonly origin: SubscriptionCredentialOrigin }
  | { readonly status: "signed_out" | "expired" | "unavailable" };

/**
 * 명시적 로그아웃. `key`는 빈 문자열이라 `getApiKey`가 bearer로 넘길 값이 없다.
 * 공급자 ID는 그대로다. 항목을 지우면 '한 번도 로그인한 적 없음'과 구분되지 않는다.
 */
export const SUBSCRIPTION_SIGNED_OUT_ENTRY: AuthStorageEntry = {
  type: "signed-out",
  version: 1,
  key: "",
};

export function isSubscriptionSignedOutEntry(entry: AuthStorageEntry): boolean {
  return entry.type === "signed-out" && entry.version === 1;
}

export interface SubscriptionOAuthConfig<E extends SubscriptionOAuthEntry> {
  /** `login-sessions`와 로그 문구에 쓰는 짧은 이름. */
  readonly provider: string;
  readonly label: string;
  /** `auth.json` 항목 id. 로그인 상태 그 자체라 바꾸지 않는다. */
  readonly providerId: string;
  readonly flow: Omit<LoginFlow, "authorized">;
  /** 승인된 토큰으로 저장할 항목을 만든다. 계정 확인에 실패하면 던진다. */
  buildEntry(token: Extract<DevicePollResult, { state: "authorized" }>, signal: AbortSignal): Promise<E> | E;
  /** 형식이 맞지 않으면 undefined. 옛 형식을 다른 형식으로 해석하지 않는다. */
  parseEntry(entry: AuthStorageEntry): E | undefined;
  /**
   * 없으면 갱신하지 않는다 — 토큰을 만료 시각까지 그대로 쓰고, 그 뒤에는 `expired`다
   * (만료 전 여유 시간도 두지 않는다). 갱신 토큰이 없는 항목도 같다.
   */
  refresh?(entry: Refreshable<E>, signal: AbortSignal): Promise<SubscriptionRefreshOutcome>;
  /** 401/403이면 `{ status: "expired" }`를 돌려준다. 한 번 강제 갱신한 뒤 다시 부른다. */
  fetchQuota(entry: E): Promise<ProviderResult>;
  /**
   * Fleet 항목이 없을 때만 호출한다. 반환 항목은 메모리에서만 쓰고 `auth.json`에 저장하지 않는다.
   * 벤더 파일을 갱신하거나 쓰지 않는다.
   */
  readAbsent?(signal: AbortSignal): Promise<E | undefined>;
  /** 로그아웃이 항목을 지우지 않고 토큰 없는 표식을 남긴다. 표식이 있으면 CLI로 내려가지 않는다. */
  rememberSignOut?: boolean;
}

export interface SubscriptionOAuthDeps {
  readonly authService: AuthService;
  readonly now?: () => number;
  /** host가 가진 quota 캐시만 갱신한다. 토큰·원문은 전달하지 않는다. */
  readonly onQuota?: (value: ProviderResult) => void;
}

/** 만료 이 시간 전부터 갱신한다. 시계 차이와 긴 추론 요청이 만료 경계에 걸리지 않게 한다. */
export const SUBSCRIPTION_REFRESH_WINDOW_MS = 5 * 60_000;
/** 일시 실패한 갱신 토큰은 이 동안 다시 보내지 않는다. 요청마다 공급자를 두드리지 않게. */
const REFRESH_FAILURE_BACKOFF_MS = 30_000;

/**
 * 공급자 하나의 Console 로그인과 그 자격의 수명.
 *
 * 저장된 Fleet 항목이 있으면 그것만 쓴다. 항목이 아예 없을 때만 `readAbsent`가 벤더 CLI 파일을
 * 읽기 전용으로 볼 수 있다. 그 파일은 쓰지 않고, 읽은 토큰은 `auth.json`에 복사하지 않는다.
 * 갱신은 프로세스 안에서 갱신 토큰마다 한 번만 돌고(single-flight), 저장은 "저장된 갱신 토큰이
 * 요청에 쓴 값과 같을 때만" 한다 — quota와 추론, Console과 다른 Fleet 프로세스가 동시에 갱신해도
 * 먼저 회전된 쌍을 옛 응답으로 덮지 않는다.
 */
export function createSubscriptionOAuth<E extends SubscriptionOAuthEntry>(
  config: SubscriptionOAuthConfig<E>,
  deps: SubscriptionOAuthDeps,
) {
  const now = deps.now ?? Date.now;
  const sessions = createLoginSessions({ now });
  let generation = 0;
  let disposed = false;
  let controller = new AbortController();
  const inFlight = new Map<string, Promise<SubscriptionAuthResult<E>>>();
  const rejected = new Set<string>();
  const cliRejected = new Set<string>();
  const backoff = new Map<string, number>();
  /**
   * 로그아웃 표식을 저장하는 동안만 true다. 저장이 끝나면 표식이 차단을 소유하므로 끈다.
   * 저장이 실패하면 켜 둔 채 부재를 CLI 로그인으로 보지 않는다.
   */
  let explicitSignOut = false;

  function clear() {
    generation++;
    controller.abort();
    controller = new AbortController();
    inFlight.clear();
    rejected.clear();
    backoff.clear();
  }

  async function loadRaw(): Promise<AuthStorageEntry | undefined | "unreadable"> {
    try {
      return await deps.authService.getEntry(config.providerId);
    } catch {
      return "unreadable";
    }
  }

  function classify(raw: AuthStorageEntry | undefined | "unreadable"): SubscriptionAuthResult<E> | "absent" {
    if (raw === "unreadable") return { status: "unavailable" };
    if (raw === undefined) return "absent";
    if (isSubscriptionSignedOutEntry(raw)) return { status: "signed_out" };
    const parsed = config.parseEntry(raw);
    if (!parsed) return { status: "unavailable" };
    return { status: "ok", entry: parsed, origin: "fleet" };
  }

  async function stored(): Promise<SubscriptionAuthResult<E>> {
    const classified = classify(await loadRaw());
    return classified === "absent" ? { status: "signed_out" } : classified;
  }

  /** 저장된 Fleet 항목의 만료·갱신. CLI 읽기 도중 항목이 생겨도 이 경로를 탄다. */
  async function finish(
    current: SubscriptionAuthResult<E> & { readonly status: "ok" },
    options: { readonly force?: boolean; readonly failedKey?: string },
  ): Promise<SubscriptionAuthResult<E>> {
    const { entry } = current;
    const force = options.force === true && (options.failedKey === undefined || options.failedKey === entry.key);
    const usable = entry.accessExpiresAt > now();
    const refreshToken = entry.refreshToken;
    if (!config.refresh || refreshToken === undefined) return !force && usable ? current : { status: "expired" };
    const refreshable = entry as Refreshable<E>;
    if (!force && entry.accessExpiresAt - now() > SUBSCRIPTION_REFRESH_WINDOW_MS) return current;
    if (rejected.has(refreshToken)) return !force && usable ? current : { status: "expired" };
    if ((backoff.get(refreshToken) ?? 0) > now()) return !force && usable ? current : { status: "unavailable" };
    let refreshed: SubscriptionAuthResult<E>;
    try { refreshed = await refreshOnce(refreshable, config.refresh); } catch { refreshed = { status: "unavailable" }; }
    // 미리 하는 갱신이 실패해도 아직 유효한 토큰은 쓸 수 있다.
    if (refreshed.status !== "ok" && !force && usable) return current;
    return refreshed;
  }

  /** 갱신이 실패했어도 다른 호출자가 이미 회전해 저장했다면 그 값이 답이다. */
  async function movedOn(used: Refreshable<E>): Promise<SubscriptionAuthResult<E> | undefined> {
    const current = await stored();
    if (current.status !== "ok") return current;
    return current.entry.refreshToken !== used.refreshToken ? current : undefined;
  }

  function refreshOnce(entry: Refreshable<E>, refresh: NonNullable<SubscriptionOAuthConfig<E>["refresh"]>): Promise<SubscriptionAuthResult<E>> {
    const pending = inFlight.get(entry.refreshToken);
    if (pending) return pending;
    const revision = generation;
    const signal = controller.signal;
    const task = (async (): Promise<SubscriptionAuthResult<E>> => {
      let outcome: SubscriptionRefreshOutcome;
      try {
        outcome = await refresh(entry, signal);
      } catch {
        if (revision === generation) backoff.set(entry.refreshToken, now() + REFRESH_FAILURE_BACKOFF_MS);
        return await movedOn(entry) ?? { status: "unavailable" };
      }
      if (revision !== generation || signal.aborted) return stored();
      if (outcome.status === "rejected") {
        rejected.add(entry.refreshToken);
        return await movedOn(entry) ?? { status: "expired" };
      }
      const { grant } = outcome;
      await deps.authService.updateEntry(config.providerId, (current) => {
        // 비교-교체: 로그아웃·새 로그인·다른 갱신이 먼저 저장했으면 쓰지 않는다.
        const parsed = current === undefined ? undefined : config.parseEntry(current);
        if (!parsed || parsed.refreshToken !== entry.refreshToken) return undefined;
        return {
          ...parsed,
          key: grant.accessToken,
          refreshToken: grant.refreshToken ?? entry.refreshToken,
          accessExpiresAt: grant.accessExpiresAt,
        };
      });
      return stored();
    })().finally(() => {
      if (inFlight.get(entry.refreshToken) === task) inFlight.delete(entry.refreshToken);
    });
    inFlight.set(entry.refreshToken, task);
    return task;
  }

  /** Fleet 항목이 없을 때의 읽기 전용 CLI. 결과는 저장하지 않는다. */
  async function readCli(revision: number, signal: AbortSignal): Promise<SubscriptionAuthResult<E>> {
    if (!config.readAbsent || explicitSignOut) return { status: "signed_out" };
    let candidate: E | undefined;
    try {
      candidate = await config.readAbsent(signal);
    } catch {
      candidate = undefined;
    }
    if (disposed) return { status: "unavailable" };
    const current = classify(await loadRaw());
    if (disposed) return { status: "unavailable" };
    if (current !== "absent") {
      if (current.status !== "ok") return current;
      // 대기 중에 저장된 Fleet 항목은 만료·갱신 검사를 건너뛰지 않는다.
      return finish(current, {});
    }
    // 오래 걸린 읽기가 그 사이 로그인·로그아웃을 덮거나 되살리지 않는다.
    if (revision !== generation || signal.aborted || explicitSignOut) return { status: "signed_out" };
    if (!candidate || cliRejected.has(candidate.key)) return { status: "signed_out" };
    return { status: "ok", entry: candidate, origin: "cli" };
  }

  /**
   * 저장된 자격을 읽고, 만료가 가까우면 갱신한다. `force`는 upstream이 지금 토큰을 거절했을 때만
   * 쓴다 — 그때도 `failedKey`가 이미 바뀌었다면(다른 호출자가 갱신했다면) 다시 갱신하지 않는다.
   */
  async function read(options: { readonly force?: boolean; readonly failedKey?: string } = {}): Promise<SubscriptionAuthResult<E>> {
    if (disposed) return { status: "unavailable" };
    let classified: SubscriptionAuthResult<E> | "absent";
    try { classified = classify(await loadRaw()); } catch { return { status: "unavailable" }; }
    if (disposed) return { status: "unavailable" };
    if (classified === "absent") {
      if (explicitSignOut) return { status: "signed_out" };
      return readCli(generation, controller.signal);
    }
    if (classified.status !== "ok") return classified;
    return finish(classified, options);
  }

  return {
    start(): Promise<LoginStart> {
      return sessions.start(config.provider, {
        ...config.flow,
        async authorized(token, signal) {
          const revision = generation;
          const entry = await config.buildEntry(token, signal);
          signal.throwIfAborted();
          if (disposed || revision !== generation) return { state: "cancelled" };
          // 새 로그인은 완전 교체한다. 옛 계정의 갱신 토큰·계정 id·임의 extra 필드는 물려받지 않는다.
          explicitSignOut = false;
          clear();
          await deps.authService.setEntry(config.providerId, entry);
          return { state: "signed_in" };
        },
      });
    },
    status: sessions.status,
    cancel: sessions.cancel,
    async logout() {
      sessions.cancelProvider(config.provider);
      // 표식 쓰기보다 먼저 막는다. 그 사이에 CLI 토큰이 로그아웃을 되살리지 않게.
      if (config.rememberSignOut === true) explicitSignOut = true;
      clear();
      try {
        if (config.rememberSignOut === true) {
          await deps.authService.setEntry(config.providerId, { ...SUBSCRIPTION_SIGNED_OUT_ENTRY });
        } else {
          // 벤더 CLI의 자기 로그인은 지우지 않는다 — Console 슬롯의 항목만 지운다.
          await deps.authService.deleteApiKey(config.providerId);
        }
      } catch (error) {
        deps.onQuota?.({ status: "not_connected" });
        throw error;
      }
      // 표식이 이후의 차단을 소유한다. 실패하면 플래그를 유지해 부재를 CLI로 열지 않는다.
      if (config.rememberSignOut === true) explicitSignOut = false;
      deps.onQuota?.({ status: "not_connected" });
    },
    read,
    async fetchUsage(): Promise<ProviderResult> {
      const auth = await read();
      if (auth.status !== "ok") {
        if (auth.status === "signed_out") return { status: "not_connected" };
        if (auth.status === "expired") return { status: "expired" };
        throw new Error(`The saved ${config.label} sign-in could not be used. Try again later or sign in again in Console.`);
      }
      const result = await config.fetchQuota(auth.entry);
      if (result.status !== "expired") return result;
      if (auth.origin === "cli") {
        // 벤더 refresh는 호출하지 않는다. 거절된 access만 이 프로세스에서 버리고 로그인을 안내한다.
        cliRejected.add(auth.entry.key);
        return { status: "not_connected" };
      }
      const retried = await read({ force: true, failedKey: auth.entry.key });
      if (retried.status !== "ok" || retried.entry.key === auth.entry.key) return { status: "expired" };
      return config.fetchQuota(retried.entry);
    },
    dispose() {
      disposed = true;
      sessions.dispose();
      clear();
    },
  };
}

export type SubscriptionOAuth<E extends SubscriptionOAuthEntry> = ReturnType<typeof createSubscriptionOAuth<E>>;

/** 공통 필드만 검사한다. 공급자 모듈이 자기 필드(갱신 토큰·계정 id)를 더 확인한다. */
export function isSubscriptionOAuthEntry(entry: AuthStorageEntry): entry is SubscriptionOAuthEntry {
  return entry.type === "oauth" && entry.version === 1
    && typeof entry.key === "string" && entry.key.trim() !== ""
    && (entry.refreshToken === undefined || (typeof entry.refreshToken === "string" && entry.refreshToken.trim() !== ""))
    && typeof entry.accessExpiresAt === "number" && Number.isFinite(entry.accessExpiresAt);
}

/** 갱신하는 공급자의 항목. 갱신 토큰이 없으면 그 공급자의 항목이 아니다. */
export function isRefreshableOAuthEntry(entry: AuthStorageEntry): entry is SubscriptionOAuthEntry & { readonly refreshToken: string } {
  return isSubscriptionOAuthEntry(entry) && entry.refreshToken !== undefined;
}
