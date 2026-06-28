import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { DiscoveredFleetPlugin, FleetPluginManifest } from "./types.js";

export interface DiscoverFleetPluginsOptions {
  readonly cwd?: string;
  readonly builtInSourceRoot?: string;
  readonly builtInDistRoot?: string;
  readonly homeDir?: string;
}

export function discoverFleetPlugins(options: DiscoverFleetPluginsOptions = {}): readonly DiscoveredFleetPlugin[] {
  const builtInSourceRoot = options.builtInSourceRoot ?? (options.cwd ? path.resolve(options.cwd, "runtime/fleet-plugins") : null);
  const roots = [
    ...(builtInSourceRoot ? [{ root: builtInSourceRoot, builtInDistRoot: options.builtInDistRoot ?? null, external: false }] : []),
    { root: path.join(options.homeDir ?? os.homedir(), ".fleet", "plugins"), builtInDistRoot: null, external: true },
  ];
  const sourcePlugins = roots.flatMap((root) => discoverPluginRoot(root.root, root.builtInDistRoot, root.external));
  const sourcePluginIds = new Set(sourcePlugins.map((plugin) => plugin.manifest.id));
  const distPlugins = options.builtInDistRoot ? discoverDistPluginRoot(options.builtInDistRoot).filter((plugin) => !sourcePluginIds.has(plugin.manifest.id)) : [];
  return [...sourcePlugins, ...distPlugins];
}

export function parseFleetPluginManifest(value: unknown): FleetPluginManifest | null {
  if (!isRecord(value)) return null;
  const id = readPluginId(value.id);
  if (!id) return null;
  return {
    id,
    ...(typeof value.apiVersion === "number" ? { apiVersion: value.apiVersion } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.client === "string" ? { client: value.client } : {}),
    ...(typeof value.routes === "string" ? { routes: value.routes } : {}),
    ...(Array.isArray(value.sensitiveFields) ? { sensitiveFields: value.sensitiveFields.filter((field): field is string => typeof field === "string") } : {}),
  };
}

function discoverPluginRoot(root: string, builtInDistRoot: string | null, external: boolean): readonly DiscoveredFleetPlugin[] {
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const plugins: DiscoveredFleetPlugin[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "shared") continue;
    const pluginRoot = path.join(root, entry.name);
    const manifestPath = path.join(pluginRoot, "plugin.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = readManifest(manifestPath);
    if (!manifest) continue;
    const clientEntry = resolveOptionalManifestEntry(pluginRoot, manifest.client, "client");
    if (clientEntry === false) continue;
    const routesEntry = resolveRoutesEntry(pluginRoot, manifest, builtInDistRoot);
    if (routesEntry === false) continue;
    plugins.push({ root: pluginRoot, manifest, clientEntry, routesEntry, external });
  }
  return plugins;
}

function discoverDistPluginRoot(root: string): readonly DiscoveredFleetPlugin[] {
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const plugins: DiscoveredFleetPlugin[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "shared") continue;
    const pluginRoot = path.join(root, entry.name);
    const manifestPath = path.join(pluginRoot, "plugin.json");
    const manifest = fs.existsSync(manifestPath) ? readManifest(manifestPath) : readDistPluginManifest(entry.name);
    if (!manifest) continue;
    const clientEntry = resolveOptionalManifestEntry(pluginRoot, manifest.client, "client");
    if (clientEntry === false) continue;
    const routesEntry = resolveDistRoutesEntry(pluginRoot, manifest);
    if (!routesEntry) continue;
    plugins.push({ root: pluginRoot, manifest, clientEntry, routesEntry, external: false });
  }
  return plugins;
}

function readManifest(manifestPath: string): FleetPluginManifest | null {
  try {
    const manifest = parseFleetPluginManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    if (!manifest) console.warn(`[fleet-console] Plugin manifest skipped: invalid manifest at ${manifestPath}`);
    return manifest;
  } catch (error) {
    console.warn(`[fleet-console] Plugin manifest skipped: ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function resolveRoutesEntry(pluginRoot: string, manifest: FleetPluginManifest, builtInDistRoot: string | null): string | false | null {
  if (manifest.routes) {
    const manifestRoute = resolveOptionalManifestEntry(pluginRoot, manifest.routes, "routes");
    if (manifestRoute === false) return false;
    if (manifestRoute) return manifestRoute;
  }
  const manifestRoute = path.join(pluginRoot, "routes.ts");
  if (fs.existsSync(manifestRoute)) return manifestRoute;
  if (!builtInDistRoot) return null;
  const builtRoute = path.join(builtInDistRoot, manifest.id, "routes.mjs");
  return fs.existsSync(builtRoute) ? builtRoute : null;
}

function resolveDistRoutesEntry(pluginRoot: string, manifest: FleetPluginManifest): string | null {
  const routesEntry = resolveOptionalManifestEntry(pluginRoot, manifest.routes ?? "routes.mjs", "routes");
  if (routesEntry === false) return null;
  return routesEntry;
}

function resolveOptionalManifestEntry(pluginRoot: string, entryPath: string | undefined, label: string): string | false | null {
  if (!entryPath) return null;
  if (!isSafeRelativeEntry(entryPath)) {
    console.warn(`[fleet-console] Plugin ${label} entry skipped: unsafe relative path ${entryPath}`);
    return false;
  }
  const candidate = path.resolve(pluginRoot, entryPath);
  if (!fs.existsSync(candidate)) return null;
  const rootRealpath = fs.realpathSync.native(pluginRoot);
  const entryRealpath = fs.realpathSync.native(candidate);
  if (!isSubpath(rootRealpath, entryRealpath)) {
    console.warn(`[fleet-console] Plugin ${label} entry skipped: path escapes plugin root ${entryPath}`);
    return false;
  }
  return entryRealpath;
}

function readPluginId(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]*$/u.test(value) ? value : null;
}

function readDistPluginManifest(id: string): FleetPluginManifest | null {
  const pluginId = readPluginId(id);
  return pluginId ? { id: pluginId, routes: "routes.mjs" } : null;
}

function isSafeRelativeEntry(entryPath: string): boolean {
  if (path.isAbsolute(entryPath)) return false;
  return entryPath.split(/[\\/]+/u).every((segment) => segment !== "..");
}

function isSubpath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
