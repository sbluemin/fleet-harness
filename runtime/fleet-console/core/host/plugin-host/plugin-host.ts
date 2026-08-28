import type {
  DiscoveredFleetPlugin as SdkDiscoveredFleetPlugin,
} from "@fleet-console/sdk/plugin";

export interface DiscoveredFleetPlugin extends SdkDiscoveredFleetPlugin {
  readonly external: boolean;
}

export type {
  ApiCatalogEntry,
  FleetPluginDefinition,
  FleetPluginEventsHost,
  FleetPluginHostCapabilities,
  FleetPluginHttpHost,
  FleetPluginLifecycleHost,
  FleetPluginManifest,
  FleetPluginOperationsHost,
  FleetPluginPathsHost,
  FleetPluginRouteExport,
  FleetPluginRouteModule,
  FleetPluginSecurityHost,
  FleetPluginServerContext,
  FleetPluginStorageHost,
  OperationCatalogPlugin,
  OperationLaunchCatalogProvider,
  OperationLaunchKind,
  OperationLaunchView,
} from "@fleet-console/sdk/plugin";
import type { ApiCatalogEntry, FleetPluginHostCapabilities, FleetPluginManifest, FleetPluginRouteModule, FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import fs from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SDK_API_VERSION } from "@fleet-console/sdk/version";
import type { Plugin } from "esbuild";

import { SHIM_NAMED_EXPORTS } from "./shim-keys.generated.js";

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

