import type http from "node:http";

import type { GlobalOptionsData } from "@dotobokuri/core-infra";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { describe, expect, it } from "vitest";

import { registerTerminalSettingsRoutes } from "../server/settings-routes.js";

interface WriteJsonCall {
  readonly status: number;
  readonly body: unknown;
}

interface HarnessOptions {
  readonly terminalAuthorized?: boolean;
  readonly body?: unknown;
  readonly bodyNull?: boolean;
  readonly data?: GlobalOptionsData;
}

describe("terminal settings routes", () => {
  it("GET /plugins/terminal/settings returns terminal settings", async () => {
    const harness = createRouteHarness({
      data: { version: 1, enableMetaphor: false },
    });
    await harness.handle({ req: req("GET"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes).toEqual([{ status: 200, body: { enableMetaphor: false, kimiModel: null, agentIdleDormantMinutes: 60 } }]);
    expect(harness.writes[0]?.body).not.toHaveProperty("consolePortMode");
  });

  it("PUT /plugins/terminal/settings updates enableMetaphor in global options", async () => {
    const harness = createRouteHarness({
      body: { enableMetaphor: true },
      data: { version: 1, enableMetaphor: false },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes).toEqual([{ status: 200, body: { enableMetaphor: true, kimiModel: null, agentIdleDormantMinutes: 60 } }]);
    expect(harness.currentData()).toEqual({ version: 1, enableMetaphor: true });
  });

  it("PUT /plugins/terminal/settings rejects non-boolean payloads", async () => {
    const harness = createRouteHarness({ body: { enableMetaphor: "yes" } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings rejects payloads with unknown extra keys", async () => {
    const harness = createRouteHarness({ body: { enableMetaphor: true, consolePortMode: "static" } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings rejects payloads with unknown keys", async () => {
    const harness = createRouteHarness({ body: { terminalRenderer: "webgl" } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings rejects the removed Codex launch mode key", async () => {
    const harness = createRouteHarness({ body: { codexLaunchMode: "app-server" } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings rejects payloads with multiple known keys", async () => {
    const harness = createRouteHarness({
      body: { enableMetaphor: true, kimiModel: { model: "k3" } },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings updates agentIdleDormantMinutes in global options", async () => {
    const harness = createRouteHarness({
      body: { agentIdleDormantMinutes: 120 },
      data: { version: 1 },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes).toEqual([{ status: 200, body: { enableMetaphor: false, kimiModel: null, agentIdleDormantMinutes: 120 } }]);
    expect(harness.currentData()).toEqual({ version: 1, agentIdleDormantMinutes: 120 });
  });

  it("PUT /plugins/terminal/settings accepts null agentIdleDormantMinutes to disable auto-dormant", async () => {
    const harness = createRouteHarness({
      body: { agentIdleDormantMinutes: null },
      data: { version: 1, agentIdleDormantMinutes: 60 },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes).toEqual([{ status: 200, body: { enableMetaphor: false, kimiModel: null, agentIdleDormantMinutes: null } }]);
    expect(harness.currentData()).toEqual({ version: 1, agentIdleDormantMinutes: null });
  });

  it("PUT /plugins/terminal/settings rejects invalid agentIdleDormantMinutes values", async () => {
    for (const body of [
      { agentIdleDormantMinutes: 0 },
      { agentIdleDormantMinutes: -1 },
      { agentIdleDormantMinutes: 1.5 },
      { agentIdleDormantMinutes: "60" },
      { agentIdleDormantMinutes: Number.POSITIVE_INFINITY },
    ]) {
      const harness = createRouteHarness({ body });
      await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
      expect(harness.writes.at(-1)?.status).toBe(400);
      expect(harness.updateCalls).toBe(0);
    }
  });

  it("GET /plugins/terminal/settings returns default agentIdleDormantMinutes when unset", async () => {
    const harness = createRouteHarness({ data: { version: 1 } });
    await harness.handle({ req: req("GET"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes).toEqual([{ status: 200, body: { enableMetaphor: false, kimiModel: null, agentIdleDormantMinutes: 60 } }]);
  });

  it("PUT /plugins/terminal/settings updates the Kimi default model in global options", async () => {
    const harness = createRouteHarness({
      body: { kimiModel: { model: "k3", effort: "max" } },
      data: { version: 1, enableMetaphor: false },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes).toEqual([{ status: 200, body: { enableMetaphor: false, kimiModel: { model: "k3", effort: "max" }, agentIdleDormantMinutes: 60 } }]);
    expect(harness.currentData()).toEqual({ version: 1, enableMetaphor: false, kimiModel: { model: "k3", effort: "max" } });
  });

  it("PUT /plugins/terminal/settings accepts a Kimi default model without effort", async () => {
    const harness = createRouteHarness({
      body: { kimiModel: { model: "kimi-for-coding-highspeed" } },
      data: { version: 1 },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(200);
    expect(harness.currentData()).toEqual({ version: 1, kimiModel: { model: "kimi-for-coding-highspeed" } });
  });

  it("PUT /plugins/terminal/settings rejects unknown Kimi models", async () => {
    const harness = createRouteHarness({ body: { kimiModel: { model: "not-a-real-model" } } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings rejects effort for Kimi models without effort support", async () => {
    const harness = createRouteHarness({ body: { kimiModel: { model: "kimi-for-coding", effort: "high" } } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings rejects effort levels the Kimi model does not support", async () => {
    const harness = createRouteHarness({ body: { kimiModel: { model: "k3", effort: "ultra" } } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("GET /plugins/terminal/settings returns the stored Kimi default model", async () => {
    const harness = createRouteHarness({
      data: { version: 1, kimiModel: { model: "k3[1m]", effort: "high" } },
    });
    await harness.handle({ req: req("GET"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes).toEqual([{ status: 200, body: { enableMetaphor: false, kimiModel: { model: "k3[1m]", effort: "high" }, agentIdleDormantMinutes: 60 } }]);
  });

  it("PUT /plugins/terminal/settings enforces terminal-origin authorization", async () => {
    const harness = createRouteHarness({ terminalAuthorized: false, body: { enableMetaphor: true } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes).toEqual([{ status: 401, body: { error: "unauthorized" } }]);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings rejects non-JSON content types", async () => {
    const harness = createRouteHarness({ body: { enableMetaphor: true } });
    await harness.handle({ req: req("PUT", "text/plain"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(415);
    expect(harness.updateCalls).toBe(0);
  });
});

function createRouteHarness(options: HarnessOptions = {}) {
  const writes: WriteJsonCall[] = [];
  const routers = new Map<string, Parameters<FleetPluginServerContext["registerRouter"]>[1]>();
  let data = options.data ?? { version: 1 };
  let updateCalls = 0;
  const ctx = {
    pluginId: "terminal",
    manifest: { id: "terminal" },
    basePath: "/plugins/terminal",
    wsBasePath: "/plugins/terminal/ws",
    registerRouter: (path: string, handler: Parameters<FleetPluginServerContext["registerRouter"]>[1]) => { routers.set(path, handler); },
    registerWsHandler: () => undefined,
    host: {
      http: {
        readJsonBody: async () => (options.bodyNull ? null : (options.body ?? {})),
        writeJson: (_res: http.ServerResponse, status: number, body: unknown) => { writes.push({ status, body }); },
      },
      security: {
        validateHost: () => true,
        isTerminalAuthorized: () => options.terminalAuthorized ?? true,
        isLockAuthorized: () => true,
      },
    },
  } as unknown as FleetPluginServerContext;
  registerTerminalSettingsRoutes(ctx, {
    globalOptionsService: {
      load: () => data,
      save: (next) => { data = next; return data; },
      update: (mutate) => { updateCalls += 1; data = mutate(data); return data; },
    },
  });
  const handle = routers.get("settings");
  if (!handle) throw new Error("settings router was not registered");
  return { handle, writes, currentData: () => data, get updateCalls() { return updateCalls; } };
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
