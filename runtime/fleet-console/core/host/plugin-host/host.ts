import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SDK_API_VERSION } from "@fleet-console/sdk/version";

import { discoverFleetPlugins, type DiscoverFleetPluginsOptions } from "./discovery.js";
import type { DiscoveredFleetPlugin, FleetPluginHostCapabilities, FleetPluginRouteModule, FleetPluginServerContext } from "./types.js";
import type { RouteHandler, RouteRegistry } from "../route-registry/route-registry.js";
import type { UpgradeHandler, UpgradeRegistry } from "../route-registry/upgrade-registry.js";

export interface FleetPluginHostDeps extends DiscoverFleetPluginsOptions {
  readonly routes: RouteRegistry;
  readonly upgrades: UpgradeRegistry;
  readonly host: FleetPluginHostCapabilities;
  readonly importModule?: (entry: string) => Promise<FleetPluginRouteModule>;
  readonly bundleCacheDir?: string;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly removeBundleDir?: (dir: string) => Promise<void>;
}

export interface FleetPluginHost {
  readonly plugins: readonly DiscoveredFleetPlugin[];
  readonly sensitiveFieldsByPluginId: ReadonlyMap<string, readonly string[]>;
  boot(): Promise<void>;
  cleanup(): Promise<void>;
}

interface PluginBundleOwner {
  readonly pid: number;
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
  "@fleet-plugins/*",
];
const PLUGIN_BUNDLE_DIR_PREFIX = "fleet-console-plugin-";
const PLUGIN_BUNDLE_OWNER_FILE = ".fleet-console-plugin-owner.json";
const PLUGIN_BUNDLE_PID_PATTERN = /^fleet-console-plugin-(\d+)-/u;
const MAX_PLUGIN_BUNDLE_OWNER_PID = 0x7fff_ffff;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createFleetPluginHost(deps: FleetPluginHostDeps): FleetPluginHost {
  const plugins = filterDiscoveredPlugins(discoverFleetPlugins(deps));
  const sensitiveFieldsByPluginId = new Map(plugins.map((plugin) => [plugin.manifest.id, plugin.manifest.sensitiveFields ?? []]));
  const generatedBundleDirs = new Set<string>();
  const isProcessAlive = deps.isProcessAlive ?? isPluginBundleOwnerAlive;
  const removeBundleDir = deps.removeBundleDir ?? removePluginBundleDir;
  const importModule = deps.importModule ?? ((entry) => importPluginModule(entry, deps.bundleCacheDir, generatedBundleDirs));

  async function boot(): Promise<void> {
    await removeStalePluginBundleDirs(deps.bundleCacheDir, isProcessAlive, removeBundleDir);
    for (const plugin of plugins) {
      if (!plugin.routesEntry) continue;
      if (!plugin.external) {
        await bootPluginRoutes(plugin);
        continue;
      }
      try {
        await bootPluginRoutes(plugin);
      } catch (error) {
        console.warn(`[fleet-console] Plugin ${plugin.manifest.id} routes skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async function cleanup(): Promise<void> {
    const dirs = [...generatedBundleDirs];
    const cleanupResults = await Promise.allSettled(dirs.map((dir) => removeBundleDir(dir)));
    for (const [index, result] of cleanupResults.entries()) {
      const dir = dirs[index]!;
      if (result.status === "fulfilled") {
        generatedBundleDirs.delete(dir);
        continue;
      }
      if (result.status === "rejected") {
        console.warn(`[fleet-console] Plugin bundle cache cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    }
  }

  return { plugins, sensitiveFieldsByPluginId, boot, cleanup };

  async function bootPluginRoutes(plugin: DiscoveredFleetPlugin): Promise<void> {
    const mod = await importModule(plugin.routesEntry!);
    const register = resolveRegister(mod);
    if (!register) return;
    await register({
      pluginId: plugin.manifest.id,
      manifest: plugin.manifest,
      basePath: `/plugins/${plugin.manifest.id}`,
      wsBasePath: `/plugins/${plugin.manifest.id}/ws`,
      host: deps.host,
      registerRouter: createScopedRouteRegistrar(deps.routes, `/plugins/${plugin.manifest.id}`, `/api/v1/plugins/${plugin.manifest.id}`),
      registerWsHandler: createScopedUpgradeRegistrar(deps.upgrades, `/plugins/${plugin.manifest.id}/ws`),
    });
  }
}

function filterDiscoveredPlugins(plugins: readonly DiscoveredFleetPlugin[]): readonly DiscoveredFleetPlugin[] {
  const accepted: DiscoveredFleetPlugin[] = [];
  const seen = new Set<string>();
  for (const plugin of plugins) {
    const id = plugin.manifest.id;
    if (seen.has(id)) {
      console.warn(`[fleet-console] Plugin ${id} skipped: duplicate id (${plugin.root})`);
      continue;
    }
    if (plugin.external && plugin.manifest.apiVersion !== SDK_API_VERSION) {
      console.warn(`[fleet-console] Plugin ${id} skipped: unsupported apiVersion (${String(plugin.manifest.apiVersion)})`);
      continue;
    }
    seen.add(id);
    accepted.push(plugin);
  }
  return accepted;
}

async function importPluginModule(entry: string, bundleCacheDir: string | undefined, generatedBundleDirs: Set<string>): Promise<FleetPluginRouteModule> {
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
      nodePaths: [resolveConsolePackageNodeModules()].filter((value): value is string => value !== null),
    });
    const bundled = output.outputFiles[0]?.text;
    if (!bundled) throw new Error("plugin_bundle_failed");
    const bundledPath = await writeTemporaryPluginBundle(entry, bundled, bundleCacheDir, generatedBundleDirs);
    return await import(pathToFileURL(bundledPath).href) as FleetPluginRouteModule;
  }
  return await import(pathToFileURL(entry).href) as FleetPluginRouteModule;
}