function parseFleetPluginManifest(value: unknown): FleetPluginManifest | null {
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

export interface PluginClientAssetsDeps {
  readonly plugins: readonly DiscoveredFleetPlugin[];
}

export interface PluginClientManifestDto {
  readonly plugins: readonly PluginClientManifestEntryDto[];
  /**
   * 발견됐지만 브라우저 표면을 세우지 못한 플러그인. 예전에는 이 사실이 서버 로그에만 남아,
   * 운영자에게는 패널이 그냥 없는 것으로 보였다. 이유는 분류 코드로만 싣는다 — 번들러 오류
   * 원문에는 플러그인 루트의 절대 경로가 들어 있다.
   */
  readonly skipped?: readonly PluginClientSkippedDto[];
}

export interface PluginClientSkippedDto {
  readonly id: string;
  readonly name?: string;
  readonly reason: "unsupported_client_entry" | "client_build_failed";
}

export interface PluginClientManifestEntryDto {
  readonly id: string;
  readonly name?: string;
  readonly clientUrl: string;
  readonly apiVersion: number;
}

export interface PluginClientAssets {
  prepare(): Promise<void>;
  manifest(): PluginClientManifestDto;
  getClient(id: string): string | null;
  getShim(name: string): string | null;
}

interface ShimDefinition {
  readonly name: string;
  readonly specifier: string;
  readonly globalKey: string;
  readonly namedExports: readonly string[];
}

const SHIM_DEFINITIONS: readonly ShimDefinition[] = [
  { name: "react", specifier: "react", globalKey: "react", namedExports: SHIM_NAMED_EXPORTS["react"] ?? [] },
  { name: "react-jsx-runtime", specifier: "react/jsx-runtime", globalKey: "react/jsx-runtime", namedExports: SHIM_NAMED_EXPORTS["react/jsx-runtime"] ?? [] },
  { name: "sdk-plugin-browser", specifier: "@fleet-console/sdk/plugin/browser", globalKey: "@fleet-console/sdk/plugin/browser", namedExports: SHIM_NAMED_EXPORTS["@fleet-console/sdk/plugin/browser"] ?? [] },
  { name: "sdk-settings-browser", specifier: "@fleet-console/sdk/settings/browser", globalKey: "@fleet-console/sdk/settings/browser", namedExports: SHIM_NAMED_EXPORTS["@fleet-console/sdk/settings/browser"] ?? [] },
  { name: "sdk-operations-browser", specifier: "@fleet-console/sdk/operations/browser", globalKey: "@fleet-console/sdk/operations/browser", namedExports: SHIM_NAMED_EXPORTS["@fleet-console/sdk/operations/browser"] ?? [] },
  { name: "sdk-notifications-browser", specifier: "@fleet-console/sdk/notifications/browser", globalKey: "@fleet-console/sdk/notifications/browser", namedExports: SHIM_NAMED_EXPORTS["@fleet-console/sdk/notifications/browser"] ?? [] },
  { name: "sdk-react-browser", specifier: "@fleet-console/sdk/react/browser", globalKey: "@fleet-console/sdk/react/browser", namedExports: SHIM_NAMED_EXPORTS["@fleet-console/sdk/react/browser"] ?? [] },
  { name: "sdk-components-failure-notice", specifier: "@fleet-console/sdk/components/failure-notice", globalKey: "@fleet-console/sdk/components/failure-notice", namedExports: SHIM_NAMED_EXPORTS["@fleet-console/sdk/components/failure-notice"] ?? [] },
  { name: "sdk-components-effort-track", specifier: "@fleet-console/sdk/components/effort-track", globalKey: "@fleet-console/sdk/components/effort-track", namedExports: SHIM_NAMED_EXPORTS["@fleet-console/sdk/components/effort-track"] ?? [] },
  { name: "sdk-components-launch-provider-glyphs", specifier: "@fleet-console/sdk/components/launch-provider-glyphs", globalKey: "@fleet-console/sdk/components/launch-provider-glyphs", namedExports: SHIM_NAMED_EXPORTS["@fleet-console/sdk/components/launch-provider-glyphs"] ?? [] },
  { name: "sdk-components-shell-glyph", specifier: "@fleet-console/sdk/components/shell-glyph", globalKey: "@fleet-console/sdk/components/shell-glyph", namedExports: SHIM_NAMED_EXPORTS["@fleet-console/sdk/components/shell-glyph"] ?? [] },
];
const SHIM_URL_BY_SPECIFIER = new Map(SHIM_DEFINITIONS.map((definition) => [definition.specifier, `/plugin-runtime/shim/${definition.name}.mjs`]));
const SHIM_BY_NAME = new Map(SHIM_DEFINITIONS.map((definition) => [definition.name, definition]));
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

export function createPluginClientAssets(deps: PluginClientAssetsDeps): PluginClientAssets {
  const clientSources = new Map<string, string>();
  const preparedPlugins = new Set<string>();
  const skippedPlugins = new Map<string, PluginClientSkippedDto>();

  async function prepare(): Promise<void> {
    clientSources.clear();
    preparedPlugins.clear();
    skippedPlugins.clear();
    for (const plugin of deps.plugins) {
      if (!plugin.external || !plugin.clientEntry) continue;
      try {
        const source = await readClientSource(plugin.clientEntry, plugin.root);
        clientSources.set(plugin.manifest.id, source);
        preparedPlugins.add(plugin.manifest.id);
      } catch (error) {
        console.warn(`[fleet-console] Plugin ${plugin.manifest.id} client skipped: ${error instanceof Error ? error.message : String(error)}`);
        skippedPlugins.set(plugin.manifest.id, {
          id: plugin.manifest.id,
          ...(plugin.manifest.name ? { name: plugin.manifest.name } : {}),
          reason: (error as Error | undefined)?.message === "unsupported_client_entry" ? "unsupported_client_entry" : "client_build_failed",
        });
      }
    }
  }

  function manifest(): PluginClientManifestDto {
    const skipped = [...skippedPlugins.values()];
    return {
      plugins: deps.plugins.filter((plugin) => plugin.external && !!plugin.clientEntry && preparedPlugins.has(plugin.manifest.id)).map((plugin) => ({
        id: plugin.manifest.id,
        ...(plugin.manifest.name ? { name: plugin.manifest.name } : {}),
        clientUrl: `/plugin-runtime/client/${plugin.manifest.id}.mjs`,
        apiVersion: plugin.manifest.apiVersion ?? SDK_API_VERSION,
      })),
      ...(skipped.length > 0 ? { skipped } : {}),
    };
  }

  function getClient(id: string): string | null {
    return clientSources.get(id) ?? null;
  }

  function getShim(name: string): string | null {
    const definition = SHIM_BY_NAME.get(name);
    return definition ? renderShim(definition) : null;
  }

  return { prepare, manifest, getClient, getShim };
}

async function readClientSource(entry: string, pluginRoot: string): Promise<string> {
  if (entry.endsWith(".ts") || entry.endsWith(".tsx")) return bundleClientSource(entry, pluginRoot);
  if (entry.endsWith(".js") || entry.endsWith(".mjs")) return await readFile(entry, "utf8");
  throw new Error("unsupported_client_entry");
}

async function bundleClientSource(entry: string, pluginRoot: string): Promise<string> {
  const { build } = await import("esbuild");
  // 번들 주석에 절대 경로(사용자 홈/계정명)가 새지 않도록 plugin root realpath를 작업 디렉터리로 고정한다.
  // 이렇게 하면 esbuild 모듈 경로 주석이 plugin root 기준 상대경로가 되어 브라우저 페이로드에 raw path가 노출되지 않는다.
  const rootRealpath = realpathSync.native(pluginRoot);
  const output = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    sourcemap: false,
    write: false,
    logLevel: "silent",
    absWorkingDir: rootRealpath,
    plugins: [createShimExternalsPlugin(rootRealpath)],
  });
  const bundled = output.outputFiles[0]?.text;
  if (!bundled) throw new Error("plugin_client_bundle_failed");
  return bundled;
}

