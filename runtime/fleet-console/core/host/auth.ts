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

/**
 * 링크 1회 교환용 자격. 사용되면 즉시 소멸하고, 미사용 상태로도 짧게만 살아 있는다.
 *
 * `id`와 `token`은 서로 다른 값이어야 한다. 발급된 자격을 목록으로 보여주고 하나씩 회수하려면
 * 가리킬 이름이 필요한데, 그 이름이 자격 자체이면 목록을 보는 것만으로 자격을 얻게 된다.
 */
export interface AccessGrant {
  readonly id: string;
  readonly token: string;
  readonly audience: AccessAudience;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** 발급 사실만 담은 공개 표현. 토큰은 발급 시점 응답에만 실리고 다시는 나가지 않는다. */
export interface AccessGrantSummary {
  readonly id: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface AccessSession {
  /** 쿠키에 실리는 비밀 값. */
  readonly id: string;
  /** 세션을 가리키는 공개 이름. 쿠키 값과 달리 목록에 실어도 안전하다. */
  readonly handle: string;
  readonly audience: AccessAudience;
  readonly expiresAt: number;
}

export interface AccessSessionSummary {
  readonly handle: string;
  readonly openedAt: number;
  readonly expiresAt: number;
  readonly lastSeenAt: number;
}

export interface AccessRegistryDeps {
  /** 미사용 링크가 유효한 시간. 유출된 링크의 재생 창을 좁게 유지한다. */
  readonly grantTtlMs?: number;
  readonly sessionTtlMs?: number;
  readonly sessionIdleTtlMs?: number;
  readonly now?: () => number;
  readonly randomToken?: () => string;
  /** 목록에 실리는 공개 이름. 토큰과 다른 생성기를 써서 둘을 섞을 여지를 없앤다. */
  readonly randomHandle?: () => string;
}

export interface AccessRegistry {
  readonly grantTtlMs: number;
  issueGrant(audience: AccessAudience): AccessGrant;
  /** 리스너의 audience와 일치하는 grant만 세션으로 교환된다. 교환된 grant는 소멸한다. */
  redeemGrant(token: string | null, audience: AccessAudience): AccessSession | null;
  resolveSession(id: string | null, audience: AccessAudience): AccessSession | null;
  listGrants(audience: AccessAudience): readonly AccessGrantSummary[];
  /** 아직 쓰이지 않은 링크를 하나만 무효화한다. */
  revokeGrant(id: string): boolean;
  /** 이 audience의 미사용 링크를 전부 무효화한다. */
  revokeGrants(audience: AccessAudience): void;
  listSessions(audience: AccessAudience): readonly AccessSessionSummary[];
  revokeSession(id: string): boolean;
  /** 이미 열린 세션 하나를 공개 이름으로 끊는다. */
  revokeSessionByHandle(handle: string): boolean;
  /** 원격을 끄면 그 audience의 세션도 함께 죽는다 — 리스너만 닫으면 자격은 살아 남는다. */
  revokeSessions(audience: AccessAudience): void;
  revokeAllSessions(): void;
  prune(): void;
}

interface StoredSession {
  readonly handle: string;
  readonly audience: AccessAudience;
  readonly openedAt: number;
  readonly absoluteExpiresAt: number;
  idleExpiresAt: number;
  lastSeenAt: number;
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
  const randomHandle = deps.randomHandle ?? (() => crypto.randomBytes(8).toString("hex"));
  const grants = new Map<string, AccessGrant>();
  const sessions = new Map<string, StoredSession>();

  function issueGrant(audience: AccessAudience): AccessGrant {
    prune();
    const issuedAt = now();
    const grant: AccessGrant = { id: randomHandle(), token: randomToken(), audience, issuedAt, expiresAt: issuedAt + grantTtlMs };
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
    const handle = randomHandle();
    const current = now();
    const absoluteExpiresAt = current + sessionTtlMs;
    sessions.set(id, { handle, audience, openedAt: current, absoluteExpiresAt, idleExpiresAt: current + sessionIdleTtlMs, lastSeenAt: current });
    return { id, handle, audience, expiresAt: absoluteExpiresAt };
  }

