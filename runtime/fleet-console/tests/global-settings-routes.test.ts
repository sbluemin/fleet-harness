import type http from "node:http";

import { describe, expect, it } from "vitest";

import { createGlobalSettingsRouter } from "../core/host/global-settings-routes.js";

interface WriteJsonCall {
  readonly status: number;
  readonly body: unknown;
}

interface RouterHarnessOptions {
  readonly authorized?: boolean;
  readonly body?: unknown;
  readonly bodyNull?: boolean;
  readonly data?: {
    readonly replaceSystemPrompt?: boolean;
    readonly enableMetaphor?: boolean;
    readonly consolePortMode?: "dynamic" | "static";
    readonly consoleStaticPort?: number;
  };
}

describe("global settings routes", () => {
  it("GET /global-settings/state returns the Console settings surface without internal keys", async () => {
    const harness = createRouterHarness({ data: { replaceSystemPrompt: true, enableMetaphor: false } });
    const handled = await harness.router({ req: req("GET"), res: res(), pathname: "/api/v1/global-settings/state" });
    expect(handled).toBe(true);
    expect(harness.writes).toEqual([{ status: 200, body: { consolePortMode: "dynamic", consoleStaticPort: null } }]);
    expect(harness.writes[0]?.body).not.toHaveProperty("version");
    expect(harness.writes[0]?.body).not.toHaveProperty("replaceSystemPrompt");
    expect(harness.writes[0]?.body).not.toHaveProperty("enableMetaphor");
  });

  it("GET /global-settings/state rejects non-GET methods with 405", async () => {
    const harness = createRouterHarness();
    await harness.router({ req: req("POST"), res: res(), pathname: "/api/v1/global-settings/state" });
    expect(harness.writes[0]?.status).toBe(405);
  });

  it("PUT /global-settings updates and returns the new port-only state", async () => {
    const harness = createRouterHarness({ authorized: true, body: { consolePortMode: "static", consoleStaticPort: 8080 } });
    const handled = await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/global-settings" });
    expect(handled).toBe(true);
    expect(harness.writes[0]).toEqual({ status: 200, body: { state: { consolePortMode: "static", consoleStaticPort: 8080 } } });
    expect(harness.currentData()).toMatchObject({ version: 1, consolePortMode: "static", consoleStaticPort: 8080 });
  });

  it("PUT /global-settings ignores removed prompt fields without mutating stored prompt settings", async () => {
    const harness = createRouterHarness({
      authorized: true,
      body: { replaceSystemPrompt: false, enableMetaphor: true },
      data: { replaceSystemPrompt: true, enableMetaphor: false, consolePortMode: "static", consoleStaticPort: 8080 },
    });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/global-settings" });
    expect(harness.writes[0]?.body).toEqual({ state: { consolePortMode: "static", consoleStaticPort: 8080 } });
    expect(harness.currentData()).toEqual({ version: 1, replaceSystemPrompt: true, enableMetaphor: false, consolePortMode: "static", consoleStaticPort: 8080 });
  });

  it("PUT /global-settings rejects unauthorized requests with 401", async () => {
    const harness = createRouterHarness({ authorized: false, body: { enableMetaphor: true } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/global-settings" });
    expect(harness.writes[0]?.status).toBe(401);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /global-settings rejects non-JSON content types with 415", async () => {
    const harness = createRouterHarness({ authorized: true });
    await harness.router({ req: req("PUT", "text/plain"), res: res(), pathname: "/api/v1/global-settings" });
    expect(harness.writes[0]?.status).toBe(415);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /global-settings rejects a missing body with 400", async () => {
    const harness = createRouterHarness({ authorized: true, bodyNull: true });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/global-settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /global-settings stores a static console port", async () => {
    const harness = createRouterHarness({ authorized: true, body: { consolePortMode: "static", consoleStaticPort: 8080 } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/global-settings" });
    expect(harness.writes[0]).toEqual({ status: 200, body: { state: { consolePortMode: "static", consoleStaticPort: 8080 } } });
  });

  it("PUT /global-settings rejects an out-of-range static port with 400", async () => {
    const harness = createRouterHarness({ authorized: true, body: { consoleStaticPort: 80 } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/global-settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /global-settings rejects an invalid console port mode with 400", async () => {
    const harness = createRouterHarness({ authorized: true, body: { consolePortMode: "auto" } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/global-settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("/api/v1/global-settings rejects non-PUT methods with 405", async () => {
    const harness = createRouterHarness();
    await harness.router({ req: req("GET"), res: res(), pathname: "/api/v1/global-settings" });
    expect(harness.writes[0]?.status).toBe(405);
  });

  it("returns false for unknown paths so the host can fall through", async () => {
    const harness = createRouterHarness();
    const handled = await harness.router({ req: req("GET"), res: res(), pathname: "/api/v1/global-settings/unknown" });
    expect(handled).toBe(false);
    expect(harness.writes).toEqual([]);
  });
});

function createRouterHarness(options: RouterHarnessOptions = {}) {
  const writes: WriteJsonCall[] = [];
  let data: {
    version: 1;
    replaceSystemPrompt?: boolean;
    enableMetaphor?: boolean;
    consolePortMode?: "dynamic" | "static";
    consoleStaticPort?: number;
  } = { version: 1, ...options.data };
  let updateCalls = 0;
  const router = createGlobalSettingsRouter({
    globalOptionsService: {
      load: () => data,
      save: (next) => { data = next; return data; },
      update: (mutate) => { updateCalls += 1; data = mutate(data); return data; },
    },
    isAuthorized: () => options.authorized ?? true,
    readJsonBody: async () => (options.bodyNull ? null : (options.body ?? {})) as never,
    writeJson: (_res, status, body) => { writes.push({ status, body }); },
  });
  return { router, writes, currentData: () => data, get updateCalls() { return updateCalls; } };
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
