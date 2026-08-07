import { describe, expect, it } from "vitest";

import { createAccessRegistry, createLoopbackListenerIdentity, formatSessionCookie, readSessionCookie, resolveListenerIdentity, sessionCookieName } from "../core/host/auth.js";

function createClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

function createTokens(): () => string {
  let counter = 0;
  return () => `token-${++counter}`;
}

describe("access registry", () => {
  it("redeems a grant exactly once", () => {
    const registry = createAccessRegistry({ randomToken: createTokens() });
    const grant = registry.issueGrant("local");

    expect(registry.redeemGrant(grant.token, "local")).not.toBeNull();
    expect(registry.redeemGrant(grant.token, "local")).toBeNull();
  });

  it("refuses a grant whose audience does not match the listener", () => {
    const registry = createAccessRegistry({ randomToken: createTokens() });
    const grant = registry.issueGrant("local");

    expect(registry.redeemGrant(grant.token, "remote")).toBeNull();
    // 잘못된 audience로 제시된 순간 grant는 소멸한다 — 재시도로 되살릴 수 없다.
    expect(registry.redeemGrant(grant.token, "local")).toBeNull();
  });

  it("expires an unused grant so a leaked link stops working", () => {
    const clock = createClock();
    const registry = createAccessRegistry({ grantTtlMs: 1_000, now: clock.now, randomToken: createTokens() });
    const grant = registry.issueGrant("local");

    clock.advance(1_001);

    expect(registry.redeemGrant(grant.token, "local")).toBeNull();
  });

  it("resolves a session only for its own audience", () => {
    const registry = createAccessRegistry({ randomToken: createTokens() });
    const session = registry.redeemGrant(registry.issueGrant("local").token, "local")!;

    expect(registry.resolveSession(session.id, "local")).not.toBeNull();
    expect(registry.resolveSession(session.id, "remote")).toBeNull();
  });

  it("slides the idle window without outliving the absolute expiry", () => {
    const clock = createClock();
    const registry = createAccessRegistry({ sessionTtlMs: 5_000, sessionIdleTtlMs: 1_000, now: clock.now, randomToken: createTokens() });
    const session = registry.redeemGrant(registry.issueGrant("local").token, "local")!;

    for (let step = 0; step < 4; step += 1) {
      clock.advance(900);
      expect(registry.resolveSession(session.id, "local")).not.toBeNull();
    }
    clock.advance(1_500);

    expect(registry.resolveSession(session.id, "local")).toBeNull();
  });

  it("drops an idle session once the idle window lapses", () => {
    const clock = createClock();
    const registry = createAccessRegistry({ sessionIdleTtlMs: 1_000, now: clock.now, randomToken: createTokens() });
    const session = registry.redeemGrant(registry.issueGrant("local").token, "local")!;

    clock.advance(1_001);

    expect(registry.resolveSession(session.id, "local")).toBeNull();
  });

  it("revokes a single session and every session", () => {
    const registry = createAccessRegistry({ randomToken: createTokens() });
    const first = registry.redeemGrant(registry.issueGrant("local").token, "local")!;
    const second = registry.redeemGrant(registry.issueGrant("local").token, "local")!;

    expect(registry.revokeSession(first.id)).toBe(true);
    expect(registry.resolveSession(first.id, "local")).toBeNull();
    expect(registry.resolveSession(second.id, "local")).not.toBeNull();

    registry.revokeAllSessions();

    expect(registry.resolveSession(second.id, "local")).toBeNull();
  });

  it("rejects an unknown or absent session identifier", () => {
    const registry = createAccessRegistry({ randomToken: createTokens() });

    expect(registry.resolveSession(null, "local")).toBeNull();
    expect(registry.resolveSession("never-issued", "local")).toBeNull();
  });
});

describe("session cookie", () => {
  it("reads only the console session cookie out of a shared header", () => {
    expect(readSessionCookie({ cookie: `other=1; ${sessionCookieName(4310)}=abc; trailing=2` }, 4310)).toBe("abc");
    expect(readSessionCookie({ cookie: "other=1" }, 4310)).toBeNull();
    expect(readSessionCookie({}, 4310)).toBeNull();
    expect(readSessionCookie({ cookie: `${sessionCookieName(4310)}=` }, 4310)).toBeNull();
  });

  /**
   * 쿠키는 포트로 구분되지 않는다. 이름이 하나뿐이면 같은 기계의 두 콘솔 중 나중에 조인한
   * 쪽이 앞의 세션을 덮어쓰고, 되돌아간 콘솔은 새 링크 없이 다시 열 수 없다.
   */
  it("keeps two consoles on the same host apart by writing the port into the name", () => {
    const session = { id: "abc", handle: "h1", audience: "remote" as const, access: "full" as const, expiresAt: 0 };
    const header = `${sessionCookieName(5000)}=first; ${sessionCookieName(6000)}=second`;

    expect(sessionCookieName(5000)).not.toBe(sessionCookieName(6000));
    expect(formatSessionCookie(session, { secure: true, port: 5000 })).toContain(`${sessionCookieName(5000)}=abc`);
    expect(readSessionCookie({ cookie: header }, 5000)).toBe("first");
    expect(readSessionCookie({ cookie: header }, 6000)).toBe("second");
  });

  it("marks the cookie http-only and same-site, and adds Secure only for a secure listener", () => {
    const session = { id: "abc", handle: "h1", audience: "local" as const, access: "full" as const, expiresAt: 0 };

    expect(formatSessionCookie(session, { secure: false, port: 4310 })).toBe(`${sessionCookieName(4310)}=abc; HttpOnly; SameSite=Strict; Path=/`);
    expect(formatSessionCookie(session, { secure: true, port: 4310 })).toContain("; Secure");
  });
});

describe("listener identity", () => {
  const loopback = createLoopbackListenerIdentity(4310);
  const remote = { audience: "remote" as const, host: "100.84.12.7", port: 6768, origin: "https://100.84.12.7:6768", secure: true, bindAddress: "100.84.12.7" };

  it("describes the loopback listener as plain http with a local audience", () => {
    expect(loopback).toMatchObject({ audience: "local", host: "127.0.0.1", origin: "http://127.0.0.1:4310", secure: false });
  });

  it("matches a request to the listener that accepted its socket", () => {
    expect(resolveListenerIdentity([loopback, remote], { localAddress: "127.0.0.1", localPort: 4310 })).toBe(loopback);
    expect(resolveListenerIdentity([loopback, remote], { localAddress: "100.84.12.7", localPort: 6768 })).toBe(remote);
  });

  it("treats ipv4-mapped and ipv6 loopback as the loopback listener", () => {
    expect(resolveListenerIdentity([loopback], { localAddress: "::ffff:127.0.0.1", localPort: 4310 })).toBe(loopback);
    expect(resolveListenerIdentity([loopback], { localAddress: "::1", localPort: 4310 })).toBe(loopback);
  });

  it("refuses a socket that belongs to no registered listener", () => {
    // 등록되지 않은 리스너에서 온 요청은 어떤 게이트도 통과시키지 않는다.
    expect(resolveListenerIdentity([loopback], { localAddress: "192.168.1.9", localPort: 4310 })).toBeNull();
    expect(resolveListenerIdentity([loopback], { localAddress: "127.0.0.1", localPort: 9999 })).toBeNull();
    expect(resolveListenerIdentity([], { localAddress: "127.0.0.1", localPort: 4310 })).toBeNull();
  });
});
