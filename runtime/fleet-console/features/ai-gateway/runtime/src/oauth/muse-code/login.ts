import type { AuthService } from "../../auth/types.js";
import type { ProviderResult, QuotaWindow } from "../../quota/types.js";
import { createDeviceCodeClient } from "../device-code.js";
import { createLoginSessions } from "../login-sessions.js";
import { readMuseCodeEntry, type MuseCodeAuthEntry, type MuseCodeAuthResult } from "./credentials.js";
import { MUSE_CODE_AUTH_PROVIDER_ID, MUSE_CODE_DEVICE_CONFIG, MUSE_CODE_MINT_BACKOFF_MS, MUSE_CODE_MINT_INTERVAL_MS } from "./config.js";
import { mintMuseCodeKey, type MuseCodeMintResult } from "./mint.js";

export interface MuseCodeOAuthDeps {
  readonly authService: AuthService;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** host가 가진 quota 캐시만 갱신한다. 토큰·원문은 전달하지 않는다. */
  readonly onQuota?: (value: ProviderResult) => void;
}

/** 로그인·조회·401 복구가 같은 single-flight와 backoff를 공유한다. 수명은 호스트가 소유한다. */
export function createMuseCodeOAuth(deps: MuseCodeOAuthDeps) {
  const now = deps.now ?? Date.now;
  const sessions = createLoginSessions({ now });
  const device = createDeviceCodeClient({ config: MUSE_CODE_DEVICE_CONFIG, ...(deps.fetch ? { fetch: deps.fetch } : {}), now });
  let generation = 0;
  let usageRevision = 0;
  let disposed = false;
  let mintController = new AbortController();
  let inFlight: { token: string; task: Promise<MuseCodeMintResult> } | undefined;
  let cached: { token: string; result: MuseCodeMintResult; until: number } | undefined;
  let backoff: { token: string; until: number } | undefined;
  let renewed: { key: string; until: number } | undefined;

  const readEntry = () => readMuseCodeEntry(deps.authService);
  const isExpired = (entry: MuseCodeAuthEntry) => entry.accessExpiresAt !== undefined && entry.accessExpiresAt <= now();
  function quotaValue(result: MuseCodeMintResult): ProviderResult {
    if (result.status === "expired") return { status: "expired" };
    if (result.status === "entitlement_required" || result.usage?.status === "inactive") return { status: "no_subscription" };
    if (!result.usage) throw new Error("Muse Code returned an unsupported quota response");
    return { status: "ok", windows: result.usage.windows, ...(result.usage.plan ? { plan: result.usage.plan } : {}), fetchedAt: now() };
  }
  function observe(result: MuseCodeMintResult) {
    // 사용량 형식을 이해하지 못해도 발급된 추론 키는 쓸 수 있다.
    if (result.status !== "ok" || result.usage) deps.onQuota?.(quotaValue(result));
  }
  function clear() {
    generation++;
    mintController.abort();
    mintController = new AbortController();
    inFlight = undefined;
    cached = undefined;
    backoff = undefined;
    renewed = undefined;
  }
  async function mintStored(entry: MuseCodeAuthEntry, failedKey?: string): Promise<MuseCodeMintResult> {
    if (disposed) throw new Error("Muse Code sign-in service closed");
    if (inFlight?.token === entry.accessToken) return inFlight.task;
    if (backoff?.token === entry.accessToken && backoff.until > now()) throw new Error("Muse Code key requests are temporarily paused. Try again later.");
    if (failedKey === undefined && cached?.token === entry.accessToken && cached.until > now()) return cached.result;
    // 같은 키를 연이어 거부한 요청들은 짧은 기간에 재mint를 반복하지 않는다.
    if (failedKey !== undefined && renewed?.key === failedKey && renewed.until > now()) throw new Error("Muse Code sign-in recovery is temporarily paused. Sign in again in Console.");
    const revision = generation;
    const observation = usageRevision;
    const controller = mintController;
    const task = (async () => {
      try {
        const result = await mintMuseCodeKey({ accessToken: entry.accessToken, ...(deps.fetch ? { fetch: deps.fetch } : {}), signal: controller.signal });
        const current = await readEntry();
        if (revision !== generation || controller.signal.aborted || current?.accessToken !== entry.accessToken) throw new Error("Muse Code sign-in changed");
        if (result.status === "ok") {
          await deps.authService.setEntry(MUSE_CODE_AUTH_PROVIDER_ID, {
            ...current, key: result.apiKey, mintedAt: now(), ...(result.baseUrl ? { baseUrl: result.baseUrl } : {}),
          });
        } else if (result.status === "expired") {
          // 삭제하지 않는다. 재시작한 뒤에도 거절된 토큰을 다시 쓰지 않게 만료만 기록한다.
          await deps.authService.setEntry(MUSE_CODE_AUTH_PROVIDER_ID, { ...current, accessExpiresAt: now() });
        }
        if (revision !== generation || controller.signal.aborted) throw new Error("Muse Code sign-in changed");
        cached = { token: entry.accessToken, result, until: now() + MUSE_CODE_MINT_INTERVAL_MS };
        if (failedKey !== undefined) renewed = { key: failedKey, until: now() + MUSE_CODE_MINT_INTERVAL_MS };
        if (failedKey !== undefined && observation === usageRevision) observe(result);
        return result;
      } catch {
        if (revision === generation) backoff = { token: entry.accessToken, until: now() + MUSE_CODE_MINT_BACKOFF_MS };
        throw new Error("Muse Code key request failed. Try again later or sign in again in Console.");
      } finally {
        if (revision === generation && inFlight?.token === entry.accessToken) inFlight = undefined;
      }
    })();
    inFlight = { token: entry.accessToken, task };
    return task;
  }
  return {
    start() {
      return sessions.start("muse-code", {
        ...device,
        async authorized(token, signal) {
          const revision = generation;
          const result = await mintMuseCodeKey({ accessToken: token.accessToken, ...(deps.fetch ? { fetch: deps.fetch } : {}), signal });
          signal.throwIfAborted();
          if (disposed || revision !== generation) return { state: "cancelled" };
          if (result.status === "entitlement_required") return { state: "entitlement_required", ...(result.actionUrl ? { actionUrl: result.actionUrl } : {}) };
          if (result.status === "expired") return { state: "expired" };
          // 새 로그인은 완전 교체한다. 옛 계정의 메타데이터나 임의 extra 필드는 물려받지 않는다.
          const entry: MuseCodeAuthEntry = {
            key: result.apiKey, type: "oauth-device", accessToken: token.accessToken,
            ...(result.baseUrl ? { baseUrl: result.baseUrl } : {}),
            ...(token.accessExpiresAt === undefined ? {} : { accessExpiresAt: token.accessExpiresAt }),
            mintedAt: now(), version: 1,
          };
          clear();
          await deps.authService.setEntry(MUSE_CODE_AUTH_PROVIDER_ID, entry);
          signal.throwIfAborted();
          cached = { token: token.accessToken, result, until: now() + MUSE_CODE_MINT_INTERVAL_MS };
          observe(result);
          return { state: "signed_in" };
        },
      });
    },
    status: sessions.status,
    cancel: sessions.cancel,
    async logout() {
      sessions.cancelProvider("muse-code");
      clear();
      await deps.authService.deleteApiKey(MUSE_CODE_AUTH_PROVIDER_ID);
      deps.onQuota?.({ status: "not_connected" });
    },
    async readAuth(): Promise<MuseCodeAuthResult> {
      try {
        const entry = await readEntry();
        if (!entry) return { status: "signed_out" };
        if (isExpired(entry)) return { status: "expired" };
        return { status: "ok", credentials: { apiKey: entry.key, ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}) } };
      } catch { return { status: "unavailable" }; }
    },
    async renew(failedKey: string): Promise<MuseCodeAuthResult> {
      try {
        const entry = await readEntry();
        if (!entry) return { status: "signed_out" };
        if (isExpired(entry)) return { status: "expired" };
        if (entry.key !== failedKey) return { status: "ok", credentials: { apiKey: entry.key } };
        const result = await mintStored(entry, failedKey);
        return result.status === "ok" ? { status: "ok", credentials: { apiKey: result.apiKey } } : { status: "expired" };
      } catch { return { status: "unavailable" }; }
    },
    async observeUsage(windows: readonly QuotaWindow[], apiKey: string) {
      const revision = generation;
      try {
        const entry = await readEntry();
        if (!entry || entry.key !== apiKey || isExpired(entry) || disposed || generation !== revision || windows.length === 0) return;
        const usage = cached?.token === entry.accessToken && cached.result.status === "ok" ? cached.result.usage : undefined;
        usageRevision++;
        deps.onQuota?.({ status: "ok", windows, fetchedAt: now(), ...(usage?.status === "ok" && usage.plan ? { plan: usage.plan } : {}) });
      } catch { /* 추론 응답의 부가 관측 실패는 본문에 영향을 주지 않는다. */ }
    },
    async fetchUsage(): Promise<ProviderResult> {
      const entry = await readEntry();
      if (!entry) return { status: "not_connected" };
      if (isExpired(entry)) return { status: "expired" };
      return quotaValue(await mintStored(entry));
    },
    dispose() {
      disposed = true;
      sessions.dispose();
      clear();
    },
  };
}

export type MuseCodeOAuth = ReturnType<typeof createMuseCodeOAuth>;