function createShimExternalsPlugin(rootRealpath: string): Plugin {
  return {
    name: "fleet-console-plugin-client-shim-externals",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const shimUrl = SHIM_URL_BY_SPECIFIER.get(args.path);
        if (shimUrl) return { path: shimUrl, external: true };
        if (NODE_BUILTINS.has(args.path)) throw new Error(`Node builtin import is not allowed in plugin client: ${args.path}`);
        return null;
      });
      build.onLoad({ filter: /.*/, namespace: "file" }, (args) => {
        const targetRealpath = realpathSync.native(args.path);
        if (isSubpath(rootRealpath, targetRealpath)) return undefined;
        return {
          errors: [{ text: `plugin client import escapes plugin root: ${args.path}` }],
        };
      });
    },
  };
}

function renderShim(definition: ShimDefinition): string {
  // namedExports는 generate 단계에서 이미 필터링·정렬된 상태다.
  return [
    `const ns = globalThis.__fleetConsoleRuntime__?.[${JSON.stringify(definition.globalKey)}];`,
    `if (!ns) throw new Error(${JSON.stringify(`Fleet Console runtime shim unavailable: ${definition.globalKey}`)});`,
    ...definition.namedExports.map((key) => `export const ${key} = ns[${JSON.stringify(key)}];`),
    "export default ns.default;",
    "",
  ].join("\n");
}


import type { RouteHandler, RouteRegistry } from "../route-registry/registry.js";
import type { UpgradeHandler, UpgradeRegistry } from "../route-registry/registry.js";

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
  readonly apiCatalog: readonly ApiCatalogEntry[];
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
  "@fleet-plugins/*",
];

/**
 * 호스트가 소유한 채로 플러그인에게 빌려주는 패키지. 번들에 넣지 않고 호스트가 설치한 실물을
 * 그대로 쓴다.
 *
 * 여기 있는 것들은 번들에 인라인되면 못 쓰게 된다. `node-pty`는 네이티브 애드온이고,
 * `@anthropic-ai/claude-agent-sdk`는 자기 네이티브 CLI 바이너리를 `import.meta.url` 기준
 * 형제 패키지에서 찾는다 — 인라인되면 그 기준점이 번들 파일이 되어 바이너리를 못 찾는다.
 */
const PLUGIN_HOST_PACKAGE_EXTERNALS = [
  "node-pty",
  "ws",
  "@anthropic-ai/claude-agent-sdk",
];

