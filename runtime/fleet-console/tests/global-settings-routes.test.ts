import type http from "node:http";

import { describe, expect, it } from "vitest";

import { createGlobalSettingsRouter } from "../core/host/global-settings-routes.js";
import type { ConsoleSettingsData, ConsoleGeneralSettings } from "../core/host/console-settings.js";

interface WriteJsonCall {
  readonly status: number;
  readonly body: unknown;
}

interface RouterHarnessOptions {
  readonly authorized?: boolean;
  readonly body?: unknown;
  readonly bodyNull?: boolean;
  readonly general?: ConsoleGeneralSettings;
}

describe("global settings routes", () => {
  it("GET /global-settings/state returns flat Console settings with defaults", async () => {
    const harness = createRouterHarness({ general: {} });
    const handled = await harness.router({ req: req("GET"), res: res(), pathname: "/api/v1/settings/global" });
    expect(handled).toBe(true);
    expect(harness.writes).toEqual([{ status: 200, body: { consolePortMode: "dynamic", consoleStaticPort: null, theme: "maritime" } }]);
    expect(harness.writes[0]?.body).not.toHaveProperty("version");
    expect(harness.writes[0]?.body).not.toHaveProperty("general");
  });

  it("GET /global-settings/state reflects stored values", async () => {
    const harness = createRouterHarness({ general: { consolePortMode: "static", consoleStaticPort: 9000, theme: "carbon" } });
    await harness.router({ req: req("GET"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]).toEqual({ status: 200, body: { consolePortMode: "static", consoleStaticPort: 9000, theme: "carbon" } });
  });

  it("GET /global-settings/state rejects non-GET methods with 405", async () => {
    const harness = createRouterHarness();
    await harness.router({ req: req("POST"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]?.status).toBe(405);
  });

  it("PUT /global-settings updates and returns the new state", async () => {
    const harness = createRouterHarness({ authorized: true, body: { consolePortMode: "static", consoleStaticPort: 8080, theme: "carbon" } });
    const handled = await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(handled).toBe(true);
    expect(harness.writes[0]).toEqual({ status: 200, body: { state: { consolePortMode: "static", consoleStaticPort: 8080, theme: "carbon" } } });
    expect(harness.currentGeneral()).toMatchObject({ consolePortMode: "static", consoleStaticPort: 8080, theme: "carbon" });
  });

  it("PUT /global-settings stores a theme", async () => {
    const harness = createRouterHarness({ authorized: true, body: { theme: "carbon" } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]).toEqual({ status: 200, body: { state: { consolePortMode: "dynamic", consoleStaticPort: null, theme: "carbon" } } });
    expect(harness.currentGeneral()).toMatchObject({ theme: "carbon" });
  });

  it("PUT /global-settings ignores enableMetaphor body field", async () => {
    const harness = createRouterHarness({
      authorized: true,
      body: { enableMetaphor: true },
      general: { consolePortMode: "static", consoleStaticPort: 8080, theme: "maritime" },
    });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]?.body).toEqual({ state: { consolePortMode: "static", consoleStaticPort: 8080, theme: "maritime" } });
    expect(harness.currentGeneral()).toEqual({ consolePortMode: "static", consoleStaticPort: 8080, theme: "maritime" });
  });

  it("PUT /global-settings rejects unauthorized requests with 401", async () => {
    const harness = createRouterHarness({ authorized: false, body: { theme: "carbon" } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]?.status).toBe(401);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /global-settings rejects non-JSON content types with 415", async () => {
    const harness = createRouterHarness({ authorized: true });
    await harness.router({ req: req("PUT", "text/plain"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]?.status).toBe(415);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /global-settings rejects a missing body with 400", async () => {
    const harness = createRouterHarness({ authorized: true, bodyNull: true });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /global-settings stores a static console port", async () => {
    const harness = createRouterHarness({ authorized: true, body: { consolePortMode: "static", consoleStaticPort: 8080 } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]).toEqual({ status: 200, body: { state: { consolePortMode: "static", consoleStaticPort: 8080, theme: "maritime" } } });
  });

  it("PUT /global-settings rejects an out-of-range static port with 400", async () => {
    const harness = createRouterHarness({ authorized: true, body: { consoleStaticPort: 80 } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /global-settings rejects an invalid console port mode with 400", async () => {
    const harness = createRouterHarness({ authorized: true, body: { consolePortMode: "auto" } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /global-settings rejects an invalid theme with 400", async () => {
    const harness = createRouterHarness({ authorized: true, body: { theme: "neon" } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("/api/v1/settings/global rejects non-GET/PUT methods with 405", async () => {
    const harness = createRouterHarness();
    await harness.router({ req: req("DELETE"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]?.status).toBe(405);
  });

  it("returns false for unknown paths so the host can fall through", async () => {
    const harness = createRouterHarness();
    const handled = await harness.router({ req: req("GET"), res: res(), pathname: "/api/v1/settings/global/unknown" });
    expect(handled).toBe(false);
    expect(harness.writes).toEqual([]);
  });
});

function createRouterHarness(options: RouterHarnessOptions = {}) {
  const writes: WriteJsonCall[] = [];
  let data: ConsoleSettingsData = { version: 1, general: options.general ?? {} };
  let updateCalls = 0;
  const router = createGlobalSettingsRouter({
    consoleSettingsStore: {
      path: "/fake/settings.json",
      load: () => data,
      save: (next) => { data = next; },
      update: (mutate) => { updateCalls += 1; data = mutate(data); return data; },
    },
    isAuthorized: () => options.authorized ?? true,
    readJsonBody: async () => (options.bodyNull ? null : (options.body ?? {})) as never,
    writeJson: (_res, status, body) => { writes.push({ status, body }); },
  });
  return { router, writes, currentGeneral: () => data.general, get updateCalls() { return updateCalls; } };
}

function req(method: string, contentType?: string): http.IncomingMessage {
  return { method, headers: contentType ? { "content-type": contentType } : {} } as unknown as http.IncomingMessage;
}

function jsonReq(method: string): http.IncomingMessage {
  return req(method, "application/json");
}

function res(): http.ServerResponse {
  return {} as unknown as http.ServerResponse;
}
