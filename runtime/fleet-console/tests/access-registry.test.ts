import { describe, expect, it } from "vitest";

import { createAccessRegistry, formatSessionCookie, readSessionCookie, SESSION_COOKIE_NAME } from "../core/host/auth.js";

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
    expect(readSessionCookie({ cookie: `other=1; ${SESSION_COOKIE_NAME}=abc; trailing=2` })).toBe("abc");
    expect(readSessionCookie({ cookie: "other=1" })).toBeNull();
    expect(readSessionCookie({})).toBeNull();
    expect(readSessionCookie({ cookie: `${SESSION_COOKIE_NAME}=` })).toBeNull();
  });

  it("marks the cookie http-only and same-site, and adds Secure only for a secure listener", () => {
    const session = { id: "abc", audience: "local" as const, expiresAt: 0 };

    expect(formatSessionCookie(session, { secure: false })).toBe(`${SESSION_COOKIE_NAME}=abc; HttpOnly; SameSite=Strict; Path=/`);
    expect(formatSessionCookie(session, { secure: true })).toContain("; Secure");
  });
});