/**
 * 호스트 소유 패키지를 절대 file URL로 고정한 채 external 처리한다.
 *
 * bare 지정자로 두면 안 되는 이유: 번들 결과는 플러그인 캐시 디렉터리에 쓰이고, 그 자리는
 * Console 데이터 루트 아래라 호스트의 `node_modules`로 올라가는 경로가 없을 수 있다. 지금
 * `ws`와 `node-pty`가 개발 환경에서 해석되는 것은 캐시 디렉터리가 우연히 체크아웃 안에 있어
 * 상위 탐색이 루트 `node_modules`에 닿기 때문이고, 데이터 루트를 체크아웃 밖으로 옮기면 같은
 * 방식으로 깨진다. 해석을 번들 시점에 끝내 두면 캐시 디렉터리 위치와 무관해진다.
 *
 * 해석에 실패하면 bare external로 남긴다. 인라인되어 조용히 오작동하는 것보다, import 시점에
 * MODULE_NOT_FOUND로 크게 터지는 쪽이 낫다.
 */
function createHostPackageExternalsPlugin(consoleNodeModules: string | null): Plugin {
  const requireFromConsole = consoleNodeModules
    ? createRequire(path.join(path.dirname(consoleNodeModules), "package.json"))
    : null;
  return {
    name: "fleet-console-plugin-host-package-externals",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!PLUGIN_HOST_PACKAGE_EXTERNALS.includes(args.path)) return null;
        if (!requireFromConsole) return { path: args.path, external: true };
        try {
          return { path: pathToFileURL(requireFromConsole.resolve(args.path)).href, external: true };
        } catch {
          return { path: args.path, external: true };
        }
      });
    },
  };
}
const PLUGIN_BUNDLE_DIR_PREFIX = "fleet-console-plugin-";
const PLUGIN_BUNDLE_OWNER_FILE = ".fleet-console-plugin-owner.json";
const PLUGIN_BUNDLE_PID_PATTERN = /^fleet-console-plugin-(\d+)-/u;
const MAX_PLUGIN_BUNDLE_OWNER_PID = 0x7fff_ffff;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createFleetPluginHost(deps: FleetPluginHostDeps): FleetPluginHost {
  const plugins = filterDiscoveredPlugins(discoverFleetPlugins(deps));
  const sensitiveFieldsByPluginId = new Map(plugins.map((plugin) => [plugin.manifest.id, plugin.manifest.sensitiveFields ?? []]));
  const generatedBundleDirs = new Set<string>();
  const apiCatalog: ApiCatalogEntry[] = [];
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

  return { plugins, sensitiveFieldsByPluginId, apiCatalog, boot, cleanup };

  async function bootPluginRoutes(plugin: DiscoveredFleetPlugin): Promise<void> {
    const pendingRoutes: PendingRouteRegistration[] = [];
    const pendingUpgrades: PendingUpgradeRegistration[] = [];
    const pendingCatalog: ApiCatalogEntry[] = [];
    const mod = await importModule(plugin.routesEntry!);
    const register = resolveRegister(mod);
    if (!register) return;
    const registrationTransaction = createPluginRegistrationTransaction(deps.host);
    try {
      await register({
        pluginId: plugin.manifest.id,
        manifest: plugin.manifest,
        basePath: `/plugins/${plugin.manifest.id}`,
        wsBasePath: `/plugins/${plugin.manifest.id}/ws`,
        host: registrationTransaction.host,
        registerRouter: createScopedRouteRegistrar(
          deps.routes,
          apiCatalog,
          pendingRoutes,
          pendingCatalog,
          `/plugins/${plugin.manifest.id}`,
          `/api/v1/plugins/${plugin.manifest.id}`,
          consoleRoutePrefixOf(plugin.manifest),
        ),
        registerWsHandler: createScopedUpgradeRegistrar(
          deps.upgrades,
          apiCatalog,
          pendingUpgrades,
          pendingCatalog,
          `/plugins/${plugin.manifest.id}/ws`,
        ),
      });
    } catch (error) {
      await registrationTransaction.rollback();
      throw error;
    }
    for (const route of pendingRoutes) deps.routes.register(route.prefix, route.handler);
    for (const upgrade of pendingUpgrades) deps.upgrades.register(upgrade.prefix, upgrade.handler);
    apiCatalog.push(...pendingCatalog);
  }
}

