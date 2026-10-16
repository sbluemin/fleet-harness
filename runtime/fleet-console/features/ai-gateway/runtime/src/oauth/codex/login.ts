import type { AuthStorageEntry } from "../../auth/types.js";
import { fetchCodexUsage } from "../../upstream/codex/quota.js";
import {
  jwtPayload,
  oauthRecord,
  OAuthRequestError,
  requestOAuthJson,
  type DeviceAuthorization,
  type DevicePollResult,
} from "../device-code.js";
import {
  createSubscriptionOAuth,
  isRefreshableOAuthEntry,
  type SubscriptionOAuthDeps,
  type SubscriptionOAuthEntry,
  type SubscriptionRefreshOutcome,
  type SubscriptionTokenGrant,
} from "../subscription.js";
import {
  CODEX_AUTH_PROVIDER_ID,
  CODEX_DEVICE_LIFETIME_MS,
  CODEX_DEVICE_REDIRECT_URI,
  CODEX_DEVICE_TOKEN_URL,
  CODEX_DEVICE_USERCODE_URL,
  CODEX_DEVICE_VERIFICATION_URL,
  CODEX_JWT_AUTH_CLAIM,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_TOKEN_URL,
} from "./config.js";

/** `accountId`는 ChatGPT 워크스페이스(구독 풀)다. 바꾸려면 다시 로그인한다. */
export interface CodexAuthEntry extends SubscriptionOAuthEntry {
  readonly refreshToken: string;
  readonly accountId: string;
}

export interface CodexOAuthDeps extends SubscriptionOAuthDeps {
  readonly fetch?: typeof fetch;
}

