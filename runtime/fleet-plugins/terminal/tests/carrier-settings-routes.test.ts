import fs from "node:fs";
import type http from "node:http";
import path from "node:path";

import { createCarrierRegistry, initStore, registerDefaultCarriers, resetStoreForTests } from "@dotobokuri/fleet-carriers";
import { afterEach, describe, expect, it } from "vitest";

import { buildCarrierSettingsOptions, buildCarrierSettingsState, registerCarrierSettingsRoutes } from "../server/carrier-settings-routes.js";

afterEach(() => resetStoreForTests());

describe("Terminal Carrier Settings routes", () => {
  it("exposes safe state and provider options from the Terminal-owned route", () => {
    initStore("/tmp/fleet-terminal-carriers-test");
    const registry = createCarrierRegistry();
    registerDefaultCarriers(registry);

    const state = buildCarrierSettingsState(registry);
    const options = buildCarrierSettingsOptions();

    expect(state.carriers.length).toBeGreaterThan(0);
    expect(options.cliTypes.length).toBeGreaterThan(0);
    expect(JSON.stringify({ state, options })).not.toMatch(/token|prompt|persona|cwd|toolAllowlist/i);
  });

  it("registers only the Terminal plugin carrier namespace and retains mutation gates", async () => {
    initStore("/tmp/fleet-terminal-carriers-test");
    const registry = createCarrierRegistry();
    registerDefaultCarriers(registry);
    let registeredPath = "";
    let handler: ((context: { req: http.IncomingMessage; res: http.ServerResponse; pathname: string }) => Promise<boolean>) | undefined;
    const responses: Array<{ status: number; body: unknown }> = [];
    const ctx = {
      pluginId: "terminal",
      registerRouter(path: string, route: typeof handler) { registeredPath = path; handler = route; },
      host: {
        security: { isTerminalAuthorized: () => false },
        http: { readJsonBody: async () => null, writeJson: (_res: http.ServerResponse, status: number, body: unknown) => responses.push({ status, body }) },
      },
    } as never;

    registerCarrierSettingsRoutes(ctx, { registry });
    expect(registeredPath).toBe("/api/v1/plugins/terminal/carriers");
    await handler!({ req: { method: "PATCH", headers: { "content-type": "application/json" } } as never, res: {} as never, pathname: "/api/v1/plugins/terminal/carriers/nimitz" });
    expect(responses).toEqual([{ status: 401, body: { error: "unauthorized" } }]);
  });

  it("does not promote stale carriers.json Kirov or Ohio overrides into registry-driven settings state", () => {
    const storeDir = "/tmp/fleet-terminal-carriers-stale-retired";
    initStore(storeDir);
    const registry = createCarrierRegistry();
    registerDefaultCarriers(registry);
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, "carriers.json"), JSON.stringify({
      _meta: { generation: 3 },
      carriers: {
        kirov: { displayName: "Stale Kirov" },
        ohio: { displayName: "Stale Ohio" },
      },
    }));

    const state = buildCarrierSettingsState(registry);
    const persisted = JSON.parse(fs.readFileSync(path.join(storeDir, "carriers.json"), "utf8")) as {
      carriers?: Record<string, unknown>;
    };
    expect(state.carriers.map((carrier) => carrier.carrierId)).not.toContain("kirov");
    expect(state.carriers.map((carrier) => carrier.carrierId)).not.toContain("ohio");
    expect(state.carriers.map((carrier) => carrier.carrierId)).toEqual([
      "nimitz",
      "genesis",
      "sentinel",
      "vanguard",
    ]);
    expect(persisted.carriers?.kirov).toEqual({ displayName: "Stale Kirov" });
    expect(persisted.carriers?.ohio).toEqual({ displayName: "Stale Ohio" });
  });
});
