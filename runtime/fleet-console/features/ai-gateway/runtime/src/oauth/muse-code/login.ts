import type { AuthService, AuthStorageEntry } from "../../auth/types.js";
import type { ProviderResult, QuotaWindow } from "../../quota/types.js";
import { parseMuseCodeUsage, type ParsedMuseCodeUsage } from "../../upstream/muse-code/quota.js";
import { createDeviceCodeClient, httpsUrl, OAuthRequestError, requestOAuthJson, type DeviceCodeConfig } from "../device-code.js";
import { createLoginSessions } from "../login-sessions.js";

export const MUSE_CODE_AUTH_PROVIDER_ID = "Fleet AI Gateway with Muse Code";
export const MUSE_CODE_KEY_URL = "https://api.meta.ai/muse-code/key";
export const MUSE_CODE_DEVICE_CONFIG: DeviceCodeConfig = {
  authorizationUrl: "https://auth.meta.com/oidc/device/authorization/",
  tokenUrl: "https://auth.meta.com/oidc/device/token/",
  clientId: "1031625952748946",
  headers: { "x-api-version": "1.0.0" },
};

/** 조회·재mint가 같은 key endpoint를 공유한다. 강제 새로고침도 이 간격·실패 backoff를 넘지 못한다. */
export const MUSE_CODE_MINT_INTERVAL_MS = 60_000;
export const MUSE_CODE_MINT_BACKOFF_MS = 5 * 60_000;

export interface MuseCodeAuthEntry extends AuthStorageEntry {
  readonly type: "oauth-device";
  readonly accessToken: string;
  readonly baseUrl?: string;
  readonly accessExpiresAt?: number;
  readonly mintedAt: number;
  readonly version: 1;
}
export type MuseCodeAuthResult =
  | { readonly status: "ok"; readonly credentials: { readonly apiKey: string; readonly baseUrl?: string } }
  | { readonly status: "signed_out" | "expired" | "unavailable" };

/** Console 슬롯만 읽는다. CLI 파일·환경변수·OS 비밀 저장소에는 접근하지 않는다. */
export async function readMuseCodeEntry(authService: Pick<AuthService, "getEntry">): Promise<MuseCodeAuthEntry | undefined> {
  const entry = await authService.getEntry(MUSE_CODE_AUTH_PROVIDER_ID);
  if (entry === undefined) return undefined;
  if (entry.type !== "oauth-device" || entry.version !== 1
    || typeof entry.key !== "string" || !entry.key.trim()
    || typeof entry.accessToken !== "string" || !entry.accessToken.trim()
    || typeof entry.mintedAt !== "number" || !Number.isFinite(entry.mintedAt)
    || (entry.baseUrl !== undefined && typeof entry.baseUrl !== "string")
    || (entry.accessExpiresAt !== undefined && (typeof entry.accessExpiresAt !== "number" || !Number.isFinite(entry.accessExpiresAt)))) {
    throw new Error("The saved Muse Code sign-in could not be read. Sign in again in Console.");
  }
  return entry as MuseCodeAuthEntry;
}

export type MuseCodeMintResult =
  | { readonly status: "ok"; readonly apiKey: string; readonly baseUrl?: string; readonly usage: ParsedMuseCodeUsage | null }
  | { readonly status: "expired" }
  | { readonly status: "entitlement_required"; readonly actionUrl?: string };

/** Meta 계정 상태를 바꾸는 onboard 필드는 보내지 않는다. 응답에서 비밀과 사용량만 선별한다. */
export async function mintMuseCodeKey(deps: {
  readonly accessToken: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<MuseCodeMintResult> {
  const { status, body } = await requestOAuthJson(deps.fetch ?? fetch, MUSE_CODE_KEY_URL, {
    method: "POST",
    headers: {
      Accept: "application/json", "Content-Type": "application/json",
      Authorization: `Bearer ${deps.accessToken}`, "x-api-version": "1.0.0",
    },
    body: "{}", ...(deps.signal ? { signal: deps.signal } : {}),
  });
  if (status === 401 || status === 403) return { status: "expired" };
  const actionUrl = httpsUrl(body.action_url);
  if ((status >= 200 && status < 300) && (body.is_subs_active === false || body.require_payment === true || actionUrl)) {
    return { status: "entitlement_required", ...(actionUrl ? { actionUrl } : {}) };
  }
  if (status !== 200 || typeof body.api_key !== "string" || !body.api_key.trim()) throw new OAuthRequestError(status);
  // API 키를 다른 origin으로 보내지 않는다. base_url은 저장하되 Meta Model API만 허용한다.
  const baseUrl = httpsUrl(body.base_url);
  if (body.base_url !== undefined && (!baseUrl || new URL(baseUrl).origin !== "https://api.meta.ai")) throw new OAuthRequestError();
  return { status: "ok", apiKey: body.api_key, ...(baseUrl ? { baseUrl } : {}), usage: parseMuseCodeUsage(body) };
}

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
