import type { AuthStorageEntry } from "../../auth/types.js";
import type { CredentialResolverDeps } from "../../transport/credentials.js";
import { resolveXaiCliAuth } from "../../upstream/xai/credentials.js";
import { fetchXaiUsage } from "../../upstream/xai/quota.js";
import {
  createDeviceCodeClient,
  jwtExpiresAt,
  OAuthRequestError,
  requestOAuthJson,
  type DeviceAuthorization,
  type DeviceCodeConfig,
} from "../device-code.js";
import {
  createSubscriptionOAuth,
  isRefreshableOAuthEntry,
  type SubscriptionOAuthDeps,
  type SubscriptionOAuthEntry,
  type SubscriptionRefreshOutcome,
} from "../subscription.js";

export const XAI_AUTH_PROVIDER_ID = "Fleet AI Gateway with xAI";
/** Grok CLI의 공개 client id. 다른 id는 `unauthorized_client`로 거절된다. */
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
/** OIDC discovery가 알려 주는 token endpoint를 고정한다. 발견 문서를 매번 따라가지 않는다. */
export const XAI_OAUTH_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const XAI_DEVICE_CONFIG: DeviceCodeConfig = {
  authorizationUrl: "https://auth.x.ai/oauth2/device/code",
  tokenUrl: XAI_OAUTH_TOKEN_URL,
  clientId: XAI_OAUTH_CLIENT_ID,
  scope: "openid profile email offline_access grok-cli:access api:access",
};
/** 수명 정보가 없는 access token에 둘 만료. */
export const XAI_FALLBACK_ACCESS_TTL_MS = 3_600_000;

export type XaiAuthEntry = SubscriptionOAuthEntry & {
  readonly refreshToken?: string;
  readonly userId?: string;
};

export interface XaiOAuthDeps extends SubscriptionOAuthDeps {
  readonly fetch?: typeof fetch;
  /** 있으면 Fleet 항목이 없을 때만 Grok CLI `auth.json`을 읽는다. 갱신하거나 쓰지 않는다. */
  readonly cliCredentials?: CredentialResolverDeps;
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

/** Fleet 항목이 없을 때 status·추론이 같이 보는 읽기 전용 판정. 갱신하거나 파일을 쓰지 않는다. */
export async function xaiCliSubscriptionPresent(deps: CredentialResolverDeps, now = Date.now()): Promise<boolean> {
  const result = await resolveXaiCliAuth(deps, { now: () => now });
  return result.status === "ok";
}

export function parseXaiAuthEntry(entry: AuthStorageEntry): XaiAuthEntry | undefined {
  return isRefreshableOAuthEntry(entry) ? entry : undefined;
}

/**
 * xAI(SuperGrok) Console 로그인. RFC 8628 device 흐름이며, 갱신 토큰은 회전될 수 있다 —
 * 응답이 새 값을 주면 그것으로 바꾸고, 없으면 요청에 쓴 값을 유지한다. 벤더 `~/.grok`
 * 파일은 Fleet 항목이 없을 때만 읽고, 갱신하거나 쓰지 않는다. `x-grok-client-version`의
 * CLI 버전 탐색은 자격과 별개다.
 */
export function createXaiOAuth(deps: XaiOAuthDeps) {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetch ?? fetch;
  const device = createDeviceCodeClient({ config: XAI_DEVICE_CONFIG, fetch: fetchImpl, now });

  const expiresAt = (accessToken: string, expiresIn: unknown): number =>
    typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? now() + expiresIn * 1000
      : jwtExpiresAt(accessToken) ?? now() + XAI_FALLBACK_ACCESS_TTL_MS;

  async function refresh(entry: XaiAuthEntry & { readonly refreshToken: string }, signal: AbortSignal): Promise<SubscriptionRefreshOutcome> {
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

  const cli = deps.cliCredentials;
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
    rememberSignOut: true,
    readAbsent: cli === undefined ? undefined : async () => {
      const result = await resolveXaiCliAuth(cli, { now });
      if (result.status !== "ok") return undefined;
      const { accessToken, expiresAt, userId } = result.credentials;
      return {
        key: accessToken,
        type: "oauth",
        accessExpiresAt: expiresAt ?? Number.MAX_SAFE_INTEGER,
        version: 1,
        ...(userId === undefined ? {} : { userId }),
      };
    },
    refresh,
    fetchQuota: (entry) => fetchXaiUsage(
      { accessToken: entry.key, ...(entry.userId === undefined ? {} : { userId: entry.userId }) },
      { fetch: fetchImpl, now },
    ),
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
