import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { discoverFleetPlugins, type DiscoverFleetPluginsOptions } from "./discovery.js";
import type { DiscoveredFleetPlugin, FleetPluginHostCapabilities, FleetPluginRouteModule, FleetPluginServerContext } from "./types.js";
import type { RouteHandler, RouteRegistry } from "../route-registry/route-registry.js";
import type { UpgradeHandler, UpgradeRegistry } from "../route-registry/upgrade-registry.js";

export interface FleetPluginHostDeps extends DiscoverFleetPluginsOptions {
  readonly routes: RouteRegistry;
  readonly upgrades: UpgradeRegistry;
  readonly host: FleetPluginHostCapabilities;
  readonly importModule?: (entry: string) => Promise<FleetPluginRouteModule>;
}

export interface FleetPluginHost {
  readonly plugins: readonly DiscoveredFleetPlugin[];
  readonly sensitiveFieldsByPluginId: ReadonlyMap<string, readonly string[]>;
  boot(): Promise<void>;
}

const PLUGIN_DEV_EXTERNALS = [
  "node:*",
  "fs",
  "path",
  "os",
  "crypto",
  "stream",
  "events",
  "child_process",
  "node-pty",
  "ws",
  "@fleet-console/sdk",
  "@fleet-console/sdk/*",
  "@dotobokuri/*",
  "@fleet-plugins/*",
];
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createFleetPluginHost(deps: FleetPluginHostDeps): FleetPluginHost {
  const plugins = discoverFleetPlugins(deps);
  const sensitiveFieldsByPluginId = new Map(plugins.map((plugin) => [plugin.manifest.id, plugin.manifest.sensitiveFields ?? []]));
  const importModule = deps.importModule ?? importPluginModule;

  async function boot(): Promise<void> {
    for (const plugin of plugins) {
      if (!plugin.routesEntry) continue;
      const mod = await importModule(plugin.routesEntry);
      const register = resolveRegister(mod);
      if (!register) continue;
      await register({
        pluginId: plugin.manifest.id,
        manifest: plugin.manifest,
        basePath: `/plugins/${plugin.manifest.id}`,
        wsBasePath: `/plugins/${plugin.manifest.id}/ws`,
        host: deps.host,
        registerRouter: createScopedRouteRegistrar(deps.routes, `/plugins/${plugin.manifest.id}`),
        registerWsHandler: createScopedUpgradeRegistrar(deps.upgrades, `/plugins/${plugin.manifest.id}/ws`),
      });
    }
  }

  return { plugins, sensitiveFieldsByPluginId, boot };
}

async function importPluginModule(entry: string): Promise<FleetPluginRouteModule> {
  if (entry.endsWith(".ts")) {
    const { build } = await import("esbuild");
    const output = await build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      write: false,
      sourcemap: false,
      external: PLUGIN_DEV_EXTERNALS,
    });
    const bundled = output.outputFiles[0]?.text;
    if (!bundled) throw new Error("plugin_bundle_failed");
    const bundledPath = await writeTemporaryPluginBundle(entry, bundled);
    return await import(pathToFileURL(bundledPath).href) as FleetPluginRouteModule;
  }
  return await import(pathToFileURL(entry).href) as FleetPluginRouteModule;
}

async function writeTemporaryPluginBundle(entry: string, source: string): Promise<string> {
  const cacheRoot = path.join(resolvePluginBundleNodeModules(entry), ".cache");
  await mkdir(cacheRoot, { recursive: true });
  const dir = await mkdtemp(path.join(cacheRoot, "fleet-console-plugin-"));
  const file = path.join(dir, "routes.mjs");
  await writeFile(file, source, "utf8");
  return file;
}

function resolvePluginBundleNodeModules(entry: string): string {
  const packageNodeModules = resolveConsolePackageNodeModules();
  let dir = path.dirname(entry);
  let fallback: string | null = packageNodeModules;
  while (true) {
    const workspaceConsoleNodeModules = path.join(dir, "runtime", "fleet-console", "node_modules");
    if (hasFleetConsoleSdk(workspaceConsoleNodeModules)) return workspaceConsoleNodeModules;
    const candidate = path.join(dir, "node_modules");
    if (hasFleetConsoleSdk(candidate)) return candidate;
    if (fallback === null && existsSync(candidate)) fallback = candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return fallback ?? path.join(path.dirname(entry), "node_modules");
    dir = parent;
  }
}

function resolveConsolePackageNodeModules(): string | null {
  for (const candidate of [
    path.resolve(__dirname, "..", "node_modules"),
    path.resolve(__dirname, "..", "..", "..", "node_modules"),
  ]) {
    if (hasFleetConsoleSdk(candidate)) return candidate;
  }
  return null;
}

function hasFleetConsoleSdk(nodeModules: string): boolean {
  return existsSync(path.join(nodeModules, "@fleet-console", "sdk"));
}

function resolveRegister(mod: FleetPluginRouteModule): ((ctx: FleetPluginServerContext) => void | Promise<void>) | null {
  if (mod.register) return mod.register;
  if (typeof mod.default === "function") return mod.default;
  return mod.default?.register ?? null;
}

function createScopedRouteRegistrar(routes: RouteRegistry, basePath: string): FleetPluginServerContext["registerRouter"] {
  return (requestedPath: string, handler: RouteHandler) => {
    const prefix = resolveScopedPrefix(basePath, requestedPath);
    assertNoRouteOverlap(prefix, routes.list().map((route) => route.prefix));
    routes.register(prefix, handler);
  };
}

function createScopedUpgradeRegistrar(upgrades: UpgradeRegistry, basePath: string): FleetPluginServerContext["registerWsHandler"] {
  return (requestedPath: string, handler: UpgradeHandler) => {
    const prefix = resolveScopedPrefix(basePath, requestedPath);
    assertNoRouteOverlap(prefix, upgrades.list().map((upgrade) => upgrade.prefix));
    upgrades.register(prefix, handler);
  };
}

function resolveScopedPrefix(basePath: string, requestedPath: string): string {
  const normalizedBase = normalizePrefix(basePath);
  if (!requestedPath.startsWith("/")) return normalizePrefix(`${normalizedBase}/${requestedPath}`);
  const normalizedRequest = normalizePrefix(requestedPath);
  if (normalizedRequest === normalizedBase || normalizedRequest.startsWith(`${normalizedBase}/`)) return normalizedRequest;
  if (normalizedRequest === "/") return normalizedBase;
  throw new Error("plugin_route_outside_scope");
}

function assertNoRouteOverlap(prefix: string, existingPrefixes: readonly string[]): void {
  for (const existingPrefix of existingPrefixes) {
    if (prefixesOverlap(prefix, normalizePrefix(existingPrefix))) throw new Error("plugin_route_prefix_conflict");
  }
}

function prefixesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function normalizePrefix(prefix: string): string {
  if (!prefix.startsWith("/")) return normalizePrefix(`/${prefix}`);
  return prefix.length > 1 && prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
}
