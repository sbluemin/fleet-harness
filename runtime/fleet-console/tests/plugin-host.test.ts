import http from "node:http";
import { createMcpHttpTransport } from "../core/host/mcp/http-transport.js";
import fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiCatalogEntry } from "@fleet-console/sdk/plugin";

import { createPluginAdmiralMcpHost } from "../core/host/mcp/plugin-mcp.js";
import { discoverFleetPlugins } from "../core/host/plugin-host/plugin-host.js";
import { createFleetPluginHost } from "../core/host/plugin-host/plugin-host.js";
import { RouteRegistry } from "../core/host/route-registry/registry.js";
import { UpgradeRegistry } from "../core/host/route-registry/registry.js";
import type { FleetPluginHostCapabilities } from "../core/host/plugin-host/plugin-host.js";

const tempDirs: string[] = [];
const noopHostCapabilities: FleetPluginHostCapabilities = {
  admiralMcp: { register: () => () => {}, connect: () => ({
        getEndpoint: async () => ({ servers: [] }), issueSessionToken: () => [],
        releaseSessionToken: () => {}, cleanup: () => {},
      }) },
      consoleUse: { connect: () => { throw new Error("not implemented"); } },
      aiGatewayMcp: { connect: () => { throw new Error("not implemented"); } },
  operations: {
    list: () => [],
    get: () => null,
    create: () => {
      throw new Error("not implemented");
    },
    patch: () => null,
    delete: () => false,
    registerOperationType: () => () => {},
    registerPayloadSanitizer: () => () => {},
    registerLaunchCatalog: () => () => {},
  },
  events: {
    publish: () => {},
    subscribe: () => () => {},
    registerSseChannel: () => () => {},
  },
  server: { origin: () => null },
  paths: {
    fleetDataDir: "/tmp/fleet-console-test",
    pluginDataDir: (pluginId) => `/tmp/fleet-console-test/plugins/${pluginId}`,
    canonicalizeTheaterPath: (cwd) => path.resolve(cwd),
    workspaceHash: (canonicalCwd) => canonicalCwd,
    resolveTheaterPath: () => null,
    ensureWorkspaceDirectory: (cwd: string) => ({ path: `/tmp/ws/${cwd.replace(/\W+/g, "-")}`, id: "ws" }),
    withDirectoryLock: <T,>(_lockDir: string, operation: () => T): T => operation(),
  },
  storage: {
    readJson: async () => null,
    writeJson: async () => {},
  },
  http: {
    writeJson: () => {},
    readJsonBody: async () => null,
    securityHeaders: (extra?: Readonly<Record<string, string>>) => ({ ...(extra ?? {}) }),
  },
  security: {
    validateHost: () => true,
    isTerminalAuthorized: () => true,
    isLockAuthorized: () => true,
    resolveTerminalSocketRole: () => "control" as const,
    isWriteAdmitted: () => true,
    expectedOrigin: () => "http://127.0.0.1:1",
  },
  theaterFlags: { register: () => () => undefined },
  lifecycle: {
    registerCleanup: () => () => {},
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("plugin host", () => {

  it("binds plugin MCP names and isolates sessions through registration and teardown", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-plugin-mcp-"));
    tempDirs.push(dir);
    writePlugin(path.join(dir, "runtime", "fleet-plugins", "demo"), "demo");
    let origin = "";
    const transport = createMcpHttpTransport(() => origin);
    const listener = http.createServer((req, res) => { if (!transport.handle(req, res)) { res.writeHead(404); res.end(); } });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(listener.address() as { port: number }).port}`;
    const mcp = createPluginAdmiralMcpHost(transport.transport);
    const first = mcp.connect();
    const second = mcp.connect();
    const cleanups: Array<() => void | Promise<void>> = [];
    const host = createFleetPluginHost({
      cwd: dir, homeDir: "/missing", routes: new RouteRegistry(), upgrades: new UpgradeRegistry(),
      registerAdmiralMcp: (id, tools) => mcp.register(id, tools),
      host: { ...noopHostCapabilities, lifecycle: { registerCleanup: (cleanup) => { cleanups.push(cleanup); return () => {}; } } },
      importModule: async () => ({ register: (ctx) => {
        ctx.host.admiralMcp.register([{ name: "project", description: "Read session project", inputSchema: { type: "object", properties: {} },
          execute: async (_args, context) => ({ content: [{ type: "text", text: context.cwd }], isError: false }),
        }]);
      } }),
    });
    try {
      await host.boot();
      const endpoint = await first.getEndpoint();
      expect(endpoint.servers.map((server) => server.name)).toEqual(["fleet-demo"]);
      expect(new URL(endpoint.servers[0]!.url).origin).toBe(origin);
      expect((await fetch(endpoint.servers[0]!.url, { method: "POST" })).status).toBe(401);
      expect((await fetch(endpoint.servers[0]!.url, { method: "POST", headers: { Origin: origin, Authorization: "Bearer fake" } })).status).toBe(404);
      const one = first.issueSessionToken({ label: "same", cwd: "/first" })[0]!;
      const two = second.issueSessionToken({ label: "same", cwd: "/second" })[0]!;
      const call = async (token: string) => {
        const response = await fetch(endpoint.servers[0]!.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "project", arguments: {} } }),
        });
        return { status: response.status, body: await response.json() };
      };
      expect((await call(one.token)).body).toMatchObject({ result: { content: [{ text: "/first" }] } });
      expect((await call(two.token)).body).toMatchObject({ result: { content: [{ text: "/second" }] } });
      first.cleanup();
      expect((await call(one.token)).body).toMatchObject({ error: { code: -32602 } });
      expect((await call(two.token)).body).toMatchObject({ result: { content: [{ text: "/second" }] } });
      for (const cleanup of cleanups) await cleanup();
      expect((await second.getEndpoint()).servers).toEqual([]);
    } finally {
      first.cleanup(); second.cleanup(); await host.cleanup(); await mcp.dispose(); await transport.dispose();
      await new Promise<void>((resolve) => { listener.close(() => resolve()); listener.closeAllConnections(); });
    }
  });

  it("rejects manifest entries that escape the plugin root", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-traversal-"));
    tempDirs.push(dir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writePlugin(path.join(dir, "runtime", "fleet-plugins", "demo"), "demo", { routes: "../outside.ts" });

    const plugins = discoverFleetPlugins({ cwd: dir, homeDir: "/missing" });

    expect(plugins).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unsafe relative path"));
  });

  it("quarantines external plugin route failures without stopping built-in route boot", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-quarantine-"));
    tempDirs.push(dir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writePlugin(path.join(dir, "runtime", "fleet-plugins", "terminal"), "terminal");
    writePlugin(path.join(dir, "home", ".fleet", "plugins", "bad"), "bad", { apiVersion: 1 });
    const routes = new RouteRegistry();
    const host = createFleetPluginHost({
      registerAdmiralMcp: () => () => {},
      cwd: dir,
      homeDir: path.join(dir, "home"),
      routes,
      upgrades: new UpgradeRegistry(),
      host: noopHostCapabilities,
      importModule: async (entry) => ({
        register: (ctx) => {
          if (entry.includes(`${path.sep}bad${path.sep}`)) {
            ctx.registerRouter("/terminal", () => true);
            return;
          }
          ctx.registerRouter("ready", () => true);
        },
      }),
    });

    await expect(host.boot()).resolves.toBeUndefined();

    expect(await routes.handle({ req: {} as never, res: {} as never, pathname: "/plugins/terminal/ready" })).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Plugin bad routes skipped: plugin_route_outside_scope"));
  });

  it("hard-skips external plugins with missing or mismatched apiVersion", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-api-gate-"));
    tempDirs.push(dir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writePlugin(path.join(dir, "runtime", "fleet-plugins", "built-in"), "built-in", {}, false);
    writePlugin(path.join(dir, "home", ".fleet", "plugins", "missing"), "missing", {}, false);
    writePlugin(path.join(dir, "home", ".fleet", "plugins", "future"), "future", { apiVersion: 999 }, false);
    writePlugin(path.join(dir, "home", ".fleet", "plugins", "ok"), "ok", { apiVersion: 1 }, false);

    const host = createFleetPluginHost({
      registerAdmiralMcp: () => () => {},
      cwd: dir,
      homeDir: path.join(dir, "home"),
      routes: new RouteRegistry(),
      upgrades: new UpgradeRegistry(),
      host: noopHostCapabilities,
    });

    expect(host.plugins.map((plugin) => plugin.manifest.id)).toEqual(["built-in", "ok"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Plugin missing skipped: unsupported apiVersion"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Plugin future skipped: unsupported apiVersion"));
  });

  it("rejects plugin route attempts outside scope or overlapping prefixes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-scope-"));
    tempDirs.push(dir);
    writePlugin(path.join(dir, "runtime", "fleet-plugins", "demo"), "demo");
    const routes = new RouteRegistry();
    const upgrades = new UpgradeRegistry();

    const hijackHost = createFleetPluginHost({
      registerAdmiralMcp: () => () => {},
      cwd: dir,
      homeDir: "/missing",
      routes,
      upgrades,
      host: noopHostCapabilities,
      importModule: async () => ({
        register: (ctx) => ctx.registerRouter("/terminal", () => true),
      }),
    });

    await expect(hijackHost.boot()).rejects.toThrow("plugin_route_outside_scope");

    const overlapHost = createFleetPluginHost({
      registerAdmiralMcp: () => () => {},
      cwd: dir,
      homeDir: "/missing",
      routes,
      upgrades,
      host: noopHostCapabilities,
      importModule: async () => ({
        register: (ctx) => {
          ctx.registerRouter("api", () => false);
          ctx.registerRouter("api/v2", () => true);
        },
      }),
    });

    await expect(overlapHost.boot()).rejects.toThrow("plugin_route_prefix_conflict");
  });
});

function writePlugin(root: string, id: string, manifest: Record<string, unknown> = {}, writeRoutes = true): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify({ id, routes: "routes.ts", ...manifest }));
  if (writeRoutes) fs.writeFileSync(path.join(root, "routes.ts"), "export function register() {}");
}
