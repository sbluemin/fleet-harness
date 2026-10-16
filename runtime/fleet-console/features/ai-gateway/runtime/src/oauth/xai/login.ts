import type { AuthStorageEntry } from "../../auth/types.js";
import { fetchXaiUsage } from "../../upstream/xai/quota.js";
import {
  createDeviceCodeClient,
  jwtExpiresAt,
  OAuthRequestError,
  requestOAuthJson,
  type DeviceAuthorization,
} from "../device-code.js";
import {
  createSubscriptionOAuth,
  isRefreshableOAuthEntry,
  type SubscriptionOAuthDeps,
  type SubscriptionOAuthEntry,
  type SubscriptionRefreshOutcome,
} from "../subscription.js";
import {
  XAI_AUTH_PROVIDER_ID,
  XAI_DEVICE_CONFIG,
  XAI_FALLBACK_ACCESS_TTL_MS,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_TOKEN_URL,
} from "./config.js";

export type XaiAuthEntry = SubscriptionOAuthEntry & { readonly refreshToken: string };

export interface XaiOAuthDeps extends SubscriptionOAuthDeps {
  readonly fetch?: typeof fetch;
}

/** 승인 페이지는 xAI의 https 페이지여야 한다. 다른 호스트로 사용자를 보내지 않는다. */
function isXaiUrl(value: string | undefined): boolean {
  if (value === undefined) return false;
  const host = new URL(value).hostname;
  return host === "x.ai" || host.endsWith(".x.ai");
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function parseXaiAuthEntry(entry: AuthStorageEntry): XaiAuthEntry | undefined {
  return isRefreshableOAuthEntry(entry) ? entry : undefined;
}

/**
 * xAI(SuperGrok) Console 로그인. RFC 8628 device 흐름이며, 갱신 토큰은 회전될 수 있다 —
 * 응답이 새 값을 주면 그것으로 바꾸고, 없으면 요청에 쓴 값을 유지한다. 벤더 `~/.grok`
 * 파일은 읽지도 쓰지도 않는다. `x-grok-client-version`의 CLI 버전 탐색은 자격과 별개다.
 */
export function createXaiOAuth(deps: XaiOAuthDeps) {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetch ?? fetch;
  const device = createDeviceCodeClient({ config: XAI_DEVICE_CONFIG, fetch: fetchImpl, now });

  const expiresAt = (accessToken: string, expiresIn: unknown): number =>
    typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? now() + expiresIn * 1000
      : jwtExpiresAt(accessToken) ?? now() + XAI_FALLBACK_ACCESS_TTL_MS;

  async function refresh(entry: XaiAuthEntry, signal: AbortSignal): Promise<SubscriptionRefreshOutcome> {
    const { status, body } = await requestOAuthJson(fetchImpl, XAI_OAUTH_TOKEN_URL, {
      method: "POST", signal,
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: XAI_OAUTH_CLIENT_ID, refresh_token: entry.refreshToken }),
    });
    if (status === 400 || status === 401) return { status: "rejected" };
    const accessToken = nonEmpty(body.access_token);
    if (status !== 200 || !accessToken) throw new OAuthRequestError(status);
    const rotated = nonEmpty(body.refresh_token);
    return {
      status: "ok",
      grant: { accessToken, accessExpiresAt: expiresAt(accessToken, body.expires_in), ...(rotated ? { refreshToken: rotated } : {}) },
    };
  }

  const oauth = createSubscriptionOAuth<XaiAuthEntry>({
    provider: "xai",
    label: "xAI",
    providerId: XAI_AUTH_PROVIDER_ID,
    flow: {
      async start(signal): Promise<DeviceAuthorization> {
        const authorization = await device.start(signal);
        if (!isXaiUrl(authorization.verificationUri)
          || (authorization.verificationUriComplete !== undefined && !isXaiUrl(authorization.verificationUriComplete))) {
          throw new OAuthRequestError();
        }
        return authorization;
      },
      pollOnce: device.pollOnce,
    },
    buildEntry(token) {
      // 갱신할 수 없는 로그인은 한 시간 뒤 조용히 끊긴다. 저장하지 않는다.
      if (!token.refreshToken) throw new OAuthRequestError();
      return {
        key: token.accessToken, type: "oauth", refreshToken: token.refreshToken,
        accessExpiresAt: token.accessExpiresAt ?? jwtExpiresAt(token.accessToken) ?? now() + XAI_FALLBACK_ACCESS_TTL_MS,
        version: 1,
      };
    },
    parseEntry: parseXaiAuthEntry,
    refresh,
    fetchQuota: (entry) => fetchXaiUsage({ accessToken: entry.key }, { fetch: fetchImpl, now }),
  }, deps);

  return {
    ...oauth,
    /** 추론 라우터가 받는 형태: 지금 쓸 수 있는 access token, 없으면 null. */
    async readSubscriptionToken(): Promise<string | null> {
      const auth = await oauth.read();
      return auth.status === "ok" ? auth.entry.key : null;
    },
  };
}

export type XaiOAuth = ReturnType<typeof createXaiOAuth>;
