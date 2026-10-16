import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { AuthStorageEntry } from "../../auth/types.js";
import { fetchCursorUsage } from "../../upstream/cursor/quota.js";
import {
  jwtExpiresAt,
  OAuthRequestError,
  requestOAuthJson,
  type DeviceAuthorization,
  type DevicePollResult,
} from "../device-code.js";
import {
  createSubscriptionOAuth,
  isSubscriptionOAuthEntry,
  type SubscriptionOAuthDeps,
  type SubscriptionOAuthEntry,
} from "../subscription.js";
import {
  CURSOR_AUTH_PROVIDER_ID,
  CURSOR_FALLBACK_ACCESS_TTL_MS,
  CURSOR_LOGIN_LIFETIME_MS,
  CURSOR_LOGIN_URL,
  CURSOR_POLL_INTERVAL_SECONDS,
  CURSOR_POLL_MAX_CONSECUTIVE_ERRORS,
  CURSOR_POLL_URL,
} from "./config.js";

/** 갱신하지 않으므로 갱신 토큰을 두지 않는다. access token을 JWT 만료까지 쓴다. */
export type CursorAuthEntry = SubscriptionOAuthEntry;

export interface CursorOAuthDeps extends SubscriptionOAuthDeps {
  readonly fetch?: typeof fetch;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** 이전 형식(갱신 토큰을 저장하던 항목)도 읽는다. 갱신 토큰은 쓰지 않으므로 버린다. */
export function parseCursorAuthEntry(entry: AuthStorageEntry): CursorAuthEntry | undefined {
  if (!isSubscriptionOAuthEntry(entry)) return undefined;
  const { refreshToken: _unused, ...rest } = entry;
  return rest as CursorAuthEntry;
}

/**
 * Cursor Console 로그인. device code가 없다 — 서버가 PKCE verifier와 uuid를 만들고, 사용자는
 * challenge·uuid가 실린 cursor.com 페이지에서 승인하며, 서버는 api2.cursor.sh를 폴링해 토큰을
 * 받는다. localhost 콜백이 없어 원격 브라우저에서도 끝난다. 키체인·`~/.cursor`는 보지 않는다.
 *
 * 갱신하지 않는다. poll이 주는 refreshToken은 accessToken과 같은 값이고, 그것으로
 * `exchange_user_api_key`를 부르면 401 "Invalid User API Key"다(실측 2026-10-16). access token은
 * JWT 만료(약 60일)까지 그대로 쓰고, 만료되면 `expired`로 로그인 카드가 다시 선다.
 */
export function createCursorOAuth(deps: CursorOAuthDeps) {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetch ?? fetch;
  /** 로그인마다 연이은 일시 오류 수. 세션이 끝나면 함께 사라진다. */
  const pollErrors = new WeakMap<DeviceAuthorization, number>();

  const expiresAt = (accessToken: string) => jwtExpiresAt(accessToken) ?? now() + CURSOR_FALLBACK_ACCESS_TTL_MS;

  async function pollOnce(authorization: DeviceAuthorization, signal: AbortSignal): Promise<DevicePollResult> {
    if (authorization.expiresAt <= now()) return { state: "expired" };
    const uuid = new URL(authorization.verificationUri).searchParams.get("uuid") ?? "";
    const url = `${CURSOR_POLL_URL}?${new URLSearchParams({ uuid, verifier: authorization.deviceCode })}`;
    let response: Awaited<ReturnType<typeof requestOAuthJson>>;
    try {
      response = await requestOAuthJson(fetchImpl, url, { method: "GET", headers: { Accept: "application/json" }, signal });
    } catch (error) {
      signal.throwIfAborted();
      const errors = (pollErrors.get(authorization) ?? 0) + 1;
      pollErrors.set(authorization, errors);
      if (errors >= CURSOR_POLL_MAX_CONSECUTIVE_ERRORS) throw error;
      return { state: "pending" };
    }
    pollErrors.delete(authorization);
    // 승인 전에는 404로 답한다.
    if (response.status === 404) return { state: "pending" };
    const accessToken = nonEmpty(response.body.accessToken);
    if (response.status !== 200 || !accessToken) throw new OAuthRequestError(response.status);
    return { state: "authorized", accessToken, accessExpiresAt: expiresAt(accessToken) };
  }

  const oauth = createSubscriptionOAuth<CursorAuthEntry>({
    provider: "cursor",
    label: "Cursor",
    providerId: CURSOR_AUTH_PROVIDER_ID,
    flow: {
      async start(): Promise<DeviceAuthorization> {
        const verifier = randomBytes(96).toString("base64url");
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        const params = new URLSearchParams({ challenge, uuid: randomUUID(), mode: "login", redirectTarget: "cli" });
        // 입력할 코드가 없다. 공개 DTO의 userCode는 빈 문자열이고, 화면은 링크만 연다.
        return {
          deviceCode: verifier, userCode: "", verificationUri: `${CURSOR_LOGIN_URL}?${params}`,
          expiresAt: now() + CURSOR_LOGIN_LIFETIME_MS, interval: CURSOR_POLL_INTERVAL_SECONDS,
        };
      },
      pollOnce,
    },
    buildEntry(token) {
      return { key: token.accessToken, type: "oauth", accessExpiresAt: token.accessExpiresAt ?? expiresAt(token.accessToken), version: 1 };
    },
    parseEntry: parseCursorAuthEntry,
    fetchQuota: (entry) => fetchCursorUsage({ accessToken: entry.key }, { fetch: fetchImpl, now }),
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

export type CursorOAuth = ReturnType<typeof createCursorOAuth>;
