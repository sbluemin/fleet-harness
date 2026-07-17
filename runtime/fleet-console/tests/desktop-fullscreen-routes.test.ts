import type http from "node:http";

import { describe, expect, it } from "vitest";

import { DESKTOP_FULLSCREEN_PATH } from "../core/host/desktop-fullscreen.js";
import { createDesktopFullscreenRouter, DESKTOP_FULLSCREEN_API_CATALOG } from "../core/host/desktop-fullscreen-routes.js";

describe("desktop fullscreen route", () => {
  it("declares the visual-only PUT endpoint as origin-strict", () => {
    expect(DESKTOP_FULLSCREEN_API_CATALOG).toEqual([expect.objectContaining({ method: "PUT", path: DESKTOP_FULLSCREEN_PATH, gate: "origin-strict" })]);
  });

  it("accepts only an exact boolean snapshot and is idempotent", async () => {
    const harness = createHarness();

    await expect(harness.router({ req: request("PUT", { fullscreen: true }), res: response(), pathname: DESKTOP_FULLSCREEN_PATH })).resolves.toBe(true);
    expect(harness.fullscreen).toBe(true);
    expect(harness.sets).toEqual([true]);
    expect(harness.emptyWrites).toBe(1);

    await harness.router({ req: request("PUT", { fullscreen: true }), res: response(), pathname: DESKTOP_FULLSCREEN_PATH });
    expect(harness.sets).toEqual([true]);
    expect(harness.emptyWrites).toBe(2);
  });

  it.each([
    undefined,
    {},
    { fullscreen: "true" },
    { fullscreen: true, extra: false },
    { fullscreen: false, extra: undefined },
  ])("rejects non-exact JSON snapshots: %j", async (body) => {
    const harness = createHarness();
    await harness.router({ req: request("PUT", body), res: response(), pathname: DESKTOP_FULLSCREEN_PATH });
    expect(harness.writes).toEqual([{ status: 400, body: { error: "invalid_desktop_fullscreen" } }]);
    expect(harness.sets).toEqual([]);
  });

  it("requires exact-origin authorization and rejects every other method", async () => {
    const unauthorized = createHarness(false);
    await unauthorized.router({ req: request("PUT", { fullscreen: true }), res: response(), pathname: DESKTOP_FULLSCREEN_PATH });
    expect(unauthorized.writes).toEqual([{ status: 401, body: { error: "unauthorized" } }]);

    const method = createHarness();
    await method.router({ req: request("GET"), res: response(), pathname: DESKTOP_FULLSCREEN_PATH });
    expect(method.writes).toEqual([{ status: 405, body: { error: "Method not allowed" } }]);
    await expect(method.router({ req: request("PUT", { fullscreen: false }), res: response(), pathname: "/api/v1/desktop/other" })).resolves.toBe(false);
  });
});

function createHarness(authorized = true) {
  let fullscreen = false;
  const sets: boolean[] = [];
  const writes: { status: number; body: unknown }[] = [];
  let emptyWrites = 0;
  const router = createDesktopFullscreenRouter({
    getFullscreen: () => fullscreen,
    isAuthorized: () => authorized,
    readJsonBody: async <T>() => requestBody as T | null,
    setFullscreen: (next) => { fullscreen = next; sets.push(next); },
    writeJson: (_res, status, body) => { writes.push({ status, body }); },
    writeNoContent: () => { emptyWrites += 1; },
  });
  let requestBody: unknown = null;
  return {
    get fullscreen() { return fullscreen; },
    get emptyWrites() { return emptyWrites; },
    router: async (context: { readonly req: http.IncomingMessage; readonly res: http.ServerResponse; readonly pathname: string }) => {
      requestBody = (context.req as http.IncomingMessage & { readonly body?: unknown }).body ?? null;
      return router(context);
    },
    sets,
    writes,
  };
}

function request(method: string, body?: unknown): http.IncomingMessage {
  return { method, body } as http.IncomingMessage & { readonly body?: unknown };
}

function response(): http.ServerResponse {
  return {} as http.ServerResponse;
}
