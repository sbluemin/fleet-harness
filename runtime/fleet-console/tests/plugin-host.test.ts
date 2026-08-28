import fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiCatalogEntry } from "@fleet-console/sdk/plugin";

import { discoverFleetPlugins } from "../core/host/plugin-host/plugin-host.js";
import { createFleetPluginHost } from "../core/host/plugin-host/plugin-host.js";
import { RouteRegistry } from "../core/host/route-registry/registry.js";
import { UpgradeRegistry } from "../core/host/route-registry/registry.js";
import type { FleetPluginHostCapabilities } from "../core/host/plugin-host/plugin-host.js";

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
  it("writes external TypeScript bundles only to the supplied writable cache", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-cache-"));
    tempDirs.push(dir);
    const pluginRoot = path.join(dir, "home", ".fleet", "plugins", "note");
    const cacheDir = path.join(dir, "console-data", "plugin-cache");
    writePlugin(pluginRoot, "note", { apiVersion: 1 });
    fs.writeFileSync(path.join(pluginRoot, "routes.ts"), "export function register() {}\n");

    const host = createFleetPluginHost({
      cwd: dir,
      homeDir: path.join(dir, "home"),
      bundleCacheDir: cacheDir,
      routes: new RouteRegistry(),
      upgrades: new UpgradeRegistry(),
      host: noopHostCapabilities,
    });
    await host.boot();

    expect(fs.readdirSync(cacheDir).some((entry) => entry.startsWith("fleet-console-plugin-"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "home", ".fleet", "plugins", "node_modules", ".cache"))).toBe(false);
  });

  it("clears stale supplied cache contents at boot and removes this run's bundles during cleanup", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-cache-lifecycle-"));
    tempDirs.push(dir);
    const pluginRoot = path.join(dir, "home", ".fleet", "plugins", "note");
    const cacheDir = path.join(dir, "console-data", "plugin-cache");
    const durablePluginData = path.join(dir, "console-data", "plugins", "note", "state.json");
    writePlugin(pluginRoot, "note", { apiVersion: 1 });
    fs.writeFileSync(path.join(pluginRoot, "routes.ts"), "export function register() {}\n");
    fs.mkdirSync(path.join(cacheDir, "fleet-console-plugin-crashed"), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "fleet-console-plugin-crashed", "routes.mjs"), "stale");
    fs.mkdirSync(path.dirname(durablePluginData), { recursive: true });
    fs.writeFileSync(durablePluginData, "durable");

    const host = createFleetPluginHost({
      cwd: dir,
      homeDir: path.join(dir, "home"),
      bundleCacheDir: cacheDir,
      routes: new RouteRegistry(),
      upgrades: new UpgradeRegistry(),
      host: noopHostCapabilities,
    });
    await host.boot();

    const generatedDirs = fs.readdirSync(cacheDir).filter((entry) => entry.startsWith("fleet-console-plugin-"));
    expect(fs.existsSync(path.join(cacheDir, "fleet-console-plugin-crashed"))).toBe(false);
    expect(generatedDirs).toHaveLength(1);
    expect(fs.readFileSync(durablePluginData, "utf8")).toBe("durable");

    await host.cleanup();

    expect(fs.readdirSync(cacheDir)).toEqual([]);
  });

  it("removes stale bundle owners while preserving an active concurrent owner", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-cache-owners-"));
    tempDirs.push(dir);
    const pluginRoot = path.join(dir, "runtime", "fleet-plugins", "demo");
    const cacheDir = path.join(dir, "console-data", "plugin-cache");
    const activeDir = path.join(cacheDir, "fleet-console-plugin-4242-active");
    const staleDir = path.join(cacheDir, "fleet-console-plugin-9999-crashed");
    const invalidOwnerDir = path.join(cacheDir, "fleet-console-plugin-2147483648-corrupted");
    writePlugin(pluginRoot, "demo", { routes: "routes.mjs" }, false);
    fs.mkdirSync(activeDir, { recursive: true });
    fs.mkdirSync(staleDir, { recursive: true });
    fs.mkdirSync(invalidOwnerDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, ".fleet-console-plugin-owner.json"), JSON.stringify({ pid: 9999 }));
    fs.writeFileSync(path.join(invalidOwnerDir, ".fleet-console-plugin-owner.json"), JSON.stringify({ pid: 2_147_483_648 }));

    const host = createFleetPluginHost({
      cwd: dir,
      homeDir: "/missing",
      bundleCacheDir: cacheDir,
      isProcessAlive: (pid) => pid === 4242,
      routes: new RouteRegistry(),
      upgrades: new UpgradeRegistry(),
      host: noopHostCapabilities,
    });
    await host.boot();

    expect(fs.existsSync(activeDir)).toBe(true);
    expect(fs.existsSync(staleDir)).toBe(false);
    expect(fs.existsSync(invalidOwnerDir)).toBe(false);
  });

  it("retains failed bundle removals for a later cleanup retry", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-cache-retry-"));
    tempDirs.push(dir);
    const pluginRoot = path.join(dir, "home", ".fleet", "plugins", "note");
    const cacheDir = path.join(dir, "console-data", "plugin-cache");
    writePlugin(pluginRoot, "note", { apiVersion: 1 });
    fs.writeFileSync(path.join(pluginRoot, "routes.ts"), "export function register() {}\n");
    let failRemoval = true;
    const host = createFleetPluginHost({
      cwd: dir,
      homeDir: path.join(dir, "home"),
      bundleCacheDir: cacheDir,
      removeBundleDir: async (target) => {
        if (failRemoval) throw new Error("remove failed");
        await fsPromises.rm(target, { recursive: true, force: true });
      },
      routes: new RouteRegistry(),
      upgrades: new UpgradeRegistry(),
      host: noopHostCapabilities,
    });
    await host.boot();
    const [generatedDir] = fs.readdirSync(cacheDir).filter((entry) => entry.startsWith("fleet-console-plugin-"));

    await host.cleanup();

    expect(fs.existsSync(path.join(cacheDir, generatedDir!))).toBe(true);
    failRemoval = false;
    await host.cleanup();
    expect(fs.readdirSync(cacheDir)).toEqual([]);
  });

  it("discovers built-in and home plugins while excluding shared", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugins-"));
    tempDirs.push(dir);
    writePlugin(path.join(dir, "runtime", "fleet-plugins", "demo"), "demo");
    fs.mkdirSync(path.join(dir, "runtime", "fleet-plugins", "shared"), { recursive: true });
    writePlugin(path.join(dir, "home", ".fleet", "plugins", "note"), "note");

    const plugins = discoverFleetPlugins({ cwd: dir, homeDir: path.join(dir, "home") });

    expect(plugins.map((plugin) => plugin.manifest.id)).toEqual(["demo", "note"]);
    expect(plugins.map((plugin) => plugin.external)).toEqual([false, true]);
  });

  it("parses plugin manifest apiVersion values", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-api-version-"));
    tempDirs.push(dir);
    writePlugin(path.join(dir, "home", ".fleet", "plugins", "note"), "note", { apiVersion: 1 });

    const plugins = discoverFleetPlugins({ cwd: dir, homeDir: path.join(dir, "home") });

    expect(plugins[0]?.manifest.apiVersion).toBe(1);
    expect(plugins[0]?.external).toBe(true);
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

  it("bundles external TypeScript plugins with callable HTTP and WebSocket catalog routes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-external-plugin-catalog-"));
    tempDirs.push(dir);
    const pluginRoot = path.join(dir, "home", ".fleet", "plugins", "external-catalog");
    writePlugin(pluginRoot, "external-catalog", { apiVersion: 1 });
    fs.writeFileSync(path.join(pluginRoot, "routes.ts"), [
      "import { definePlugin, registerRouter, registerWsHandler } from \"@fleet-console/sdk/plugin/node\";",
      "export default definePlugin({ id: \"external-catalog\", register(ctx) {",
      "  registerRouter(ctx, \"http\", () => true, { method: \"GET\", path: \"\", summary: \"External HTTP\", category: \"External\", gate: \"loopback\", transport: \"http\" });",
      "  registerWsHandler(ctx, \"socket\", () => true, { method: \"GET\", path: \"\", summary: \"External WS\", category: \"External\", gate: \"loopback\", transport: \"websocket\" });",
      "} });",
    ].join("\n"));
    const routes = new RouteRegistry();
    const upgrades = new UpgradeRegistry();
    const host = createFleetPluginHost({ cwd: dir, homeDir: path.join(dir, "home"), routes, upgrades, host: noopHostCapabilities });

    await host.boot();

    expect(await routes.handle({ req: {} as never, res: {} as never, pathname: "/plugins/external-catalog/http" })).toBe(true);
    expect(upgrades.handle({ req: {} as never, socket: {} as never, head: Buffer.alloc(0), pathname: "/plugins/external-catalog/ws/socket" })).toBe(true);
    expect(host.apiCatalog).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/plugins/external-catalog/http", transport: "http" }),
      expect.objectContaining({ path: "/plugins/external-catalog/ws/socket", transport: "websocket" }),
    ]));
  });

  it("resolves router and WebSocket metadata against final mount paths while preserving old calls", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-catalog-"));
    tempDirs.push(dir);
    writePlugin(path.join(dir, "runtime", "fleet-plugins", "demo"), "demo");
    const host = createFleetPluginHost({
      cwd: dir,
      homeDir: "/missing",
      routes: new RouteRegistry(),
      upgrades: new UpgradeRegistry(),
      host: noopHostCapabilities,
      importModule: async () => ({
        register: (ctx) => {
          ctx.registerRouter("legacy", () => true);
          ctx.registerRouter("nested", () => true, [
            { method: "GET", path: "", summary: "Read nested root.", category: "Demo Plugin", gate: "loopback", transport: "http" },
            { method: "POST", path: "/:itemId", summary: "Write nested item.", category: "Demo Plugin", gate: "origin-write", transport: "http" },
          ]);
          ctx.registerWsHandler("stream", () => true, {
            method: "GET", path: "", summary: "Open demo stream.", category: "Demo Plugin", gate: "one-use-ticket", transport: "websocket",
          });
        },
      }),
    });

    await host.boot();

    expect(host.apiCatalog).toEqual([
      expect.objectContaining({ method: "GET", path: "/plugins/demo/nested", transport: "http" }),
      expect.objectContaining({ method: "POST", path: "/plugins/demo/nested/:itemId", transport: "http" }),
      expect.objectContaining({ method: "GET", path: "/plugins/demo/ws/stream", transport: "websocket" }),
    ]);
    expect(host.apiCatalog.some((entry) => entry.path.includes("legacy"))).toBe(false);
  });

  it.each([
    ["method type", { method: 42 }],
    ["method value", { method: "get" }],
    ["summary type", { summary: 42 }],
    ["blank summary", { summary: " \t" }],
    ["category type", { category: 42 }],
    ["blank category", { category: " \n" }],
    ["gate type", { gate: 42 }],
    ["gate value", { gate: "public" }],
    ["transport type", { transport: 42 }],
    ["transport value", { transport: "udp" }],
    ["path type", { path: 42 }],
    ["relative path", { path: "items" }],
    ["multiple leading slashes", { path: "//items" }],
    ["empty path segment", { path: "/items//detail" }],
    ["query", { path: "/items?active=true" }],
    ["fragment", { path: "/items#detail" }],
    ["backslash", { path: "/items\\detail" }],
    ["current-directory traversal", { path: "/items/./detail" }],
    ["parent traversal", { path: "/items/../detail" }],
  ])("transactionally skips external plugin catalog metadata with malformed %s", async (_label, override) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-catalog-invalid-"));
    tempDirs.push(dir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writePlugin(path.join(dir, "home", ".fleet", "plugins", "bad"), "bad", { apiVersion: 1 });
    const routes = new RouteRegistry();
    const upgrades = new UpgradeRegistry();
    const validEntry = {
      method: "GET", path: "", summary: "Plugin endpoint.", category: "Demo Plugin", gate: "loopback", transport: "http",
    } as const;
    const malformedEntry = { ...validEntry, ...override } as unknown as ApiCatalogEntry;
    const host = createFleetPluginHost({
      cwd: dir,
      homeDir: path.join(dir, "home"),
      routes,
      upgrades,
      host: noopHostCapabilities,
      importModule: async () => ({
        register: (ctx) => {
          ctx.registerRouter("ready", () => true, validEntry);
          ctx.registerWsHandler("stream", () => true, { ...validEntry, gate: "one-use-ticket", transport: "websocket" });
          ctx.registerRouter("invalid", () => true, [validEntry, malformedEntry]);
        },
      }),
    });

    await expect(host.boot()).resolves.toBeUndefined();

    expect(host.apiCatalog).toEqual([]);
    expect(await routes.handle({ req: {} as never, res: {} as never, pathname: "/plugins/bad/ready" })).toBe(false);
    expect(await routes.handle({ req: {} as never, res: {} as never, pathname: "/plugins/bad/invalid" })).toBe(false);
    expect(upgrades.handle({ req: {} as never, socket: {} as never, head: Buffer.alloc(0), pathname: "/plugins/bad/ws/stream" })).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Plugin bad routes skipped: plugin_catalog_entry_invalid"));
  });

  it("rolls back host registrations, routes, upgrades, and catalog metadata from a failed external plugin", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-catalog-rollback-"));
    tempDirs.push(dir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writePlugin(path.join(dir, "runtime", "fleet-plugins", "ready"), "ready");
    writePlugin(path.join(dir, "home", ".fleet", "plugins", "bad"), "bad", { apiVersion: 1 });
    const routes = new RouteRegistry();
    const upgrades = new UpgradeRegistry();
    const disposed: string[] = [];
    const createDisposer = (name: string) => vi.fn(() => { disposed.push(name); });
    const operationTypeDisposer = createDisposer("operation-type");
    const sanitizerDisposer = createDisposer("sanitizer");
    const launchCatalogDisposer = createDisposer("launch-catalog");
    const subscriptionDisposer = createDisposer("subscription");
    const sseChannelDisposer = createDisposer("sse-channel");
    const cleanup = vi.fn(async () => {
      disposed.push("cleanup");
      throw new Error("rollback_failed");
    });
    const cleanupUnregister = createDisposer("cleanup-unregister");
    const manuallyUnregisteredCleanup = vi.fn(() => { disposed.push("manual-cleanup"); });
    const manualCleanupUnregister = createDisposer("manual-cleanup-unregister");
    const hostCapabilities: FleetPluginHostCapabilities = {
      ...noopHostCapabilities,
      operations: {
        ...noopHostCapabilities.operations,
        registerOperationType: vi.fn(() => operationTypeDisposer),
        registerPayloadSanitizer: vi.fn(() => sanitizerDisposer),
        registerLaunchCatalog: vi.fn(() => launchCatalogDisposer),
      },
      events: {
        ...noopHostCapabilities.events,
        subscribe: vi.fn(() => subscriptionDisposer),
        registerSseChannel: vi.fn(() => sseChannelDisposer),
      },
      lifecycle: {
        registerCleanup: vi.fn((registeredCleanup) => registeredCleanup === cleanup ? cleanupUnregister : manualCleanupUnregister),
      },
    };
    const host = createFleetPluginHost({
      cwd: dir,
      homeDir: path.join(dir, "home"),
      routes,
      upgrades,
      host: hostCapabilities,
      importModule: async (entry) => ({
        register: (ctx) => {
          const routeCatalog = { method: "GET", path: "", summary: "Plugin route.", category: "Demo Plugin", gate: "loopback", transport: "http" } as const;
          const upgradeCatalog = { method: "GET", path: "", summary: "Plugin upgrade.", category: "Demo Plugin", gate: "one-use-ticket", transport: "websocket" } as const;
          ctx.registerRouter("route", () => true, routeCatalog);
          ctx.registerWsHandler("stream", () => true, upgradeCatalog);
          if (!entry.includes(`${path.sep}bad${path.sep}`)) return;
          ctx.host.operations.registerOperationType("bad");
          const disposeSanitizer = ctx.host.operations.registerPayloadSanitizer(ctx.pluginId, ["pluginSecret"]);
          ctx.host.operations.registerLaunchCatalog(ctx.pluginId, () => []);
          ctx.host.events.subscribe("bad:event", () => {});
          ctx.host.events.registerSseChannel("bad:sse");
          ctx.host.lifecycle.registerCleanup(cleanup);
          const disposeManualCleanup = ctx.host.lifecycle.registerCleanup(manuallyUnregisteredCleanup);
          disposeSanitizer();
          disposeManualCleanup();
          ctx.registerRouter("invalid", () => true, { ...routeCatalog, method: "get" } as unknown as ApiCatalogEntry);
        },
      }),
    });

    await expect(host.boot()).resolves.toBeUndefined();

    expect(disposed).toEqual([
      "sanitizer",
      "manual-cleanup-unregister",
      "cleanup",
      "cleanup-unregister",
      "sse-channel",
      "subscription",
      "launch-catalog",
      "operation-type",
    ]);
    for (const disposer of [operationTypeDisposer, sanitizerDisposer, launchCatalogDisposer, subscriptionDisposer, sseChannelDisposer, cleanupUnregister, manualCleanupUnregister]) {
      expect(disposer).toHaveBeenCalledTimes(1);
    }
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(manuallyUnregisteredCleanup).not.toHaveBeenCalled();
    expect(host.apiCatalog.map((entry) => entry.path)).toEqual([
      "/plugins/ready/route",
      "/plugins/ready/ws/stream",
    ]);
    expect(await routes.handle({ req: {} as never, res: {} as never, pathname: "/plugins/ready/route" })).toBe(true);
    expect(upgrades.handle({ req: {} as never, socket: {} as never, head: Buffer.alloc(0), pathname: "/plugins/ready/ws/stream" })).toBe(true);
    expect(await routes.handle({ req: {} as never, res: {} as never, pathname: "/plugins/bad/route" })).toBe(false);
    expect(await routes.handle({ req: {} as never, res: {} as never, pathname: "/plugins/bad/invalid" })).toBe(false);
    expect(upgrades.handle({ req: {} as never, socket: {} as never, head: Buffer.alloc(0), pathname: "/plugins/bad/ws/stream" })).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Plugin bad routes skipped: plugin_catalog_entry_invalid"));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("rollback_failed"));
  });

  it("retains successful host registrations and keeps returned disposers once-only", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-registration-success-"));
    tempDirs.push(dir);
    writePlugin(path.join(dir, "runtime", "fleet-plugins", "demo"), "demo");
    const operationTypeDisposer = vi.fn();
    let disposeOperationType: (() => void) | null = null;
    const host = createFleetPluginHost({
      cwd: dir,
      homeDir: "/missing",
      routes: new RouteRegistry(),
      upgrades: new UpgradeRegistry(),
      host: {
        ...noopHostCapabilities,
        operations: {
          ...noopHostCapabilities.operations,
          registerOperationType: vi.fn(() => operationTypeDisposer),
        },
      },
      importModule: async () => ({
        register: (ctx) => {
          disposeOperationType = ctx.host.operations.registerOperationType("demo");
        },
      }),
    });

    await host.boot();

    expect(operationTypeDisposer).not.toHaveBeenCalled();
    expect(disposeOperationType).not.toBeNull();
    disposeOperationType!();
    disposeOperationType!();
    expect(operationTypeDisposer).toHaveBeenCalledTimes(1);
  });

  it("leaves no partial route surface when a built-in plugin register fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-built-in-rollback-"));
    tempDirs.push(dir);
    writePlugin(path.join(dir, "runtime", "fleet-plugins", "bad"), "bad");
    const routes = new RouteRegistry();
    const upgrades = new UpgradeRegistry();
    const operationTypeDisposer = vi.fn();
    const host = createFleetPluginHost({
      cwd: dir,
      homeDir: "/missing",
      routes,
      upgrades,
      host: {
        ...noopHostCapabilities,
        operations: {
          ...noopHostCapabilities.operations,
          registerOperationType: vi.fn(() => operationTypeDisposer),
        },
      },
      importModule: async () => ({
        register: (ctx) => {
          ctx.registerRouter("route", () => true, { method: "GET", path: "", summary: "Plugin route.", category: "Demo Plugin", gate: "loopback", transport: "http" });
          ctx.registerWsHandler("stream", () => true, { method: "GET", path: "", summary: "Plugin upgrade.", category: "Demo Plugin", gate: "one-use-ticket", transport: "websocket" });
          ctx.host.operations.registerOperationType("bad");
          throw new Error("boot_failed");
        },
      }),
    });

    await expect(host.boot()).rejects.toThrow("boot_failed");

    expect(operationTypeDisposer).toHaveBeenCalledTimes(1);
    expect(host.apiCatalog).toEqual([]);
    expect(await routes.handle({ req: {} as never, res: {} as never, pathname: "/plugins/bad/route" })).toBe(false);
    expect(upgrades.handle({ req: {} as never, socket: {} as never, head: Buffer.alloc(0), pathname: "/plugins/bad/ws/stream" })).toBe(false);
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

  it("quarantines external plugin route failures without stopping built-in route boot", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-quarantine-"));
    tempDirs.push(dir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writePlugin(path.join(dir, "runtime", "fleet-plugins", "terminal"), "terminal");
    writePlugin(path.join(dir, "home", ".fleet", "plugins", "bad"), "bad", { apiVersion: 1 });
    const routes = new RouteRegistry();
    const host = createFleetPluginHost({
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

  it("keeps the first plugin id when duplicate ids are discovered", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-dedupe-"));
    tempDirs.push(dir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writePlugin(path.join(dir, "runtime", "fleet-plugins", "demo"), "demo", {}, false);
    writePlugin(path.join(dir, "home", ".fleet", "plugins", "demo"), "demo", { apiVersion: 1 }, false);

    const host = createFleetPluginHost({
      cwd: dir,
      homeDir: path.join(dir, "home"),
      routes: new RouteRegistry(),
      upgrades: new UpgradeRegistry(),
      host: noopHostCapabilities,
    });

    expect(host.plugins).toHaveLength(1);
    expect(host.plugins[0]?.external).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("duplicate id"));
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

  it("allows only a plugin's own absolute API namespace", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-api-scope-"));
    tempDirs.push(dir);
    writePlugin(path.join(dir, "runtime", "fleet-plugins", "demo"), "demo");

    const createHost = (register: (ctx: { registerRouter(path: string, handler: () => boolean): void }) => void) => createFleetPluginHost({
      cwd: dir, homeDir: "/missing", bundleCacheDir: path.join(dir, "cache"), routes: new RouteRegistry(), upgrades: new UpgradeRegistry(), host: noopHostCapabilities,
      importModule: async () => ({ register }),
    });

    await expect(createHost((ctx) => ctx.registerRouter("/api/v1/plugins/demo/widgets", () => true)).boot()).resolves.toBeUndefined();
    await expect(createHost((ctx) => ctx.registerRouter("/api/v1/plugins/other/widgets", () => true)).boot()).rejects.toThrow("plugin_route_outside_scope");
    await expect(createHost((ctx) => ctx.registerRouter("/api/v1/settings/widgets", () => true)).boot()).rejects.toThrow("plugin_route_outside_scope");
    await expect(createHost((ctx) => ctx.registerRouter("/api/v1/plugins/demo/../other/widgets", () => true)).boot()).rejects.toThrow("plugin_route_outside_scope");
  });

  it("exposes the host-resolved Fleet data directory to plugins", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-plugin-fleet-data-"));
    tempDirs.push(dir);
    writePlugin(path.join(dir, "runtime", "fleet-plugins", "demo"), "demo");
    let fleetDataDir: string | null = null;
    const host = createFleetPluginHost({
      cwd: dir, homeDir: "/missing", bundleCacheDir: path.join(dir, "cache"), routes: new RouteRegistry(), upgrades: new UpgradeRegistry(), host: noopHostCapabilities,
      importModule: async () => ({ register: (ctx) => { fleetDataDir = ctx.host.paths.fleetDataDir; } }),
    });

    await host.boot();
    expect(fleetDataDir).toBe("/tmp/fleet-console-test");
  });
});

function writePlugin(root: string, id: string, manifest: Record<string, unknown> = {}, writeRoutes = true): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify({ id, routes: "routes.ts", ...manifest }));
  if (writeRoutes) fs.writeFileSync(path.join(root, "routes.ts"), "export function register() {}");
}