interface PluginRegistrationTransaction {
  readonly host: FleetPluginHostCapabilities;
  rollback(): Promise<void>;
}

function createPluginRegistrationTransaction(host: FleetPluginHostCapabilities): PluginRegistrationTransaction {
  const rollbackActions: Array<() => void | Promise<void>> = [];

  function track(disposer: () => void): () => void {
    let active = true;
    const trackedDisposer = () => {
      if (!active) return;
      active = false;
      disposer();
    };
    rollbackActions.push(trackedDisposer);
    return trackedDisposer;
  }

  function trackCleanup(cleanup: () => void | Promise<void>): () => void {
    const unregister = host.lifecycle.registerCleanup(cleanup);
    let active = true;
    const trackedUnregister = () => {
      if (!active) return;
      active = false;
      unregister();
    };
    rollbackActions.push(async () => {
      if (!active) return;
      active = false;
      try {
        await cleanup();
      } catch {
        // Preserve the original registration failure.
      }
      try {
        unregister();
      } catch {
        // Preserve the original registration failure.
      }
    });
    return trackedUnregister;
  }

  return {
    host: {
      ...host,
      operations: {
        ...host.operations,
        registerOperationType: (type) => track(host.operations.registerOperationType(type)),
        registerPayloadSanitizer: (pluginId, fields) => track(host.operations.registerPayloadSanitizer(pluginId, fields)),
        registerLaunchCatalog: (pluginId, provider) => track(host.operations.registerLaunchCatalog(pluginId, provider)),
      },
      events: {
        ...host.events,
        subscribe: (channel, listener) => track(host.events.subscribe(channel, listener)),
        registerSseChannel: (channel) => track(host.events.registerSseChannel(channel)),
      },
      lifecycle: {
        ...host.lifecycle,
        registerCleanup: trackCleanup,
      },
    },
    rollback: async () => {
      for (let index = rollbackActions.length - 1; index >= 0; index -= 1) {
        try {
          await rollbackActions[index]!();
        } catch {
          // Preserve the original registration failure.
        }
      }
    },
  };
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

// 동적 import된 URL은 Node의 ESM 레지스트리에 영구히 남아 회수되지 않는다. 번들 캐시 디렉터리는 서버마다
// 다르므로 경로로 키를 잡으면 같은 플러그인이 기동마다 새 모듈 그래프로 등록된다 — 내용 해시로 키를 잡아야
// 한 프로세스에서 Console 서버를 반복 기동해도 플러그인 모듈이 누적되지 않는다.
const pluginBundleModules = new Map<string, Promise<FleetPluginRouteModule>>();

function importPluginBundleOnce(digest: string, bundledPath: string): Promise<FleetPluginRouteModule> {
  const cached = pluginBundleModules.get(digest);
  if (cached) return cached;
  const loading = import(pathToFileURL(bundledPath).href) as Promise<FleetPluginRouteModule>;
  pluginBundleModules.set(digest, loading);
  return loading;
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
      plugins: [createHostPackageExternalsPlugin(resolveConsolePackageNodeModules())],
      nodePaths: [resolveConsolePackageNodeModules()].filter((value): value is string => value !== null),
    });
    const bundled = output.outputFiles[0]?.text;
    if (!bundled) throw new Error("plugin_bundle_failed");
    const digest = createHash("sha256").update(bundled).digest("hex").slice(0, 16);
    // 캐시 히트여도 번들 디렉터리는 계속 쓴다 — 소유자 표식과 정리 계약이 그 디렉터리에 걸려 있다.
    const bundledPath = await writeTemporaryPluginBundle(entry, bundled, digest, bundleCacheDir, generatedBundleDirs);
    return await importPluginBundleOnce(digest, bundledPath);
  }
  return await import(pathToFileURL(entry).href) as FleetPluginRouteModule;
}

