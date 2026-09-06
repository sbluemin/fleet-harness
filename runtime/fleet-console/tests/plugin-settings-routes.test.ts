import type http from "node:http";

import { describe, expect, it } from "vitest";

import { createPluginSettingsRouter } from "../core/host/settings/settings-domain.js";
import type { ConsoleSettingsData } from "../core/host/settings/settings-domain.js";

interface WriteJsonCall {
  readonly status: number;
  readonly body: unknown;
}

interface RouterHarnessOptions {
  readonly authorized?: boolean;
  readonly body?: unknown;
  readonly bodyNull?: boolean;
  readonly plugins?: Record<string, Record<string, unknown>>;
}

describe("plugin settings routes", () => {

  it("PUT returns 401 for unauthorized requests", async () => {
    const harness = createRouterHarness({ authorized: false, body: { k: 1 } });
    const handled = await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/plugins/terminal" });
    expect(handled).toBe(true);
    expect(harness.writes[0]?.status).toBe(401);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT returns 413 when serialized body exceeds 32KB", async () => {
    const bigValue = { data: "x".repeat(33 * 1024) };
    const harness = createRouterHarness({ authorized: true, body: bigValue });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/plugins/terminal" });
    expect(harness.writes[0]?.status).toBe(413);
    expect(harness.writes[0]?.body).toEqual({ error: "payload_too_large" });
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT replaces entire plugin entry (previous keys are gone)", async () => {
    const harness = createRouterHarness({ authorized: true, plugins: { terminal: { old: "value" } }, body: { newKey: 42 } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/plugins/terminal" });
    expect(harness.writes[0]).toEqual({ status: 200, body: { value: { newKey: 42 } } });
    expect(harness.currentPlugins()?.terminal).toEqual({ newKey: 42 });
    expect(harness.currentPlugins()?.terminal).not.toHaveProperty("old");
  });
});

function createRouterHarness(options: RouterHarnessOptions) {
  const writes: WriteJsonCall[] = [];
  let data: ConsoleSettingsData = { version: 1, general: {}, plugins: options.plugins ?? {} };
  let updateCalls = 0;
  const router = createPluginSettingsRouter({
    consoleSettingsStore: {
      path: "/fake/settings.json",
      load: () => data,
      save: (next) => { data = next; },
      update: (mutate) => { updateCalls += 1; data = mutate(data) ?? data; return data; },
    },
    isAuthorized: () => options.authorized ?? true,
    readJsonBody: async () => (options.bodyNull ? null : (options.body ?? {})) as never,
    writeJson: (_res, status, body) => { writes.push({ status, body }); },
  });
  return {
    router,
    writes,
    currentPlugins: () => data.plugins,
    get updateCalls() { return updateCalls; },
  };
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
