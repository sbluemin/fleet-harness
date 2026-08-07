import crypto from "node:crypto";

export function readBearerToken(headers: { readonly authorization?: string | string[] }): string | null {
  const header = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

/**
 * 접근 자격은 발급 대상(audience)에 묶인다. 루프백 리스너용으로 발급된 자격은 원격
 * 리스너에서 거부되므로, 같은 조인 문법을 쓰면서도 로컬 자격이 원격으로 재생되지 않는다.
 */
export type AccessAudience = "local" | "remote";

export const SESSION_COOKIE_NAME = "fleet_console_session";

/** 링크 1회 교환용 자격. 사용되면 즉시 소멸하고, 미사용 상태로도 짧게만 살아 있는다. */
export interface AccessGrant {
  readonly token: string;
  readonly audience: AccessAudience;
  readonly expiresAt: number;
}

export interface AccessSession {
  readonly id: string;
  readonly audience: AccessAudience;
  readonly expiresAt: number;
}

export interface AccessRegistryDeps {
  /** 미사용 링크가 유효한 시간. 유출된 링크의 재생 창을 좁게 유지한다. */
  readonly grantTtlMs?: number;
  readonly sessionTtlMs?: number;
  readonly sessionIdleTtlMs?: number;
  readonly now?: () => number;
  readonly randomToken?: () => string;
}

export interface AccessRegistry {
  readonly grantTtlMs: number;
  issueGrant(audience: AccessAudience): AccessGrant;
  /** 리스너의 audience와 일치하는 grant만 세션으로 교환된다. 교환된 grant는 소멸한다. */
  redeemGrant(token: string | null, audience: AccessAudience): AccessSession | null;
  resolveSession(id: string | null, audience: AccessAudience): AccessSession | null;
  revokeSession(id: string): boolean;
  revokeAllSessions(): void;
  prune(): void;
}

interface StoredSession {
  readonly audience: AccessAudience;
  readonly absoluteExpiresAt: number;
  idleExpiresAt: number;
}

const DEFAULT_GRANT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_SESSION_IDLE_TTL_MS = 60 * 60 * 1000;

export function createAccessRegistry(deps: AccessRegistryDeps = {}): AccessRegistry {
  const grantTtlMs = deps.grantTtlMs ?? DEFAULT_GRANT_TTL_MS;
  const sessionTtlMs = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const sessionIdleTtlMs = deps.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS;
  const now = deps.now ?? Date.now;
  const randomToken = deps.randomToken ?? (() => crypto.randomBytes(32).toString("base64url"));
  const grants = new Map<string, AccessGrant>();
  const sessions = new Map<string, StoredSession>();

  function issueGrant(audience: AccessAudience): AccessGrant {
    prune();
    const grant: AccessGrant = { token: randomToken(), audience, expiresAt: now() + grantTtlMs };
    grants.set(grant.token, grant);
    return grant;
  }

  function redeemGrant(token: string | null, audience: AccessAudience): AccessSession | null {
    prune();
    if (!token) return null;
    const grant = grants.get(token);
    if (!grant) return null;
    grants.delete(token);
    if (grant.expiresAt <= now() || grant.audience !== audience) return null;
    return openSession(audience);
  }

  function openSession(audience: AccessAudience): AccessSession {
    const id = randomToken();
    const current = now();
    const absoluteExpiresAt = current + sessionTtlMs;
    sessions.set(id, { audience, absoluteExpiresAt, idleExpiresAt: current + sessionIdleTtlMs });
    return { id, audience, expiresAt: absoluteExpiresAt };
  }

  function resolveSession(id: string | null, audience: AccessAudience): AccessSession | null {
    prune();
    if (!id) return null;
    const stored = sessions.get(id);
    if (!stored || stored.audience !== audience) return null;
    const current = now();
    // 유휴 만료는 접근할 때마다 밀리되 절대 만료를 넘기지 못한다.
    stored.idleExpiresAt = Math.min(current + sessionIdleTtlMs, stored.absoluteExpiresAt);
    return { id, audience: stored.audience, expiresAt: stored.absoluteExpiresAt };
  }

  function revokeSession(id: string): boolean {
    return sessions.delete(id);
  }

  function revokeAllSessions(): void {
    sessions.clear();
  }

  function prune(): void {
    const current = now();
    for (const [token, grant] of grants) {
      if (grant.expiresAt <= current) grants.delete(token);
    }
    for (const [id, stored] of sessions) {
      if (stored.absoluteExpiresAt <= current || stored.idleExpiresAt <= current) sessions.delete(id);
    }
  }

  return { grantTtlMs, issueGrant, redeemGrant, resolveSession, revokeSession, revokeAllSessions, prune };
}

/** 요청 쿠키에서 세션 식별자만 읽는다. 다른 쿠키는 무시한다. */
export function readSessionCookie(headers: { readonly cookie?: string | string[] }): string | null {
  const raw = Array.isArray(headers.cookie) ? headers.cookie[0] : headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

export function formatSessionCookie(session: AccessSession, options: { readonly secure: boolean }): string {
  const attributes = [`${SESSION_COOKIE_NAME}=${session.id}`, "HttpOnly", "SameSite=Strict", "Path=/"];
  if (options.secure) attributes.push("Secure");
  return attributes.join("; ");
}
