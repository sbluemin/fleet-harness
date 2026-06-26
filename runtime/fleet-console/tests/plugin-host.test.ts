import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { discoverFleetPlugins } from "../core/host/plugin-host/discovery.js";
import { createFleetPluginHost } from "../core/host/plugin-host/host.js";
import { RouteRegistry } from "../core/host/route-registry/route-registry.js";
import { UpgradeRegistry } from "../core/host/route-registry/upgrade-registry.js";
import type { FleetPluginHostCapabilities } from "../core/host/plugin-host/types.js";

const tempDirs: string[] = [];
const noopHostCapabilities: FleetPluginHostCapabilities = {
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
  paths: {
    dataDir: "/tmp/fleet-console-test",
    capturesDir: "/tmp/fleet-console-test/captures",
    pluginDataDir: (pluginId) => `/tmp/fleet-console-test/plugins/${pluginId}`,
    canonicalizeTheaterPath: (cwd) => path.resolve(cwd),
    workspaceHash: (canonicalCwd) => canonicalCwd,
    resolveTheaterPath: () => null,
  },
  modelAuth: {
    state: async () => ({ providers: [] }),
  },
  storage: {
    readJson: async () => null,
    writeJson: async () => {},
  },
  http: {
    writeJson: () => {},
    readJsonBody: async () => null,
  },
  security: {
    validateHost: () => true,
    isTerminalAuthorized: () => true,
    isLockAuthorized: () => true,
  },
  lifecycle: {
    registerCleanup: () => () => {},
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("plugin host", () => {
  it("discovers built-in and home plugins while excluding shared", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugins-"));
    tempDirs.push(dir);
    writePlugin(path.join(dir, "runtime", "fleet-plugins", "demo"), "demo");
    fs.mkdirSync(path.join(dir, "runtime", "fleet-plugins", "shared"), { recursive: true });
    writePlugin(path.join(dir, "home", ".fleet", "plugins", "note"), "note");

    const plugins = discoverFleetPlugins({ cwd: dir, homeDir: path.join(dir, "home") });

    expect(plugins.map((plugin) => plugin.manifest.id)).toEqual(["demo", "note"]);
  });

  it("skips malformed plugin manifests without failing discovery", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-malformed-"));
    tempDirs.push(dir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writePlugin(path.join(dir, "runtime", "fleet-plugins", "demo"), "demo");
    const brokenRoot = path.join(dir, "runtime", "fleet-plugins", "broken");
    fs.mkdirSync(brokenRoot, { recursive: true });
    fs.writeFileSync(path.join(brokenRoot, "plugin.json"), "{");

    const plugins = discoverFleetPlugins({ cwd: dir, homeDir: "/missing" });

    expect(plugins.map((plugin) => plugin.manifest.id)).toEqual(["demo"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Plugin manifest skipped"));
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

  it("resolves built-in plugin routes from the package dist root", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-dist-"));
    tempDirs.push(dir);
    writePlugin(path.join(dir, "runtime", "fleet-plugins", "shell"), "shell", { routes: "missing.ts" }, false);
    const distRoute = path.join(dir, "runtime", "fleet-console", "dist", "fleet-plugins", "shell", "routes.mjs");
    fs.mkdirSync(path.dirname(distRoute), { recursive: true });
    fs.writeFileSync(distRoute, "export default { register() {} }");

    const plugins = discoverFleetPlugins({
      builtInSourceRoot: path.join(dir, "runtime", "fleet-plugins"),
      builtInDistRoot: path.join(dir, "runtime", "fleet-console", "dist", "fleet-plugins"),
      homeDir: "/missing",
    });

    expect(plugins[0]?.manifest.id).toBe("shell");
    expect(plugins[0]?.routesEntry).toBe(distRoute);
  });

  it("loads TypeScript route modules through the esbuild dev loader", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-esbuild-"));
    tempDirs.push(dir);
    const pluginRoot = path.join(dir, "runtime", "fleet-plugins", "demo");
    writePlugin(pluginRoot, "demo", {}, false);
    fs.writeFileSync(path.join(pluginRoot, "routes.ts"), [
      "import { definePlugin, registerRouter, registerWsHandler } from \"@fleet-console/sdk/plugin/node\";",
      "interface Marker { readonly value: string }",
      "const marker: Marker = { value: \"plugin-local\" };",
      "export default definePlugin({",
      "  id: \"demo\",",
      "  register(ctx) {",
      "    registerRouter(ctx, \"api\", () => marker.value === \"plugin-local\");",
      "    registerWsHandler(ctx, \"stream\", () => true);",
      "  },",
      "});",
    ].join("\n"));
    const routes = new RouteRegistry();
    const upgrades = new UpgradeRegistry();
    const host = createFleetPluginHost({
      cwd: dir,
      homeDir: "/missing",
      routes,
      upgrades,
      host: noopHostCapabilities,
    });

    await host.boot();

    expect(await routes.handle({ req: {} as never, res: {} as never, pathname: "/plugins/demo/api" })).toBe(true);
    expect(upgrades.handle({ req: {} as never, socket: {} as never, head: Buffer.alloc(0), pathname: "/plugins/demo/ws/stream" })).toBe(true);
  });

  it("loads route modules through scoped plugin facades", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-host-"));
    tempDirs.push(dir);
    writePlugin(path.join(dir, "runtime", "fleet-plugins", "demo"), "demo", { sensitiveFields: ["pluginSecret"] });
    const routes = new RouteRegistry();
    const upgrades = new UpgradeRegistry();
    const host = createFleetPluginHost({
      cwd: dir,
      homeDir: "/missing",
      routes,
      upgrades,
      host: noopHostCapabilities,
      importModule: async () => ({
        register: (ctx) => {
          ctx.registerRouter("api", () => true);
          ctx.registerWsHandler("stream", () => true);
        },
      }),
    });

    await host.boot();

    expect(await routes.handle({ req: {} as never, res: {} as never, pathname: "/plugins/demo/api" })).toBe(true);
    expect(upgrades.handle({ req: {} as never, socket: {} as never, head: Buffer.alloc(0), pathname: "/plugins/demo/ws/stream" })).toBe(true);
    expect(host.sensitiveFieldsByPluginId.get("demo")).toEqual(["pluginSecret"]);
  });

  it("injects generic host capabilities into plugin route modules", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-capabilities-"));
    tempDirs.push(dir);
    writePlugin(path.join(dir, "runtime", "fleet-plugins", "demo"), "demo");
    const routes = new RouteRegistry();
    const upgrades = new UpgradeRegistry();
    const registeredSanitizers: string[][] = [];
    const hostCapabilities: FleetPluginHostCapabilities = {
      ...noopHostCapabilities,
      operations: {
        ...noopHostCapabilities.operations,
        registerPayloadSanitizer: (_pluginId, fields) => {
          registeredSanitizers.push([...fields]);
          return () => {};
        },
      },
    };
    const host = createFleetPluginHost({
      cwd: dir,
      homeDir: "/missing",
      routes,
      upgrades,
      host: hostCapabilities,
      importModule: async () => ({
        register: (ctx) => {
          ctx.host.operations.registerPayloadSanitizer(ctx.pluginId, ["pluginSecret"]);
          ctx.registerRouter("api", () => ctx.host.paths.pluginDataDir(ctx.pluginId).endsWith("/demo"));
        },
      }),
    });

    await host.boot();

    expect(await routes.handle({ req: {} as never, res: {} as never, pathname: "/plugins/demo/api" })).toBe(true);
    expect(registeredSanitizers).toEqual([["pluginSecret"]]);
  });

  it("rejects plugin route attempts outside scope or overlapping prefixes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-scope-"));
    tempDirs.push(dir);
    writePlugin(path.join(dir, "runtime", "fleet-plugins", "demo"), "demo");
    const routes = new RouteRegistry();
    const upgrades = new UpgradeRegistry();

    const hijackHost = createFleetPluginHost({
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
