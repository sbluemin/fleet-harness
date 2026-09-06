import { describe, expect, it } from "vitest";

import { createAccessRegistry, createLoopbackListenerIdentity, formatSessionCookie, readSessionCookie, resolveListenerIdentity, sessionCookieName } from "../core/host/auth.js";
import { isValidRemoteBindHost } from "../core/host/settings/settings-domain.js";

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
});

describe("session cookie", () => {

  it("marks the cookie http-only and same-site, and adds Secure only for a secure listener", () => {
    const session = { id: "abc", handle: "h1", audience: "local" as const, access: "full" as const, expiresAt: 0 };

    expect(formatSessionCookie(session, { secure: false, port: 4310 })).toBe(`${sessionCookieName(4310)}=abc; HttpOnly; SameSite=Strict; Path=/`);
    expect(formatSessionCookie(session, { secure: true, port: 4310 })).toContain("; Secure");
  });
});
