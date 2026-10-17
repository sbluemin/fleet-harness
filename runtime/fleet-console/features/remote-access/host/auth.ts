import crypto from "node:crypto";

import type { ControlReclaimedReason } from "./access-control-contract.js";

/**
 * 접근 자격은 발급 대상(audience)에 묶인다. 루프백 리스너용으로 발급된 자격은 원격
 * 리스너에서 거부되므로, 같은 조인 문법을 쓰면서도 로컬 자격이 원격으로 재생되지 않는다.
 */
export type AccessAudience = "local" | "remote";

/**
 * 자격이 여는 권한의 등급. 1회성·머신 바인딩은 *발급*을 통제하고, 등급은 *사고 후 범위*를
 * 통제한다 — 서로 대체할 수 없으므로 둘 다 필요하다. monitoring은 읽기만 한다.
 */
export type AccessClass = "full" | "monitoring";

const SESSION_COOKIE_NAME = "fleet_console_session";
/** 페어링 자격이 담기는 쿠키. 세션과 달리 회수 전까지 살아 남는다. */
const PAIRING_COOKIE_NAME = "fleet_console_pairing";

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
  readonly access: AccessClass;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** 발급 사실만 담은 공개 표현. 토큰은 발급 시점 응답에만 실리고 다시는 나가지 않는다. */
