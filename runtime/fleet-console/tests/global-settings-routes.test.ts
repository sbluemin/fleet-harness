import type http from "node:http";

import { describe, expect, it } from "vitest";

import { createGlobalSettingsRouter } from "../src/global-settings-routes.js";

interface WriteJsonCall {
  readonly status: number;
  readonly body: unknown;
}

interface RouterHarnessOptions {
  readonly authorized?: boolean;
  readonly body?: unknown;
  readonly bodyNull?: boolean;
  readonly data?: { readonly replaceSystemPrompt?: boolean; readonly enableMetaphor?: boolean };
}

describe("global settings routes", () => {
  it("GET /global-settings/state returns the General settings surface without internal keys", async () => {
    const harness = createRouterHarness({ data: { replaceSystemPrompt: true, enableMetaphor: false } });
    const handled = await harness.router({ req: req("GET"), res: res(), pathname: "/global-settings/state" });
    expect(handled).toBe(true);
    expect(harness.writes).toEqual([{ status: 200, body: { replaceSystemPrompt: true, enableMetaphor: false, consolePortMode: "dynamic", consoleStaticPort: null } }]);
    expect(harness.writes[0]?.body).not.toHaveProperty("version");
  });

  it("GET /global-settings/state rejects non-GET methods with 405", async () => {
    const harness = createRouterHarness();
    await harness.router({ req: req("POST"), res: res(), pathname: "/global-settings/state" });
    expect(harness.writes[0]?.status).toBe(405);
  });

  it("PUT /global-settings updates and returns the new state", async () => {
    const harness = createRouterHarness({ authorized: true, body: { replaceSystemPrompt: true, enableMetaphor: true } });
    const handled = await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/global-settings" });
    expect(handled).toBe(true);
    expect(harness.writes[0]).toEqual({ status: 200, body: { state: { replaceSystemPrompt: true, enableMetaphor: true, consolePortMode: "dynamic", consoleStaticPort: null } } });
    expect(harness.currentData()).toMatchObject({ version: 1, replaceSystemPrompt: true, enableMetaphor: true });
  });

  it("PUT /global-settings applies only the provided field", async () => {
    const harness = createRouterHarness({ authorized: true, body: { enableMetaphor: true }, data: { replaceSystemPrompt: true } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/global-settings" });
    expect(harness.writes[0]?.body).toEqual({ state: { replaceSystemPrompt: true, enableMetaphor: true, consolePortMode: "dynamic", consoleStaticPort: null } });
  });

  it("PUT /global-settings rejects unauthorized requests with 401", async () => {
    const harness = createRouterHarness({ authorized: false, body: { enableMetaphor: true } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/global-settings" });
    expect(harness.writes[0]?.status).toBe(401);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /global-settings rejects non-JSON content types with 415", async () => {
    const harness = createRouterHarness({ authorized: true });
    await harness.router({ req: req("PUT", "text/plain"), res: res(), pathname: "/global-settings" });
    expect(harness.writes[0]?.status).toBe(415);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /global-settings rejects non-boolean fields with 400", async () => {
    const harness = createRouterHarness({ authorized: true, body: { enableMetaphor: "yes" } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/global-settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /global-settings rejects a missing body with 400", async () => {
    const harness = createRouterHarness({ authorized: true, bodyNull: true });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/global-settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /global-settings stores a static console port", async () => {
    const harness = createRouterHarness({ authorized: true, body: { consolePortMode: "static", consoleStaticPort: 8080 } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/global-settings" });
    expect(harness.writes[0]).toEqual({ status: 200, body: { state: { replaceSystemPrompt: false, enableMetaphor: false, consolePortMode: "static", consoleStaticPort: 8080 } } });
  });

  it("PUT /global-settings rejects an out-of-range static port with 400", async () => {
    const harness = createRouterHarness({ authorized: true, body: { consoleStaticPort: 80 } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/global-settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /global-settings rejects an invalid console port mode with 400", async () => {
    const harness = createRouterHarness({ authorized: true, body: { consolePortMode: "auto" } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/global-settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("/global-settings rejects non-PUT methods with 405", async () => {
    const harness = createRouterHarness();
    await harness.router({ req: req("GET"), res: res(), pathname: "/global-settings" });
    expect(harness.writes[0]?.status).toBe(405);
  });

  it("returns false for unknown paths so the host can fall through", async () => {
    const harness = createRouterHarness();
    const handled = await harness.router({ req: req("GET"), res: res(), pathname: "/global-settings/unknown" });
    expect(handled).toBe(false);
    expect(harness.writes).toEqual([]);
  });
});

function createRouterHarness(options: RouterHarnessOptions = {}) {
  const writes: WriteJsonCall[] = [];
  let data: { version: 1; replaceSystemPrompt?: boolean; enableMetaphor?: boolean } = { version: 1, ...options.data };
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
