import type http from "node:http";

import { describe, expect, it } from "vitest";

import { DESKTOP_THEME_EVENTS_PATH, DESKTOP_THEME_PATH } from "@fleet-console/desktop-protocol";

import { desktopThemeSnapshot } from "../core/host/desktop-theme.js";
import { createDesktopThemeRouter, DESKTOP_THEME_API_CATALOG } from "../core/host/desktop-theme-routes.js";

describe("desktop theme routes", () => {
  it("declares snapshot and SSE endpoints as exact-origin only", () => {
    expect(DESKTOP_THEME_API_CATALOG.map((entry) => entry.gate)).toEqual(["origin-strict", "origin-strict"]);
  });

  it("serves the Console-owned native overlay snapshot", () => {
    const harness = createHarness("maritime");

    expect(harness.router({ req: request("GET"), res: response(), pathname: DESKTOP_THEME_PATH })).toBe(true);
    expect(harness.writes).toEqual([{ status: 200, body: desktopThemeSnapshot("maritime") }]);
  });

  it("subscribes SSE clients with the current server-confirmed snapshot", () => {
    const harness = createHarness("carbon");
    const res = response();

    expect(harness.router({ req: request("GET"), res, pathname: DESKTOP_THEME_EVENTS_PATH })).toBe(true);
    expect(harness.subscriptions).toEqual([{ res, snapshot: desktopThemeSnapshot("carbon") }]);
  });

  it("keeps the additive endpoints method-scoped and lets other routes fall through", () => {
    const harness = createHarness("instrument");

    expect(harness.router({ req: request("POST"), res: response(), pathname: DESKTOP_THEME_PATH })).toBe(true);
    expect(harness.writes).toEqual([{ status: 405, body: { error: "Method not allowed" } }]);
    expect(harness.router({ req: request("GET"), res: response(), pathname: "/api/v1/desktop/other" })).toBe(false);
  });

  it("rejects a cross-origin subscriber before opening an SSE response", () => {
    const harness = createHarness("instrument", false);

    expect(harness.router({ req: request("GET"), res: response(), pathname: DESKTOP_THEME_EVENTS_PATH })).toBe(true);
    expect(harness.writes).toEqual([{ status: 401, body: { error: "unauthorized" } }]);
    expect(harness.subscriptions).toEqual([]);
  });
});

function createHarness(theme: "instrument" | "maritime" | "carbon", authorized = true) {
  const writes: { status: number; body: unknown }[] = [];
  const subscriptions: { res: http.ServerResponse; snapshot: ReturnType<typeof desktopThemeSnapshot> }[] = [];
  const router = createDesktopThemeRouter({
    getTheme: () => theme,
    isAuthorized: () => authorized,
    writeJson: (_res, status, body) => { writes.push({ status, body }); },
    subscribe: (res, snapshot) => { subscriptions.push({ res, snapshot }); },
  });
  return { router, writes, subscriptions };
}

function request(method: string): http.IncomingMessage {
  return { method } as http.IncomingMessage;
}

function response(): http.ServerResponse {
  return {} as http.ServerResponse;
}
