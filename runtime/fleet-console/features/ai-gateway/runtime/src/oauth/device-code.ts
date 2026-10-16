export interface DeviceCodeConfig {
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface DeviceAuthorization {
  /** 서버 메모리에만 보관한다. 브라우저 응답에는 공개 필드를 명시적으로 골라 담는다. */
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresAt: number;
  readonly interval: number;
}

export type DevicePollResult =
  | { readonly state: "pending" | "slow_down" | "denied" | "expired" }
  | { readonly state: "authorized"; readonly accessToken: string; readonly accessExpiresAt?: number };

export class OAuthRequestError extends Error {
  constructor(readonly status?: number) {
    // 공급자 오류 본문·fetch 예외에는 토큰이나 개인정보가 실릴 수 있다. 원문을 보존하지 않는다.
    super(status === undefined ? "OAuth request failed" : `OAuth request failed (HTTP ${status})`);
  }
}

export function oauthRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

/** 제한된 JSON 입출력. 리다이렉트·무한 본문·무한 대기는 허용하지 않는다. */
export async function requestOAuthJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  try {
    const response = await fetchImpl(url, { ...init, signal, redirect: "error" });
    if (response.url && response.url !== url) throw new OAuthRequestError();
    if (response.status >= 300 && response.status < 400) throw new OAuthRequestError(response.status);
    const reader = response.body?.getReader();
    if (!reader) {
      if (!response.ok) return { status: response.status, body: {} };
      throw new OAuthRequestError(response.status);
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 262_144) throw new OAuthRequestError(response.status);
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    let body: Record<string, unknown> | undefined;
    try { body = oauthRecord(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { /* 오류 본문은 비어 있거나 JSON이 아닐 수도 있다. */ }
    if (!body && response.ok) throw new OAuthRequestError(response.status);
    return { status: response.status, body: body ?? {} };
  } catch (error) {
    throw error instanceof OAuthRequestError ? error : new OAuthRequestError();
  }
}

export function createDeviceCodeClient(deps: {
  readonly config: DeviceCodeConfig;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}) {
  const { config } = deps;
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetch ?? fetch;
  const headers = { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", ...config.headers };
  return {
    async start(signal: AbortSignal): Promise<DeviceAuthorization> {
      const { status, body } = await requestOAuthJson(fetchImpl, config.authorizationUrl, {
        method: "POST", headers, body: new URLSearchParams({ client_id: config.clientId }), signal,
      });
      const verificationUri = httpsUrl(body.verification_uri);
      const complete = body.verification_uri_complete === undefined ? undefined : httpsUrl(body.verification_uri_complete);
      if (status !== 200 || typeof body.device_code !== "string" || !body.device_code
        || typeof body.user_code !== "string" || !body.user_code || !verificationUri
        || (body.verification_uri_complete !== undefined && !complete)) throw new OAuthRequestError(status);
      const lifetime = typeof body.expires_in === "number" && Number.isFinite(body.expires_in) ? body.expires_in : 900;
      const interval = typeof body.interval === "number" && Number.isFinite(body.interval) ? body.interval : 5;
      return {
        deviceCode: body.device_code, userCode: body.user_code, verificationUri,
        ...(complete ? { verificationUriComplete: complete } : {}),
        expiresAt: now() + Math.min(1800, Math.max(60, lifetime)) * 1000,
        interval: Math.min(1800, Math.max(1, interval)),
      };
    },
    async pollOnce(authorization: DeviceAuthorization, signal: AbortSignal): Promise<DevicePollResult> {
      if (authorization.expiresAt <= now()) return { state: "expired" };
      const { status, body } = await requestOAuthJson(fetchImpl, config.tokenUrl, {
        method: "POST", headers,
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: authorization.deviceCode, client_id: config.clientId,
        }), signal,
      });
      if (status === 200 && typeof body.access_token === "string" && body.access_token.trim()) {
        // 토큰의 명시한 수명, 또는 JWT exp만 읽는다. 저장·갱신은 이 클라이언트의 몫이 아니다.
        const jwtExpiry = jwtExpiresAt(body.access_token);
        const expiresAt = typeof body.expires_in === "number" && Number.isFinite(body.expires_in) && body.expires_in > 0
          ? now() + body.expires_in * 1000 : jwtExpiry;
        return { state: "authorized", accessToken: body.access_token, ...(expiresAt === undefined ? {} : { accessExpiresAt: expiresAt }) };
      }
      switch (body.error) {
        case "authorization_pending": return { state: "pending" };
        case "slow_down": return { state: "slow_down" };
        case "access_denied": return { state: "denied" };
        case "expired_token": return { state: "expired" };
        default: throw new OAuthRequestError(status);
      }
    },
  };
}

function jwtExpiresAt(token: string): number | undefined {
  try {
    const payload = oauthRecord(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
    const exp = payload?.exp;
    return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined;
  } catch { return undefined; }
}
