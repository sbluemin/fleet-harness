import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAiGatewaySettingsStore } from "@dotobokuri/core-ai-gateway";
import type { AuthService } from "@dotobokuri/core-infra";
import { startGatewayHttpServer, type FleetCliGatewayServer } from "../../src/gateway/server.js";

const authService: AuthService = {
  deleteApiKey: async () => false,
  getApiKey: async () => undefined,
  listProviderIds: async () => [],
  setApiKey: async () => {},
};

describe("Fleet CLI gateway HTTP server", () => {
  let server: FleetCliGatewayServer | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it("serves the gateway mount on loopback and rejects paths outside it", async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "fleet-cli-gateway-"));
    server = await startGatewayHttpServer({
      store: createAiGatewaySettingsStore({ dataDir }),
      authService,
    });

    expect(server.origin()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const hello = await fetch(`${server.origin()}${server.routePath}/api/hello`);
    expect(hello.status).toBe(200);
    expect(await hello.json()).toEqual({});

    for (const outsidePath of ["/other", "/ai-gatewayevil"]) {
      const outside = await fetch(`${server.origin()}${outsidePath}`);
      expect(outside.status).toBe(404);
      expect(await outside.json()).toEqual({ error: "not_found" });
    }
  });

  it("closes idempotently", async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "fleet-cli-gateway-"));
    server = await startGatewayHttpServer({
      store: createAiGatewaySettingsStore({ dataDir }),
      authService,
    });

    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
  });
});