  function resolveSession(id: string | null, audience: AccessAudience): AccessSession | null {
    prune();
    if (!id) return null;
    const stored = sessions.get(id);
    if (!stored || stored.audience !== audience) return null;
    const current = now();
    // 유휴 만료는 접근할 때마다 밀리되 절대 만료를 넘기지 못한다.
    stored.idleExpiresAt = Math.min(current + sessionIdleTtlMs, stored.absoluteExpiresAt);
    stored.lastSeenAt = current;
    return { id, handle: stored.handle, audience: stored.audience, expiresAt: stored.absoluteExpiresAt };
  }

  function listGrants(audience: AccessAudience): readonly AccessGrantSummary[] {
    prune();
    return [...grants.values()]
      .filter((grant) => grant.audience === audience)
      .map((grant) => ({ id: grant.id, issuedAt: grant.issuedAt, expiresAt: grant.expiresAt }))
      .sort((left, right) => right.issuedAt - left.issuedAt);
  }

  function revokeGrant(id: string): boolean {
    for (const [token, grant] of grants) {
      if (grant.id === id) return grants.delete(token);
    }
    return false;
  }

  function revokeGrants(audience: AccessAudience): void {
    for (const [token, grant] of grants) {
      if (grant.audience === audience) grants.delete(token);
    }
  }

  function listSessions(audience: AccessAudience): readonly AccessSessionSummary[] {
    prune();
    return [...sessions.values()]
      .filter((stored) => stored.audience === audience)
      .map((stored) => ({ handle: stored.handle, openedAt: stored.openedAt, expiresAt: stored.absoluteExpiresAt, lastSeenAt: stored.lastSeenAt }))
      .sort((left, right) => right.openedAt - left.openedAt);
  }

  function revokeSessionByHandle(handle: string): boolean {
    for (const [id, stored] of sessions) {
      if (stored.handle === handle) return sessions.delete(id);
    }
    return false;
  }

  function revokeSession(id: string): boolean {
    return sessions.delete(id);
  }

  function revokeSessions(audience: AccessAudience): void {
    for (const [id, stored] of sessions) {
      if (stored.audience === audience) sessions.delete(id);
    }
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

  return { grantTtlMs, issueGrant, redeemGrant, resolveSession, listGrants, revokeGrant, revokeGrants, listSessions, revokeSession, revokeSessionByHandle, revokeSessions, revokeAllSessions, prune };
}

/**
 * 리스너마다 신뢰 경계가 다르다. 루프백은 평문 http에 기존 Host/Origin 게이트를 쓰고,
 * 원격은 https에 세션을 요구한다. 두 리스너가 하나의 핸들러를 공유하므로, 요청이 어느
 * 리스너로 들어왔는지는 소켓의 로컬 주소로만 판별할 수 있다.
 */
export interface ListenerIdentity {
  readonly audience: AccessAudience;
  /** Host 헤더와 대조할 호스트 부분. */
  readonly host: string;
  readonly port: number;
  /** 브라우저 Origin과 대조할 정규 origin. */
  readonly origin: string;
  readonly secure: boolean;
  /** 이 리스너가 바인드한 로컬 주소. 요청 소켓의 localAddress와 대조한다. */
  readonly bindAddress: string;
}

export function createLoopbackListenerIdentity(port: number): ListenerIdentity {
  return { audience: "local", host: "127.0.0.1", port, origin: `http://127.0.0.1:${port}`, secure: false, bindAddress: "127.0.0.1" };
}

/** IPv4-mapped IPv6(`::ffff:127.0.0.1`)와 IPv6 루프백을 같은 주소로 본다. */
export function normalizeBindAddress(address: string | undefined): string {
  if (!address) return "";
  const stripped = address.startsWith("::ffff:") ? address.slice(7) : address;
  return stripped === "::1" ? "127.0.0.1" : stripped;
}

export function resolveListenerIdentity(
  listeners: readonly ListenerIdentity[],
  socket: { readonly localAddress?: string | undefined; readonly localPort?: number | undefined },
): ListenerIdentity | null {
  const address = normalizeBindAddress(socket.localAddress);
  return listeners.find((listener) => listener.bindAddress === address && (socket.localPort === undefined || listener.port === socket.localPort)) ?? null;
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
