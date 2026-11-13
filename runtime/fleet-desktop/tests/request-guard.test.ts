import { describe, expect, it } from "vitest";

import { setRequestGuardExtra, type GuardedSession, type RequestGuardDetails } from "../src/request-guard.js";

describe("remote request cookie guard", () => {
  it("strips sibling console cookies, keeps stripping after the extra is cleared, and cancels when the extra throws", () => {
    let listener: ((details: RequestGuardDetails, callback: (response: { requestHeaders?: Record<string, string>; cancel?: boolean }) => void) => void) | null = null;
    const session: GuardedSession = {
      webRequest: { onBeforeSendHeaders: (_filter, next) => { listener = next; } },
    };
    const cookie = [
      "fleet_console_pairing_4311=sibling-pairing",
      "fleet_console_session_4311=sibling-session",
      "fleet_console_pairing_4310=own-pairing",
      "fleet_console_session_4310=own-session",
      "theme=light",
    ].join("; ");
    const request = (url: string): RequestGuardDetails => ({ url, requestHeaders: { Cookie: cookie } });
    const sent = (details: RequestGuardDetails): { requestHeaders?: Record<string, string>; cancel?: boolean } => {
      let response: { requestHeaders?: Record<string, string>; cancel?: boolean } = {};
      listener?.(details, (next) => { response = next; });
      return response;
    };

    setRequestGuardExtra(session, () => undefined);
    expect(sent(request("https://127.0.0.1:4310/api/v1/console-roster")).requestHeaders?.Cookie).toBe(
      "fleet_console_pairing_4310=own-pairing; fleet_console_session_4310=own-session; theme=light",
    );

    setRequestGuardExtra(session, null);
    expect(sent(request("https://127.0.0.1:4310/console/")).requestHeaders?.Cookie).toBe(
      "fleet_console_pairing_4310=own-pairing; fleet_console_session_4310=own-session; theme=light",
    );

    setRequestGuardExtra(session, () => { throw new Error("guard extra failed"); });
    expect(sent(request("https://127.0.0.1:4310/console/")).cancel).toBe(true);
  });
});
