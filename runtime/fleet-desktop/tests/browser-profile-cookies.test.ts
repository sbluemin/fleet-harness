import { describe, expect, it, vi } from "vitest";

import { persistProfileSessionCookies, PROFILE_SESSION_COOKIE_MAX_AGE_SECONDS, sessionCookiePromotion, type ProfileCookieJar, type ProfileCookieRecord } from "../src/browser-profile-cookies.js";

describe("browser profile session cookies", () => {
  it("promotes only the persistent profile's session cookies and does not touch a partition jar or extend cookies that already expire", async () => {
    const now = 1_700_000_000;
    const sessionCookie: ProfileCookieRecord = { name: "fleet_session", value: "session-value", domain: "example.com", hostOnly: true, path: "/app", secure: true, httpOnly: true, session: true, sameSite: "lax" };
    const hostCookie: ProfileCookieRecord = { name: "__Host-token", value: "host-value", domain: "example.com", hostOnly: true, path: "/ignored", secure: true, httpOnly: true, session: true, sameSite: "strict" };
    const persistentCookie: ProfileCookieRecord = { name: "fleet_persist", value: "persist-value", domain: ".example.com", hostOnly: false, path: "/", secure: true, httpOnly: false, session: false, sameSite: "lax" };
    const writes: unknown[] = [];
    const profile: ProfileCookieJar = {
      get: async () => [sessionCookie, hostCookie, persistentCookie],
      set: async (details) => { writes.push(details); },
      flush: async () => undefined,
    };
    const partition: ProfileCookieJar = { get: vi.fn(), set: vi.fn(), flush: vi.fn() };
    expect(await persistProfileSessionCookies([profile], now, PROFILE_SESSION_COOKIE_MAX_AGE_SECONDS)).toBe(0);
    expect(partition.get).not.toHaveBeenCalled();
    expect(partition.set).not.toHaveBeenCalled();
    expect(partition.flush).not.toHaveBeenCalled();
    expect(writes).toEqual([
      sessionCookiePromotion(sessionCookie, now, PROFILE_SESSION_COOKIE_MAX_AGE_SECONDS),
      sessionCookiePromotion(hostCookie, now, PROFILE_SESSION_COOKIE_MAX_AGE_SECONDS),
    ]);
    const host = writes[1] as { domain?: string; path: string; secure: boolean; expirationDate: number };
    expect(host.domain).toBeUndefined();
    expect(host.path).toBe("/");
    expect(host.secure).toBe(true);
    expect(host.expirationDate).toBe(now + PROFILE_SESSION_COOKIE_MAX_AGE_SECONDS);
    expect(sessionCookiePromotion(persistentCookie, now, PROFILE_SESSION_COOKIE_MAX_AGE_SECONDS)).toBeNull();
  });
});
