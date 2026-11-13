import { describe, expect, it } from "vitest";

import { installRequestGuard, setRequestGuardExtra, type GuardedSession, type RequestGuardDetails, type ResponseGuardDetails } from "../src/request-guard.js";
import { webRequestUrlMatches } from "./web-request-match.js";

type RequestListener = (details: RequestGuardDetails, callback: (response: { requestHeaders?: Record<string, string>; cancel?: boolean }) => void) => void;
type ResponseListener = (details: ResponseGuardDetails, callback: (response: { responseHeaders?: Record<string, string | string[]>; cancel?: boolean }) => void) => void;

function guardedSession(): {
  session: GuardedSession;
  request: (details: RequestGuardDetails) => { called: boolean; requestHeaders?: Record<string, string>; cancel?: boolean };
  response: (details: ResponseGuardDetails) => { called: boolean; responseHeaders?: Record<string, string | string[]>; cancel?: boolean };
} {
  let requestFilter: { urls: readonly string[] } | null = null;
  let requestListener: RequestListener | null = null;
  let responseFilter: { urls: readonly string[] } | null = null;
  let responseListener: ResponseListener | null = null;
  const session: GuardedSession = {
    webRequest: {
      onBeforeSendHeaders(filter, listener) { requestFilter = filter; requestListener = listener; },
      onHeadersReceived(filter, listener) { responseFilter = filter; responseListener = listener; },
    },
  };
  const matches = (filter: { urls: readonly string[] } | null, url: string): boolean => filter?.urls.some((pattern) => webRequestUrlMatches(url, pattern)) === true;
  return {
    session,
    request(details) {
      if (!requestListener || !matches(requestFilter, details.url)) return { called: false };
      let response: { requestHeaders?: Record<string, string>; cancel?: boolean } = {};
      requestListener(details, (next) => { response = next; });
      return { called: true, ...response };
    },
    response(details) {
      if (!responseListener || !matches(responseFilter, details.url)) return { called: false };
      let response: { responseHeaders?: Record<string, string | string[]>; cancel?: boolean } = {};
      responseListener(details, (next) => { response = next; });
      return { called: true, ...response };
    },
  };
}

describe("remote request cookie guard", () => {
  it("strips sibling console cookies, keeps stripping after the extra is cleared, and cancels when the extra throws", () => {
    const guard = guardedSession();
    const cookie = [
      "fleet_console_pairing_4311=sibling-pairing",
      "fleet_console_session_4311=sibling-session",
      "fleet_console_pairing_4310=own-pairing",
      "fleet_console_session_4310=own-session",
      "theme=light",
    ].join("; ");
    const request = (url: string): RequestGuardDetails => ({ url, requestHeaders: { Cookie: cookie } });
    const kept = "fleet_console_pairing_4310=own-pairing; fleet_console_session_4310=own-session; theme=light";

    setRequestGuardExtra(guard.session, () => undefined);
    expect(guard.request(request("https://127.0.0.1:4310/api/v1/console-roster")).requestHeaders?.Cookie).toBe(kept);
    expect(guard.request(request("http://127.0.0.1:4310/api/v1/objectives/events")).requestHeaders?.Cookie).toBe(kept);

    setRequestGuardExtra(guard.session, null);
    expect(guard.request(request("https://127.0.0.1:4310/console/")).requestHeaders?.Cookie).toBe(kept);

    setRequestGuardExtra(guard.session, () => { throw new Error("guard extra failed"); });
    expect(guard.request(request("https://127.0.0.1:4310/console/")).cancel).toBe(true);
  });

  it("drops sibling Set-Cookie overwrites and deletions, keeps this port, and cancels when header processing throws", () => {
    const guard = guardedSession();
    installRequestGuard(guard.session);
    const received = guard.response({
      url: "https://127.0.0.1:4310/console/",
      responseHeaders: {
        "Set-Cookie": [
          "fleet_console_pairing_4311=tossed",
          "fleet_console_session_4311=; Max-Age=0",
          "fleet_console_pairing_4310=domain-tossed; Domain=example.com",
          "fleet_console_session_4310=spaced; domain = .example.com",
          "fleet_console_pairing_4310=kept-pairing; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000; Secure",
          "fleet_console_session_4310=kept-session; HttpOnly; SameSite=Strict; Path=/",
          "fleet_console_session_4310=kept-expiry; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
          "theme=light",
        ],
        "SET-COOKIE": "fleet_console_session_9=other-case",
        "Content-Type": ["text/html"],
        "X-Request-Id": "abc",
      },
    });
    expect(received.called).toBe(true);
    expect(received.cancel).toBeUndefined();
    expect(received.responseHeaders).toEqual({
      "Set-Cookie": [
        "fleet_console_pairing_4310=kept-pairing; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000; Secure",
        "fleet_console_session_4310=kept-session; HttpOnly; SameSite=Strict; Path=/",
        "fleet_console_session_4310=kept-expiry; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
        "theme=light",
      ],
      "Content-Type": ["text/html"],
      "X-Request-Id": "abc",
    });
    const untouched = guard.response({
      url: "https://127.0.0.1:4310/console/",
      responseHeaders: {
        "Set-Cookie": ["fleet_console_session_4310=kept-session; HttpOnly; SameSite=Strict; Path=/"],
        "Content-Type": ["text/html"],
      },
    });
    expect(untouched.called).toBe(true);
    expect(untouched.cancel).toBeUndefined();
    expect(untouched.responseHeaders).toBeUndefined();

    const broken: ResponseGuardDetails["responseHeaders"] = {};
    Object.defineProperty(broken, "Set-Cookie", { enumerable: true, get() { throw new Error("header read failed"); } });
    const blocked = guard.response({ url: "https://127.0.0.1:4310/console/", responseHeaders: broken });
    expect(blocked.cancel).toBe(true);
    expect(blocked.responseHeaders).toBeUndefined();

    expect(guard.request({
      url: "https://127.0.0.1:4310/console/",
      requestHeaders: { Cookie: "fleet_console_session_4311=sibling; fleet_console_session_4310=own" },
    }).requestHeaders?.Cookie).toBe("fleet_console_session_4310=own");
  });
});