async function writeTemporaryPluginBundle(entry: string, source: string, digest: string, bundleCacheDir: string | undefined, generatedBundleDirs: Set<string>): Promise<string> {
  const cacheRoot = bundleCacheDir ?? path.join(resolvePluginBundleNodeModules(entry), ".cache");
  await mkdir(cacheRoot, { recursive: true });
  const dir = path.join(cacheRoot, `${PLUGIN_BUNDLE_DIR_PREFIX}${process.pid}-${digest}`);
  await mkdir(dir, { recursive: true });
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

interface PendingRouteRegistration {
  readonly prefix: string;
  readonly handler: RouteHandler;
}

interface PendingUpgradeRegistration {
  readonly prefix: string;
  readonly handler: UpgradeHandler;
}

function createScopedRouteRegistrar(
  routes: RouteRegistry,
  apiCatalog: readonly ApiCatalogEntry[],
  pendingRoutes: PendingRouteRegistration[],
  pendingCatalog: ApiCatalogEntry[],
  basePath: string,
  apiBasePath: string,
  consoleBasePath: string | null,
): FleetPluginServerContext["registerRouter"] {
  function registerRouter(requestedPath: string, handler: RouteHandler): void;
  function registerRouter(requestedPath: string, handler: RouteHandler, catalog: ApiCatalogEntry | readonly ApiCatalogEntry[]): void;
  function registerRouter(
    requestedPath: string,
    handler: RouteHandler,
    catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[],
  ): void {
    const prefix = resolveScopedPrefix(basePath, requestedPath, apiBasePath, consoleBasePath);
    const entries = catalog ? resolveCatalogEntries(prefix, catalog) : [];
    assertNoCatalogDuplicates([...apiCatalog, ...pendingCatalog], entries);
    assertNoRouteOverlap(prefix, [
      ...routes.list().map((route) => route.prefix),
      ...pendingRoutes.map((route) => route.prefix),
    ]);
    pendingRoutes.push({ prefix, handler });
    pendingCatalog.push(...entries);
  }
  return registerRouter;
}

function createScopedUpgradeRegistrar(
  upgrades: UpgradeRegistry,
  apiCatalog: readonly ApiCatalogEntry[],
  pendingUpgrades: PendingUpgradeRegistration[],
  pendingCatalog: ApiCatalogEntry[],
  basePath: string,
): FleetPluginServerContext["registerWsHandler"] {
  function registerWsHandler(requestedPath: string, handler: UpgradeHandler): void;
  function registerWsHandler(requestedPath: string, handler: UpgradeHandler, catalog: ApiCatalogEntry | readonly ApiCatalogEntry[]): void;
  function registerWsHandler(
    requestedPath: string,
    handler: UpgradeHandler,
    catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[],
  ): void {
    const prefix = resolveScopedPrefix(basePath, requestedPath);
    const entries = catalog ? resolveCatalogEntries(prefix, catalog) : [];
    assertNoCatalogDuplicates([...apiCatalog, ...pendingCatalog], entries);
    assertNoRouteOverlap(prefix, [
      ...upgrades.list().map((upgrade) => upgrade.prefix),
      ...pendingUpgrades.map((upgrade) => upgrade.prefix),
    ]);
    pendingUpgrades.push({ prefix, handler });
    pendingCatalog.push(...entries);
  }
  return registerWsHandler;
}

const API_CATALOG_METHODS = new Set<unknown>(["GET", "POST", "PUT", "PATCH", "DELETE", "*"]);
const API_CATALOG_GATES = new Set<unknown>(["loopback", "origin-write", "origin-strict", "lock-token", "anthropic-credential", "one-use-ticket"]);
const API_CATALOG_TRANSPORTS = new Set<unknown>(["http", "sse", "websocket", "proxy"]);

function resolveCatalogEntries(prefix: string, catalog: ApiCatalogEntry | readonly ApiCatalogEntry[]): ApiCatalogEntry[] {
  return (Array.isArray(catalog) ? catalog : [catalog]).map((entry) => {
    assertValidCatalogEntry(entry);
    return {
      ...entry,
      path: resolveCatalogPath(prefix, entry.path),
    };
  });
}

function assertValidCatalogEntry(entry: unknown): asserts entry is ApiCatalogEntry {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("plugin_catalog_entry_invalid");
  const candidate = entry as Record<string, unknown>;
  if (
    !API_CATALOG_METHODS.has(candidate.method)
    || typeof candidate.summary !== "string"
    || candidate.summary.trim().length === 0
    || typeof candidate.category !== "string"
    || candidate.category.trim().length === 0
    || !API_CATALOG_GATES.has(candidate.gate)
    || !API_CATALOG_TRANSPORTS.has(candidate.transport)
    || !isValidCatalogPath(candidate.path)
  ) {
    throw new Error("plugin_catalog_entry_invalid");
  }
}

function isValidCatalogPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === "") return true;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("//") || /[?#\\]/u.test(value)) return false;
  return !value.split("/").some((segment) => segment === "." || segment === "..");
}