export interface AccessGrantSummary {
  readonly id: string;
  readonly access: AccessClass;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface AccessSession {
  /** 쿠키에 실리는 비밀 값. */
  readonly id: string;
  /** 세션을 가리키는 공개 이름. 쿠키 값과 달리 목록에 실어도 안전하다. */
  readonly handle: string;
  readonly audience: AccessAudience;
  readonly access: AccessClass;
  /**
   * 이 세션을 연 페어링. 세션은 접속이고 페어링은 자격이므로, 페어링을 회수할 때 그것으로
   * 열려 있던 접속까지 함께 끊으려면 둘을 잇는 이름이 필요하다. 루프백 세션에는 없다.
   */
  readonly pairingId: string | null;
  readonly expiresAt: number;
}

export interface AccessSessionSummary {
  readonly handle: string;
  /** 조인할 때 기기가 스스로 밝힌 이름. 목록에서 사람이 자기 기기를 알아보는 유일한 단서다. */
  readonly device: string | null;
  readonly access: AccessClass;
  readonly pairingId: string | null;
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
  /**
   * 세션이 끝났다는 유일한 신호. 회수·대체·언페어링·만료·리스너 종료 — 세션을 지우는 모든 길이
   * 맵을 고친 뒤 이것을 한 번 부른다. 끝나는 길마다 호출자가 채널을 따로 닫게 두면 하나만 빠져도
   * 끝난 세션이 계속 듣고 말한다. 그래서 닫는 책임은 지우는 자리 하나에 둔다.
   *
   * 다른 레지스트리 호출 안에서 불리기도 하므로(prune) 콜백은 재진입을 견뎌야 한다. 콜백이
   * 레지스트리를 다시 부르면, 이미 지운 세션은 다시 나오지 않는다.
   */
  readonly onSessionsEnded?: (ended: readonly EndedSession[]) => void;
  /**
   * 만료 시계. 만료는 정확히 그 시각의 사건이어야 한다 — 다음 sweep까지 기다리면 그 사이 끝난
   * 세션의 채널이 이벤트를 받고 명령을 보낸다. 테스트가 시계를 대신할 수 있도록 주입받는다.
   */
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

/** 끝난 세션 하나. handle은 그 세션으로 열린 채널을 찾는 이름이다. */
export interface EndedSession {
  readonly handle: string;
  readonly pairingId: string | null;
  /** 끊긴 화면에 무엇을 말할지. null이면 조용히 닫는다 — 만료·자기 잔상·리스너 종료. */
  readonly notice: ControlReclaimedReason | null;
}

export interface AccessRegistry {
  readonly grantTtlMs: number;
  issueGrant(audience: AccessAudience, access?: AccessClass): AccessGrant;
  /** 리스너의 audience와 일치하는 grant만 세션으로 교환된다. 교환된 grant는 소멸한다. */
  redeemGrant(token: string | null, audience: AccessAudience, device?: string | null): AccessSession | null;
  /**
   * grant를 소멸시키고 그 사실만 돌려준다. 세션을 열기 전에 페어링을 먼저 만들어야 하는
   * 경로가 쓴다 — 세션이 자기를 연 페어링의 이름을 들고 태어나야, 나중에 그 페어링을
   * 회수할 때 접속까지 함께 끊을 수 있다.
   */
  consumeGrant(token: string | null, audience: AccessAudience): AccessGrant | null;
  /** 자격이 이미 확인된 뒤 접속을 연다. 등급은 부르는 쪽이 정하고 조인이 올릴 수 없다. */
  openSession(audience: AccessAudience, access: AccessClass, device: string | null, pairingId: string | null): AccessSession;
  /**
   * 소모하지 않고 등급만 본다. 조인을 거절해야 하는 경우 자격을 태우기 전에 판정하기 위한 것이다 —
   * redeemGrant는 거절할 때도 토큰을 지우므로, 그 뒤에서 막으면 1회용 링크만 소멸하고 아무도
   * 붙지 못한 채 끝난다. 만료·audience 불일치는 여기서도 null이다.
   */
  peekGrant(token: string, audience: AccessAudience): AccessGrantSummary | null;
  resolveSession(id: string | null, audience: AccessAudience): AccessSession | null;
  listGrants(audience: AccessAudience): readonly AccessGrantSummary[];
  /** 아직 쓰이지 않은 링크를 하나만 무효화한다. */
  revokeGrant(id: string): boolean;
  /** 이 audience의 미사용 링크를 전부 무효화한다. */
  revokeGrants(audience: AccessAudience): void;
  listSessions(audience: AccessAudience): readonly AccessSessionSummary[];
  /**
   * 이 audience에 해당 등급의 세션이 이미 열려 있는지. 제어를 쥔 원격은 한 번에 하나여야 하고,
   * 그 판정을 조인 이전에 내려야 자격이 소모된 뒤 거절하는 일이 없다.
   */
  hasSession(audience: AccessAudience, access: AccessClass): boolean;
  revokeSession(id: string): boolean;
  /** 이미 열린 세션 하나를 끊는다. 회수·대체 사유는 그 페어링의 다음 성공한 join까지 남긴다. */
  revokeSessionByHandle(handle: string, reason?: ControlReclaimedReason | null): boolean;
  /** 한 페어링으로 열린 접속을 전부 끊는다. 페어링 회수가 접속을 남겨 두지 않게 한다. */
  revokeSessionsByPairing(pairingId: string, notice?: ControlReclaimedReason | null): boolean;
  /**
   * 그 handle의 세션이 아직 살아 있는가. 만료를 지금 시각으로 판정하되 유휴 수명을 늘리지 않는다 —
   * 서버가 내려보내는 일(저널·이벤트)은 사람의 활동이 아니다.
   */
  isSessionLive(handle: string): boolean;
  /** 사람의 명령이 그 세션으로 왔다. 살아 있으면 유휴 수명을 밀고 true, 끝났으면 false. */
  touchSession(handle: string): boolean;
  /** 그 페어링의 끝난 사유. 없으면 null. */
  lookupSessionEnd(pairingId: string): ControlReclaimedReason | null;
  /** 그 페어링이 다시 join했거나 언페어링됐을 때 사유를 걷는다. */
  clearSessionEnd(pairingId: string): void;
  /** 원격을 끄면 그 audience의 세션도 함께 죽는다 — 리스너만 닫으면 자격은 살아 남는다. */
  revokeSessions(audience: AccessAudience): void;
  revokeAllSessions(): void;
  prune(): void;
}

interface StoredSession {
  readonly handle: string;
  readonly device: string | null;
  readonly audience: AccessAudience;
  readonly access: AccessClass;
  readonly pairingId: string | null;
  readonly openedAt: number;
  readonly absoluteExpiresAt: number;
  idleExpiresAt: number;
  lastSeenAt: number;
}

const DEFAULT_GRANT_TTL_MS = 15 * 60 * 1000;
/**
 * 세션 수명이 자격 수명을 뜻하던 시절의 12시간은 페어링이 생기면서 의미가 달라졌다. 이제
 * 자격은 페어링이 들고 있고 세션은 "지금 붙어 있는가"만 말하므로, 절대 만료는 오래 뜬
 * 서버가 잊힌 접속을 언젠가 걷어내는 상한일 뿐이다. 실질적인 정리는 유휴 만료가 한다.
 */
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_IDLE_TTL_MS = 60 * 60 * 1000;
/**
 * 만료 시계 한 번의 최대 대기. macOS의 타이머 시계는 시스템이 잠든 동안 흐르지 않으므로, 만료 시각까지
 * 한 번에 기다리면 잠든 시간만큼 늦게 울린다. 대기를 이 상한으로 끊고 울릴 때마다 벽시계(now)로 다시
 * 판정하면, 깨어난 뒤 늦어도 이만큼 안에 만료가 잡힌다. 그 창 동안에는 끝난 세션의 터미널 입력과
 * 요청마다 재검사하지 않는 SSE가 살아 있으므로 짧게 둔다 — 15초마다 도는 prune은 작은 맵 순회라 비용이 없다.
 */
const MAX_EXPIRY_WAIT_MS = 15 * 1000;

export function createAccessRegistry(deps: AccessRegistryDeps = {}): AccessRegistry {
  const grantTtlMs = deps.grantTtlMs ?? DEFAULT_GRANT_TTL_MS;
  const sessionTtlMs = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const sessionIdleTtlMs = deps.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS;
  const now = deps.now ?? Date.now;
  const randomToken = deps.randomToken ?? (() => crypto.randomBytes(32).toString("base64url"));
  const randomHandle = deps.randomHandle ?? (() => crypto.randomBytes(8).toString("hex"));
  const grants = new Map<string, AccessGrant>();
  const sessions = new Map<string, StoredSession>();
  /**
   * 끝난 세션의 사유를 그 페어링에 남기는 메모리 표. 키는 페어링 id다 — 세션 쿠키 값이 아니므로
   * 회수 뒤에도 기기가 들고 있는 페어링 쿠키로 다시 찾을 수 있고, handle·기기 이름은 어디에도
   * 실리지 않는다. 재시작하면 메모리와 함께 사라지고(vanished 재합류), 언페어링·다음 성공한
   * join이 지운다. 상한은 페어링 수(PAIRED_DEVICE_LIMIT)로 자연히 묶인다.
   */
  const sessionEnds = new Map<string, ControlReclaimedReason>();
  const setTimer = deps.setTimer ?? ((callback: () => void, delayMs: number) => {
    const timer = setTimeout(callback, delayMs);
    // 이 시계가 프로세스를 붙잡아 두지 않게 한다.
    timer.unref();
    return timer;
  });
  const clearTimer = deps.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let expiryTimer: unknown = null;
  let expiryAt: number | null = null;

  /**
   * 가장 이른 만료 시각에 시계 하나만 건다. 유휴 연장으로 시각이 뒤로 밀려도 다시 걸지 않는다 —
   * 일찍 깬 시계는 prune이 지울 것이 없음을 보고 다음 시각에 다시 건다. 세션이 없으면 시계도 없다.
   */
  function armExpiry(): void {
    let next: number | null = null;
    for (const stored of sessions.values()) {
      const at = Math.min(stored.idleExpiresAt, stored.absoluteExpiresAt);
      if (next === null || at < next) next = at;
    }
    if (next === expiryAt) return;
    if (expiryTimer !== null) clearTimer(expiryTimer);
    expiryTimer = null;
    expiryAt = next;
    if (next === null) return;
    // 상한까지만 기다린다 — 일찍 깬 시계는 prune이 지울 것이 없음을 보고 다시 건다.
    expiryTimer = setTimer(() => {
      expiryTimer = null;
      expiryAt = null;
      prune();
      armExpiry();
    }, Math.min(Math.max(0, next - now()), MAX_EXPIRY_WAIT_MS));
  }

  /**
   * 세션을 지우는 유일한 자리. 지운 뒤 한 번만 알린다 — 알리는 도중의 재진입이 지울 것을 다시
   * 찾지 못하도록, 맵을 먼저 고치고 나서 부른다.
   */
  function endSessions(matches: (stored: StoredSession) => boolean, notice: (stored: StoredSession) => ControlReclaimedReason | null): EndedSession[] {
    const ended: EndedSession[] = [];
    for (const [id, stored] of sessions) {
      if (!matches(stored)) continue;
      sessions.delete(id);
      ended.push({ handle: stored.handle, pairingId: stored.pairingId, notice: notice(stored) });
    }
    if (ended.length === 0) return ended;
    armExpiry();
    deps.onSessionsEnded?.(ended);
    return ended;
  }

  function issueGrant(audience: AccessAudience, access: AccessClass = "full"): AccessGrant {
    prune();
    const issuedAt = now();
    const grant: AccessGrant = { id: randomHandle(), token: randomToken(), audience, access, issuedAt, expiresAt: issuedAt + grantTtlMs };
    grants.set(grant.token, grant);
    return grant;
  }

  function consumeGrant(token: string | null, audience: AccessAudience): AccessGrant | null {
    prune();
    if (!token) return null;
    const grant = grants.get(token);
    if (!grant) return null;
    grants.delete(token);
    if (grant.expiresAt <= now() || grant.audience !== audience) return null;
    return grant;
  }

  function redeemGrant(token: string | null, audience: AccessAudience, device: string | null = null): AccessSession | null {
    const grant = consumeGrant(token, audience);
    // 세션은 자기를 연 자격의 등급을 물려받는다 — 조인이 등급을 올릴 수 없어야 한다.
    return grant ? openSession(audience, grant.access, device, null) : null;
  }

  function peekGrant(token: string, audience: AccessAudience): AccessGrantSummary | null {
    prune();
    const grant = grants.get(token);
    if (!grant || grant.audience !== audience || grant.expiresAt <= now()) return null;
    return { id: grant.id, access: grant.access, issuedAt: grant.issuedAt, expiresAt: grant.expiresAt };
  }

  function openSession(audience: AccessAudience, access: AccessClass, device: string | null, pairingId: string | null): AccessSession {
    const id = randomToken();
    const handle = randomHandle();
    const current = now();
    const absoluteExpiresAt = current + sessionTtlMs;
    // 새 세션을 연 페어링은 더 이상 "끝난" 상태가 아니다 — 회수·대체된 사유를 이 자리에서 걷는다.
    if (pairingId !== null) clearSessionEnd(pairingId);
    sessions.set(id, { handle, device, audience, access, pairingId, openedAt: current, absoluteExpiresAt, idleExpiresAt: current + sessionIdleTtlMs, lastSeenAt: current });
    armExpiry();
    return { id, handle, audience, access, pairingId, expiresAt: absoluteExpiresAt };
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
    return { id, handle: stored.handle, audience: stored.audience, access: stored.access, pairingId: stored.pairingId, expiresAt: stored.absoluteExpiresAt };
  }

  function listGrants(audience: AccessAudience): readonly AccessGrantSummary[] {
    prune();
    return [...grants.values()]
      .filter((grant) => grant.audience === audience)
      .map((grant) => ({ id: grant.id, access: grant.access, issuedAt: grant.issuedAt, expiresAt: grant.expiresAt }))
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
      .map((stored) => ({ handle: stored.handle, device: stored.device, access: stored.access, pairingId: stored.pairingId, openedAt: stored.openedAt, expiresAt: stored.absoluteExpiresAt, lastSeenAt: stored.lastSeenAt }))
      .sort((left, right) => right.openedAt - left.openedAt);
  }

  function hasSession(audience: AccessAudience, access: AccessClass): boolean {
    prune();
    for (const stored of sessions.values()) {
      if (stored.audience === audience && stored.access === access) return true;
    }
    return false;
  }

  function revokeSessionByHandle(handle: string, reason: ControlReclaimedReason | null = null): boolean {
    for (const stored of sessions.values()) {
      if (stored.handle !== handle) continue;
      // 사유는 알리기 전에 남긴다 — 신호를 받고 닫힌 화면의 재연결 401이 같은 사유를 읽어야 한다.
      if (reason !== null && stored.pairingId !== null) sessionEnds.set(stored.pairingId, reason);
      break;
    }
    return endSessions((stored) => stored.handle === handle, () => reason).length > 0;
  }

  function revokeSession(id: string): boolean {
    const target = sessions.get(id);
    return target !== undefined && endSessions((stored) => stored === target, () => null).length > 0;
  }

  function revokeSessionsByPairing(pairingId: string, notice: ControlReclaimedReason | null = null): boolean {
    return endSessions((stored) => stored.pairingId === pairingId, () => notice).length > 0;
  }

  function revokeSessions(audience: AccessAudience): void {
    endSessions((stored) => stored.audience === audience, () => null);
  }

  function revokeAllSessions(): void {
    endSessions(() => true, () => null);
  }

  function findByHandle(handle: string): StoredSession | null {
    for (const stored of sessions.values()) if (stored.handle === handle) return stored;
    return null;
  }

  function isSessionLive(handle: string): boolean {
    prune();
    return findByHandle(handle) !== null;
  }

  function touchSession(handle: string): boolean {
    prune();
    const stored = findByHandle(handle);
    if (stored === null) return false;
    const current = now();
    stored.idleExpiresAt = Math.min(current + sessionIdleTtlMs, stored.absoluteExpiresAt);
    stored.lastSeenAt = current;
    return true;
  }

  function prune(): void {
    const current = now();
    for (const [token, grant] of grants) {
      if (grant.expiresAt <= current) grants.delete(token);
    }
    // 만료는 조용히 끝난다 — 사유를 남기지 않아야 페어링된 기기가 다음 요청에서 말없이 다시 붙는다.
    endSessions((stored) => stored.absoluteExpiresAt <= current || stored.idleExpiresAt <= current, () => null);
  }

  function lookupSessionEnd(pairingId: string): ControlReclaimedReason | null {
    return sessionEnds.get(pairingId) ?? null;
  }

  function clearSessionEnd(pairingId: string): void {
    sessionEnds.delete(pairingId);
  }

  return { grantTtlMs, issueGrant, redeemGrant, consumeGrant, openSession, peekGrant, resolveSession, listGrants, revokeGrant, revokeGrants, listSessions, hasSession, revokeSession, revokeSessionByHandle, revokeSessionsByPairing, isSessionLive, touchSession, revokeSessions, revokeAllSessions, lookupSessionEnd, clearSessionEnd, prune };
}

/**
 * 리스너마다 신뢰 경계가 다르다. 루프백은 평문 http에 기존 Host/Origin 게이트를 쓰고,
 * 원격은 https에 세션을 요구한다. 두 리스너가 하나의 핸들러를 공유하므로, 요청이 어느
 * 리스너로 들어왔는지는 소켓의 로컬 주소로만 판별할 수 있다.
 */
export interface ListenerIdentity {
  readonly audience: AccessAudience;
  /** Client-facing host used by Host checks, links, cookies, and saved hosts. */
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  readonly secure: boolean;
  /** Socket-local tuple used only to identify which listener accepted a request. */
  readonly bindAddress: string;
  readonly bindPort?: number;
}

/**
 * 스킴의 기본 포트는 권위에 적지 않는다 — 표준 URL 규칙이고, 클라이언트가 그렇게 보낸다.
 * 공표 포트를 443으로 두면 기기는 `Host: host`와 `Origin: https://host`를 보내는데, 여기서
 * `host:443`을 기대하면 정상 접속이 전부 403으로 막힌다. 쿠키 이름이 쓰는 숫자 포트는 그대로다.
 */
export function listenerAuthority(host: string, port: number, secure: boolean): string {
  const formatted = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return port === (secure ? 443 : 80) ? formatted : `${formatted}:${port}`;
}

export function listenerOrigin(host: string, port: number, secure: boolean): string {
  return `${secure ? "https" : "http"}://${listenerAuthority(host, port, secure)}`;
}

export function createLoopbackListenerIdentity(port: number): ListenerIdentity {
  return { audience: "local", host: "127.0.0.1", port, origin: listenerOrigin("127.0.0.1", port, false), secure: false, bindAddress: "127.0.0.1", bindPort: port };
}

/** IPv4-mapped IPv6(`::ffff:127.0.0.1`)와 IPv6 루프백을 같은 주소로 본다. */
function normalizeBindAddress(address: string | undefined): string {
  if (!address) return "";
  const stripped = address.startsWith("::ffff:") ? address.slice(7) : address;
  return stripped === "::1" ? "127.0.0.1" : stripped;
}

export function resolveListenerIdentity(
  listeners: readonly ListenerIdentity[],
  socket: { readonly localAddress?: string | undefined; readonly localPort?: number | undefined },
): ListenerIdentity | null {
  const address = normalizeBindAddress(socket.localAddress);
  return listeners.find((listener) => listener.bindAddress === address && (socket.localPort === undefined || (listener.bindPort ?? listener.port) === socket.localPort)) ?? null;
}

/**
 * 쿠키는 포트로 구분되지 않는다. 같은 기계가 두 콘솔을 서로 다른 포트로 열어 두면 이름이
 * 하나뿐일 때 나중 조인이 앞의 자격을 덮어쓰고, 되돌아가면 401이다 — 저장된 호스트는 자격을
 * 남기지 않으므로 그 콘솔은 새 링크 없이 다시 열 수 없다. 그래서 이름에 포트를 새겨 각
 * 콘솔이 자기 쿠키만 읽고 쓴다.
 */
export function sessionCookieName(port: number): string {
  return `${SESSION_COOKIE_NAME}_${port}`;
}

function pairingCookieName(port: number): string {
  return `${PAIRING_COOKIE_NAME}_${port}`;
}

/**
 * 브라우저가 받아 주는 쿠키 수명에는 상한이 있다(RFC 6265bis는 400일로 자른다). 그래서 이
 * 창을 인증서 수명(825일)에 맞추는 것은 애초에 불가능하고, 늘려 봐야 브라우저가 잘라 낸다.
 *
 * 대신 붙을 때마다 창을 다시 민다. 쓰는 기기에게는 끝이 없고, 이 기간 내내 한 번도 오지 않은
 * 기기만 자격이 삭는다 — 잠든 자격이 영원히 살아 있는 편이 더 나쁘므로 이것은 비용이 아니라
 * 성질이다. 그 경우 서버의 페어링은 남으므로, 목록에서 마지막 접속 시각을 보고 치우면 된다.
 */
const PAIRING_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** 요청 쿠키에서 이름이 정확히 일치하는 값만 읽는다. 다른 쿠키는 무시한다. */
function readCookie(headers: { readonly cookie?: string | string[] }, name: string): string | null {
  const raw = Array.isArray(headers.cookie) ? headers.cookie[0] : headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

export function readSessionCookie(headers: { readonly cookie?: string | string[] }, port: number): string | null {
  return readCookie(headers, sessionCookieName(port));
}

export function readPairingCookie(headers: { readonly cookie?: string | string[] }, port: number): string | null {
  return readCookie(headers, pairingCookieName(port));
}

export function formatSessionCookie(session: Pick<AccessSession, "id">, options: { readonly secure: boolean; readonly port: number }): string {
  return formatCookie(sessionCookieName(options.port), session.id, options.secure);
}

/**
 * 페어링 쿠키만 만료 시각을 갖는다. 세션 쿠키는 브라우저를 닫으면 사라져야 하지만, 페어링은
 * 앱을 껐다 켜도 그 기기가 여전히 이 콘솔의 손님이라는 사실이기 때문이다.
 */
export function formatPairingCookie(secret: string, options: { readonly secure: boolean; readonly port: number; readonly maxAgeSeconds?: number }): string {
  return formatCookie(pairingCookieName(options.port), secret, options.secure, options.maxAgeSeconds ?? PAIRING_COOKIE_MAX_AGE_SECONDS);
}

/** 회수된 페어링의 쿠키를 그 기기에서도 지운다. 남겨 두면 붙지 못할 값을 계속 보낸다. */
export function expirePairingCookie(options: { readonly secure: boolean; readonly port: number }): string {
  return formatCookie(pairingCookieName(options.port), "", options.secure, 0);
}

function formatCookie(name: string, value: string, secure: boolean, maxAgeSeconds?: number): string {
  const attributes = [`${name}=${value}`, "HttpOnly", "SameSite=Strict", "Path=/"];
  if (maxAgeSeconds !== undefined) attributes.push(`Max-Age=${maxAgeSeconds}`);
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}
