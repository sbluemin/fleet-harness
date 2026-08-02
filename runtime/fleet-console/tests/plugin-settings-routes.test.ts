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
  it("GET returns {value: null} when plugin has no stored settings", async () => {
    const harness = createRouterHarness({});
    const handled = await harness.router({ req: req("GET"), res: res(), pathname: "/api/v1/settings/plugins/terminal" });
    expect(handled).toBe(true);
    expect(harness.writes).toEqual([{ status: 200, body: { value: null } }]);
  });

  it("GET returns stored value for the plugin", async () => {
    const harness = createRouterHarness({ plugins: { terminal: { font: { size: 14 } } } });
    await harness.router({ req: req("GET"), res: res(), pathname: "/api/v1/settings/plugins/terminal" });
    expect(harness.writes[0]).toEqual({ status: 200, body: { value: { font: { size: 14 } } } });
  });

  it("GET returns null for a different plugin not in store", async () => {
    const harness = createRouterHarness({ plugins: { terminal: { x: 1 } } });
    await harness.router({ req: req("GET"), res: res(), pathname: "/api/v1/settings/plugins/notes" });
    expect(harness.writes[0]).toEqual({ status: 200, body: { value: null } });
  });

  it("PUT returns 401 for unauthorized requests", async () => {
    const harness = createRouterHarness({ authorized: false, body: { k: 1 } });
    const handled = await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/plugins/terminal" });
    expect(handled).toBe(true);
    expect(harness.writes[0]?.status).toBe(401);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT returns 415 for non-JSON content type", async () => {
    const harness = createRouterHarness({ authorized: true, body: { k: 1 } });
    await harness.router({ req: req("PUT", "text/plain"), res: res(), pathname: "/api/v1/settings/plugins/terminal" });
    expect(harness.writes[0]?.status).toBe(415);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT returns 400 when body is an array", async () => {
    const harness = createRouterHarness({ authorized: true, body: [1, 2, 3] });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/plugins/terminal" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.writes[0]?.body).toEqual({ error: "invalid_json" });
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT returns 400 when body is null", async () => {
    const harness = createRouterHarness({ authorized: true, bodyNull: true });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/plugins/terminal" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT returns 400 for invalid pluginId (uppercase)", async () => {
    const harness = createRouterHarness({ authorized: true, body: { k: 1 } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/plugins/Terminal" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.writes[0]?.body).toEqual({ error: "invalid_plugin_id" });
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT returns 400 for invalid pluginId (leading dash)", async () => {
    const harness = createRouterHarness({ authorized: true, body: { k: 1 } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/plugins/-bad" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.writes[0]?.body).toEqual({ error: "invalid_plugin_id" });
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

  it("PUT does not affect other plugin entries", async () => {
    const harness = createRouterHarness({ authorized: true, plugins: { notes: { x: 1 } }, body: { font: { size: 16 } } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/plugins/terminal" });
    expect(harness.currentPlugins()?.notes).toEqual({ x: 1 });
    expect(harness.currentPlugins()?.terminal).toEqual({ font: { size: 16 } });
  });

  it("responds 405 for unsupported methods on valid path", async () => {
    const harness = createRouterHarness({});
    await harness.router({ req: req("DELETE"), res: res(), pathname: "/api/v1/settings/plugins/terminal" });
    expect(harness.writes[0]?.status).toBe(405);
    expect(harness.writes[0]?.body).toEqual({ error: "Method not allowed" });
  });

  it("returns false for prefix mismatch so the host can fall through", async () => {
    const harness = createRouterHarness({});
    const handled = await harness.router({ req: req("GET"), res: res(), pathname: "/api/v1/settings/global" });
    expect(handled).toBe(false);
    expect(harness.writes).toEqual([]);
  });

  it("returns false for path with sub-segments (no nested routes)", async () => {
    const harness = createRouterHarness({});
    const handled = await harness.router({ req: req("GET"), res: res(), pathname: "/api/v1/settings/plugins/terminal/extra" });
    expect(handled).toBe(false);
    expect(harness.writes).toEqual([]);
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
      update: (mutate) => { updateCalls += 1; data = mutate(data); return data; },
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
