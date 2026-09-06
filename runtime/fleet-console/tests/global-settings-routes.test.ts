import type http from "node:http";

import { describe, expect, it } from "vitest";

import { createGlobalSettingsRouter } from "../core/host/settings/settings-domain.js";
import type { ConsoleSettingsData, ConsoleGeneralSettings } from "../core/host/settings/settings-domain.js";

const DEFAULT_REMOTE_ACCESS = {
  enabled: false,
  publicEndpointEnabled: false,
  listenAddress: "",
  advertisedHost: "",
  listenPort: { mode: "auto", value: 49_152 },
  advertisedPort: { mode: "auto", value: 49_153 },
  acknowledgment: null,
} as const;

interface WriteJsonCall {
  readonly status: number;
  readonly body: unknown;
}

interface RouterHarnessOptions {
  readonly authorized?: boolean;
  readonly body?: unknown;
  readonly bodyNull?: boolean;
  readonly general?: ConsoleGeneralSettings;
  readonly plugins?: ConsoleSettingsData["plugins"];
  readonly onThemeChanged?: (theme: "instrument" | "maritime" | "carbon" | "whites") => void;
  readonly onRemoteAccessChanged?: (change: { readonly previous: ConsoleGeneralSettings["remoteAccess"] & {}; readonly next: ConsoleGeneralSettings["remoteAccess"] & {} }) => void;
}

describe("global settings routes", () => {

  it("round-trips the disabled Auto remote-access default without exposing bindHost", async () => {
    const remoteAccess = {
      enabled: false,
      publicEndpointEnabled: false,
      listenAddress: "",
      advertisedHost: "",
      listenPort: { mode: "auto", value: 49_152 },
      advertisedPort: { mode: "auto", value: 65_535 },
      acknowledgment: null,
    } as const;
    const harness = createRouterHarness({ authorized: true, body: { remoteAccess }, general: { remoteAccess } });

    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });

    expect(harness.currentGeneral()?.remoteAccess).toEqual(remoteAccess);
    expect(harness.writes[0]?.body).toMatchObject({ state: { remoteAccess } });
    expect(JSON.stringify(harness.writes[0]?.body)).not.toContain("bindHost");
  });

  it("requires the exact publicEndpointEnabled key and enables LAN-only without acknowledgment", async () => {
    const missingKey = { ...DEFAULT_REMOTE_ACCESS } as Record<string, unknown>;
    delete missingKey.publicEndpointEnabled;
    const invalid = createRouterHarness({ authorized: true, body: { remoteAccess: missingKey } });
    await invalid.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(invalid.writes[0]).toEqual({ status: 400, body: { error: "invalid_remote_access" } });

    const lanOnly = { ...DEFAULT_REMOTE_ACCESS, enabled: true, listenAddress: "192.0.2.10", advertisedHost: "", acknowledgment: null };
    const valid = createRouterHarness({ authorized: true, body: { remoteAccess: lanOnly } });
    await valid.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(valid.writes[0]?.status).toBe(200);
    expect(valid.currentGeneral()?.remoteAccess).toEqual(lanOnly);
  });

  it("requires the exact numeric version-1 tuple before enabling remote access", async () => {
    const base = {
      enabled: true,
      publicEndpointEnabled: true,
      listenAddress: "192.0.2.10",
      advertisedHost: "console.example",
      listenPort: { mode: "custom", value: 50_001 },
      advertisedPort: { mode: "auto", value: 50_002 },
    } as const;
    for (const acknowledgment of [null, { version: 1, listenAddress: base.listenAddress, listenPort: 50_003, advertisedHost: base.advertisedHost, advertisedPort: 50_002 }]) {
      const harness = createRouterHarness({ authorized: true, body: { remoteAccess: { ...base, acknowledgment } } });
      await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
      expect(harness.writes[0]).toEqual({ status: 400, body: { error: "invalid_remote_access" } });
    }
    const acknowledgment = { version: 1 as const, listenAddress: base.listenAddress, listenPort: 50_001, advertisedHost: base.advertisedHost, advertisedPort: 50_002 };
    const harness = createRouterHarness({ authorized: true, body: { remoteAccess: { ...base, acknowledgment } } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.currentGeneral()?.remoteAccess).toEqual({ ...base, acknowledgment });
  });

  it("PUT /global-settings rejects unauthorized requests with 401", async () => {
    const harness = createRouterHarness({ authorized: false, body: { theme: "instrument" } });
    await harness.router({ req: jsonReq("PUT"), res: res(), pathname: "/api/v1/settings/global" });
    expect(harness.writes[0]?.status).toBe(401);
    expect(harness.updateCalls).toBe(0);
  });
});

function createRouterHarness(options: RouterHarnessOptions = {}) {
  const writes: WriteJsonCall[] = [];
  let data: ConsoleSettingsData = { version: 1, general: { remoteAccess: DEFAULT_REMOTE_ACCESS, ...options.general }, plugins: options.plugins ?? {} };
  let updateCalls = 0;
  const router = createGlobalSettingsRouter({
    consoleSettingsStore: {
      path: "/fake/settings.json",
      load: () => data,
      save: (next) => { data = next; },
      update: (mutate) => { updateCalls += 1; data = mutate(data) ?? data; return data; },
    },
    isAuthorized: () => options.authorized ?? true,
    onThemeChanged: options.onThemeChanged,
    onRemoteAccessChanged: options.onRemoteAccessChanged,
    readJsonBody: async () => (options.bodyNull ? null : (options.body ?? {})) as never,
    writeJson: (_res, status, body) => { writes.push({ status, body }); },
  });
  return { router, writes, currentData: () => data, currentGeneral: () => data.general, get updateCalls() { return updateCalls; } };
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