function resolveCatalogPath(prefix: string, suffix: string): string {
  if (suffix === "") return prefix;
  return normalizePrefix(`${prefix}${suffix}`);
}

function assertNoCatalogDuplicates(existing: readonly ApiCatalogEntry[], additions: readonly ApiCatalogEntry[]): void {
  const identities = new Set(existing.map(catalogIdentity));
  for (const entry of additions) {
    const identity = catalogIdentity(entry);
    if (identities.has(identity)) throw new Error(`duplicate_api_catalog_entry:${entry.method}:${entry.path}:${entry.transport}`);
    identities.add(identity);
  }
}

function catalogIdentity(entry: ApiCatalogEntry): string {
  return `${entry.method}|${entry.path}|${entry.transport}`;
}

/** `/console/<prefix>` 한 칸을 여는 매니페스트 선언. 경로 조각 하나만 허용한다. */
export function consoleRoutePrefixOf(manifest: { readonly consoleRoutePrefix?: unknown }): string | null {
  const declared = manifest.consoleRoutePrefix;
  if (typeof declared !== "string") return null;
  const trimmed = declared.trim().replace(/^\/+|\/+$/g, "");
  // 한 조각만 — 슬래시를 허용하면 플러그인이 `/console/operations` 같은 코어 화면 아래로
  // 파고들 수 있고, `..`는 접두사 밖으로 나간다.
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(trimmed)) return null;
  return `/console/${trimmed}`;
}

function resolveScopedPrefix(basePath: string, requestedPath: string, apiBasePath?: string, consoleBasePath?: string | null): string {
  if (requestedPath.split("/").some((segment) => segment === "." || segment === "..")) throw new Error("plugin_route_outside_scope");
  const normalizedBase = normalizePrefix(basePath);
  if (!requestedPath.startsWith("/")) return normalizePrefix(`${normalizedBase}/${requestedPath}`);
  const normalizedRequest = normalizePrefix(requestedPath);
  if (normalizedRequest === normalizedBase || normalizedRequest.startsWith(`${normalizedBase}/`)) return normalizedRequest;
  const normalizedApiBase = apiBasePath ? normalizePrefix(apiBasePath) : null;
  if (normalizedApiBase && (normalizedRequest === normalizedApiBase || normalizedRequest.startsWith(`${normalizedApiBase}/`))) return normalizedRequest;
  const normalizedConsoleBase = consoleBasePath ? normalizePrefix(consoleBasePath) : null;
  if (normalizedConsoleBase && (normalizedRequest === normalizedConsoleBase || normalizedRequest.startsWith(`${normalizedConsoleBase}/`))) return normalizedRequest;
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
