import type http from "node:http";

import type { GlobalOptionsData } from "@dotobokuri/fleet-infra";
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
  it("GET /plugins/terminal/settings returns only prompt booleans", async () => {
    const harness = createRouteHarness({
      data: { version: 1, replaceSystemPrompt: true, enableMetaphor: false, consolePortMode: "static", consoleStaticPort: 8080 },
    });
    await harness.handle({ req: req("GET"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes).toEqual([{ status: 200, body: { replaceSystemPrompt: true, enableMetaphor: false } }]);
    expect(harness.writes[0]?.body).not.toHaveProperty("consolePortMode");
  });

  it("PUT /plugins/terminal/settings updates both booleans and preserves unrelated global options", async () => {
    const harness = createRouteHarness({
      body: { replaceSystemPrompt: false, enableMetaphor: true },
      data: { version: 1, replaceSystemPrompt: true, enableMetaphor: false, consolePortMode: "static", consoleStaticPort: 8080 },
    });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes).toEqual([{ status: 200, body: { replaceSystemPrompt: false, enableMetaphor: true } }]);
    expect(harness.currentData()).toEqual({ version: 1, replaceSystemPrompt: false, enableMetaphor: true, consolePortMode: "static", consoleStaticPort: 8080 });
  });

  it("PUT /plugins/terminal/settings rejects non-boolean payloads", async () => {
    const harness = createRouteHarness({ body: { replaceSystemPrompt: true, enableMetaphor: "yes" } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings rejects payloads with unknown extra keys", async () => {
    const harness = createRouteHarness({ body: { replaceSystemPrompt: true, enableMetaphor: true, consolePortMode: "static" } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes[0]?.status).toBe(400);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings enforces terminal-origin authorization", async () => {
    const harness = createRouteHarness({ terminalAuthorized: false, body: { replaceSystemPrompt: true, enableMetaphor: true } });
    await harness.handle({ req: jsonReq("PUT"), res: res(), pathname: "/plugins/terminal/settings" });
    expect(harness.writes).toEqual([{ status: 401, body: { error: "unauthorized" } }]);
    expect(harness.updateCalls).toBe(0);
  });

  it("PUT /plugins/terminal/settings rejects non-JSON content types", async () => {
    const harness = createRouteHarness({ body: { replaceSystemPrompt: true, enableMetaphor: true } });
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
