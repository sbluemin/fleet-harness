import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";

import { SDK_API_VERSION } from "@fleet-console/sdk/version";
import type { Plugin } from "esbuild";

import type { DiscoveredFleetPlugin } from "./types.js";
import { SHIM_NAMED_EXPORTS } from "./shim-keys.generated.js";

export interface PluginClientAssetsDeps {
  readonly plugins: readonly DiscoveredFleetPlugin[];
}

export interface PluginClientManifestDto {
  readonly plugins: readonly PluginClientManifestEntryDto[];
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

  async function prepare(): Promise<void> {
    clientSources.clear();
    preparedPlugins.clear();
    for (const plugin of deps.plugins) {
      if (!plugin.external || !plugin.clientEntry) continue;
      try {
        const source = await readClientSource(plugin.clientEntry, plugin.root);
        clientSources.set(plugin.manifest.id, source);
        preparedPlugins.add(plugin.manifest.id);
      } catch (error) {
        console.warn(`[fleet-console] Plugin ${plugin.manifest.id} client skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  function manifest(): PluginClientManifestDto {
    return {
      plugins: deps.plugins.filter((plugin) => plugin.external && !!plugin.clientEntry && preparedPlugins.has(plugin.manifest.id)).map((plugin) => ({
        id: plugin.manifest.id,
        ...(plugin.manifest.name ? { name: plugin.manifest.name } : {}),
        clientUrl: `/plugin-runtime/client/${plugin.manifest.id}.mjs`,
        apiVersion: plugin.manifest.apiVersion ?? SDK_API_VERSION,
      })),
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

function isSubpath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
