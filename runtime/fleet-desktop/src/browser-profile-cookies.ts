/** 종료 때 세션 쿠키에 붙이는 만료. 매 종료마다 연장하지 않으므로 이 상한이 수명이다. */
export const PROFILE_SESSION_COOKIE_MAX_AGE_SECONDS = 14 * 24 * 60 * 60;

/** 종료 경로가 쿠키 저장을 기다리는 상한. 넘기면 경고만 남기고 종료는 계속한다. */
export const PROFILE_SESSION_COOKIE_PERSIST_TIMEOUT_MS = 2_000;

export interface ProfileCookieRecord {
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly hostOnly?: boolean;
  readonly path?: string;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly session?: boolean;
  readonly sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
}

export interface ProfileCookieWrite {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  readonly path: string;
  readonly domain?: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly expirationDate: number;
  readonly sameSite: ProfileCookieRecord["sameSite"];
}

export interface ProfileCookieJar {
  get(): Promise<readonly ProfileCookieRecord[]>;
  set(details: ProfileCookieWrite): Promise<void>;
  flush(): Promise<void>;
}

/**
 * 세션 쿠키만 만료가 있는 쿠키로 바꾼다. 이미 만료가 있는 쿠키는 null — 다음 종료에 연장하지 않는다.
 * `__Host-` 는 Domain 없이 Path=/·Secure, `__Secure-` 와 SameSite=None 은 Secure 로 맞춘다.
 */
export function sessionCookiePromotion(cookie: ProfileCookieRecord, nowSeconds: number, maxAgeSeconds: number): ProfileCookieWrite | null {
  if (cookie.session !== true) return null;
  const host = (cookie.domain ?? "").replace(/^\./u, "");
  if (host.length === 0 || host.includes("/") || host.includes(" ")) return null;
  const hostCookie = cookie.name.startsWith("__Host-");
  const secure = hostCookie || cookie.name.startsWith("__Secure-") || cookie.sameSite === "no_restriction" || cookie.secure === true;
  const path = hostCookie ? "/" : (cookie.path && cookie.path.startsWith("/") ? cookie.path : "/");
  const url = `${secure ? "https" : "http"}://${host}${path}`;
  const write: ProfileCookieWrite = {
    url,
    name: cookie.name,
    value: cookie.value,
    path,
    secure,
    httpOnly: cookie.httpOnly === true,
    expirationDate: nowSeconds + maxAgeSeconds,
    sameSite: cookie.sameSite,
  };
  if (!hostCookie && cookie.hostOnly !== true && cookie.domain) return { ...write, domain: cookie.domain };
  return write;
}

/** 넘겨받은 프로필 저장소만 다룬다. 임시 파티션 저장소는 호출자가 넣지 않는다. */
export async function persistProfileSessionCookies(jars: readonly ProfileCookieJar[], nowSeconds: number, maxAgeSeconds: number): Promise<number> {
  let failed = 0;
  for (const jar of jars) {
    let cookies: readonly ProfileCookieRecord[] = [];
    try {
      cookies = await jar.get();
    } catch {
      failed += 1;
      continue;
    }
    for (const cookie of cookies) {
      const write = sessionCookiePromotion(cookie, nowSeconds, maxAgeSeconds);
      if (!write) continue;
      try {
        await jar.set(write);
      } catch {
        failed += 1;
      }
    }
    try {
      await jar.flush();
    } catch {
      failed += 1;
    }
  }
  return failed;
}