const JSON_HEADERS = { Accept: "application/json", "Content-Type": "application/json" };
const FORM_HEADERS = { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" };

/** 응답 interval(초, 문자열일 수도 있다)에 Codex CLI처럼 3초를 더한다. */
function pollInterval(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  const base = Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
  return Math.min(60, base + 3);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** access token의 `https://api.openai.com/auth` claim에서 ChatGPT 계정 id를 꺼낸다. */
export function codexAccountIdFromToken(accessToken: string): string | undefined {
  return nonEmpty(oauthRecord(jwtPayload(accessToken)?.[CODEX_JWT_AUTH_CLAIM])?.chatgpt_account_id);
}

/** 교환·갱신 모두 access·refresh·expires_in을 요구한다. 하나라도 없으면 응답을 믿지 않는다. */
function tokenGrant(status: number, body: Record<string, unknown>, now: number): SubscriptionTokenGrant & { readonly refreshToken: string } {
  const accessToken = nonEmpty(body.access_token);
  const refreshToken = nonEmpty(body.refresh_token);
  const expiresIn = body.expires_in;
  if (status !== 200 || !accessToken || !refreshToken
    || typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new OAuthRequestError(status);
  return { accessToken, refreshToken, accessExpiresAt: now + expiresIn * 1000 };
}

export function parseCodexAuthEntry(entry: AuthStorageEntry): CodexAuthEntry | undefined {
  return isRefreshableOAuthEntry(entry) && nonEmpty(entry.accountId) !== undefined
    ? entry as CodexAuthEntry : undefined;
}

/**
 * Codex(ChatGPT 구독) Console 로그인. device 흐름은 Codex 고유 형식이다 — usercode 발급 →
 * 승인 대기(403/404) → 서버가 준 authorization_code·code_verifier로 PKCE 교환.
 * 브라우저 콜백 흐름은 원격·모바일에서 끝나지 않으므로 두지 않는다.
 */
export function createCodexOAuth(deps: CodexOAuthDeps) {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetch ?? fetch;

  async function exchange(code: string, verifier: string, signal: AbortSignal): Promise<Extract<DevicePollResult, { state: "authorized" }>> {
    const { status, body } = await requestOAuthJson(fetchImpl, CODEX_OAUTH_TOKEN_URL, {
      method: "POST", headers: FORM_HEADERS, signal,
      body: new URLSearchParams({
        grant_type: "authorization_code", client_id: CODEX_OAUTH_CLIENT_ID,
        code, code_verifier: verifier, redirect_uri: CODEX_DEVICE_REDIRECT_URI,
      }),
    });
    const grant = tokenGrant(status, body, now());
    const accountId = codexAccountIdFromToken(grant.accessToken);
    // 계정 id가 없으면 추론 요청의 chatgpt-account-id를 채울 수 없다. 반쯤 쓸 수 있는 로그인을 저장하지 않는다.
    if (!accountId) throw new OAuthRequestError(status);
    return { state: "authorized", ...grant, accountId };
  }

  async function refresh(entry: CodexAuthEntry, signal: AbortSignal): Promise<SubscriptionRefreshOutcome> {
    const { status, body } = await requestOAuthJson(fetchImpl, CODEX_OAUTH_TOKEN_URL, {
      method: "POST", headers: FORM_HEADERS, signal,
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: entry.refreshToken, client_id: CODEX_OAUTH_CLIENT_ID }),
    });
    if (status === 400 || status === 401) return { status: "rejected" };
    return { status: "ok", grant: tokenGrant(status, body, now()) };
  }

  const oauth = createSubscriptionOAuth<CodexAuthEntry>({
    provider: "codex",
    label: "Codex",
    providerId: CODEX_AUTH_PROVIDER_ID,
    flow: {
      async start(signal): Promise<DeviceAuthorization> {
        const { status, body } = await requestOAuthJson(fetchImpl, CODEX_DEVICE_USERCODE_URL, {
          method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }), signal,
        });
        const deviceAuthId = nonEmpty(body.device_auth_id);
        const userCode = nonEmpty(body.user_code);
        if (status !== 200 || !deviceAuthId || !userCode) throw new OAuthRequestError(status);
        return {
          deviceCode: deviceAuthId, userCode, verificationUri: CODEX_DEVICE_VERIFICATION_URL,
          expiresAt: now() + CODEX_DEVICE_LIFETIME_MS, interval: pollInterval(body.interval),
        };
      },
      async pollOnce(authorization, signal): Promise<DevicePollResult> {
        if (authorization.expiresAt <= now()) return { state: "expired" };
        const { status, body } = await requestOAuthJson(fetchImpl, CODEX_DEVICE_TOKEN_URL, {
          method: "POST", headers: JSON_HEADERS, signal,
          body: JSON.stringify({ device_auth_id: authorization.deviceCode, user_code: authorization.userCode }),
        });
        // 승인 전에는 403/404로 답한다.
        if (status === 403 || status === 404) return { state: "pending" };
        const code = nonEmpty(body.authorization_code);
        const verifier = nonEmpty(body.code_verifier);
        if (status !== 200 || !code || !verifier) throw new OAuthRequestError(status);
        return exchange(code, verifier, signal);
      },
    },
    buildEntry(token) {
      if (!token.refreshToken || !token.accountId || token.accessExpiresAt === undefined) throw new OAuthRequestError();
      return {
        key: token.accessToken, type: "oauth", refreshToken: token.refreshToken,
        accessExpiresAt: token.accessExpiresAt, accountId: token.accountId, version: 1,
      };
    },
    parseEntry: parseCodexAuthEntry,
    refresh,
    fetchQuota: (entry) => fetchCodexUsage(
      { accessToken: entry.key, accountId: entry.accountId },
      { fetch: fetchImpl, now },
    ),
  }, deps);

  return {
    ...oauth,
    /** 추론 라우터가 받는 형태. 계정 id 없는 자격은 없다 — 로그인이 그런 항목을 저장하지 않는다. */
    async readSubscription(): Promise<{ readonly accessToken: string; readonly accountId: string } | null> {
      const auth = await oauth.read();
      return auth.status === "ok" ? { accessToken: auth.entry.key, accountId: auth.entry.accountId } : null;
    },
  };
}

export type CodexOAuth = ReturnType<typeof createCodexOAuth>;