async function writeTemporaryPluginBundle(entry: string, source: string, bundleCacheDir: string | undefined, generatedBundleDirs: Set<string>): Promise<string> {
  const cacheRoot = bundleCacheDir ?? path.join(resolvePluginBundleNodeModules(entry), ".cache");
  await mkdir(cacheRoot, { recursive: true });
  const dir = await mkdtemp(path.join(cacheRoot, `${PLUGIN_BUNDLE_DIR_PREFIX}${process.pid}-`));
  if (bundleCacheDir) {
    generatedBundleDirs.add(dir);
    await writePluginBundleOwner(dir, process.pid);
  }
  const file = path.join(dir, "routes.mjs");
  await writeFile(file, source, "utf8");
  return file;
}

async function removeStalePluginBundleDirs(bundleCacheDir: string | undefined, isProcessAlive: (pid: number) => boolean, removeBundleDir: (dir: string) => Promise<void>): Promise<void> {
  if (!bundleCacheDir) return;
  try {
    await mkdir(bundleCacheDir, { recursive: true });
    const entries = await readdir(bundleCacheDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.startsWith(PLUGIN_BUNDLE_DIR_PREFIX)) continue;
      const entryPath = path.join(bundleCacheDir, entry.name);
      const ownerPid = await readPluginBundleOwnerPid(entryPath, entry.name);
      if (ownerPid !== null && isProcessAlive(ownerPid)) continue;
      try {
        await removeBundleDir(entryPath);
      } catch (error) {
        console.warn(`[fleet-console] Plugin bundle cache startup cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    console.warn(`[fleet-console] Plugin bundle cache startup cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function removePluginBundleDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

async function writePluginBundleOwner(dir: string, pid: number): Promise<void> {
  await writeFile(path.join(dir, PLUGIN_BUNDLE_OWNER_FILE), JSON.stringify({ pid }), "utf8");
}

async function readPluginBundleOwnerPid(dir: string, name: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, PLUGIN_BUNDLE_OWNER_FILE), "utf8")) as PluginBundleOwner;
    if (isPluginBundleOwnerPid(parsed.pid)) return parsed.pid;
  } catch {
    // Marker write can be interrupted; fall back to the PID embedded in the directory name.
  }
  const pid = Number(PLUGIN_BUNDLE_PID_PATTERN.exec(name)?.[1]);
  return isPluginBundleOwnerPid(pid) ? pid : null;
}

function isPluginBundleOwnerAlive(pid: number): boolean {
  if (!isPluginBundleOwnerPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

function isPluginBundleOwnerPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_PLUGIN_BUNDLE_OWNER_PID;
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

function createScopedRouteRegistrar(routes: RouteRegistry, basePath: string, apiBasePath: string): FleetPluginServerContext["registerRouter"] {
  return (requestedPath: string, handler: RouteHandler) => {
    const prefix = resolveScopedPrefix(basePath, requestedPath, apiBasePath);
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

function resolveScopedPrefix(basePath: string, requestedPath: string, apiBasePath?: string): string {
  if (requestedPath.split("/").some((segment) => segment === "." || segment === "..")) throw new Error("plugin_route_outside_scope");
  const normalizedBase = normalizePrefix(basePath);
  if (!requestedPath.startsWith("/")) return normalizePrefix(`${normalizedBase}/${requestedPath}`);
  const normalizedRequest = normalizePrefix(requestedPath);
  if (normalizedRequest === normalizedBase || normalizedRequest.startsWith(`${normalizedBase}/`)) return normalizedRequest;
  const normalizedApiBase = apiBasePath ? normalizePrefix(apiBasePath) : null;
  if (normalizedApiBase && (normalizedRequest === normalizedApiBase || normalizedRequest.startsWith(`${normalizedApiBase}/`))) return normalizedRequest;
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
