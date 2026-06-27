import { builtinModules } from "node:module";
import { readFile } from "node:fs/promises";

import * as reactNs from "react";
import * as reactJsxRuntime from "react/jsx-runtime";
import * as sdkNotificationsBrowser from "@fleet-console/sdk/notifications/browser";
import * as sdkOperationsBrowser from "@fleet-console/sdk/operations/browser";
import * as sdkPluginBrowser from "@fleet-console/sdk/plugin/browser";
import * as sdkReactBrowser from "@fleet-console/sdk/react/browser";
import * as sdkSettingsBrowser from "@fleet-console/sdk/settings/browser";
import { SDK_API_VERSION } from "@fleet-console/sdk/version";
import type { Plugin } from "esbuild";

import type { DiscoveredFleetPlugin } from "./types.js";

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
  readonly namespace: Record<string, unknown>;
}

const SHIM_DEFINITIONS: readonly ShimDefinition[] = [
  { name: "react", specifier: "react", globalKey: "react", namespace: reactNs },
  { name: "react-jsx-runtime", specifier: "react/jsx-runtime", globalKey: "react/jsx-runtime", namespace: reactJsxRuntime },
  { name: "sdk-plugin-browser", specifier: "@fleet-console/sdk/plugin/browser", globalKey: "@fleet-console/sdk/plugin/browser", namespace: sdkPluginBrowser },
  { name: "sdk-settings-browser", specifier: "@fleet-console/sdk/settings/browser", globalKey: "@fleet-console/sdk/settings/browser", namespace: sdkSettingsBrowser },
  { name: "sdk-operations-browser", specifier: "@fleet-console/sdk/operations/browser", globalKey: "@fleet-console/sdk/operations/browser", namespace: sdkOperationsBrowser },
  { name: "sdk-notifications-browser", specifier: "@fleet-console/sdk/notifications/browser", globalKey: "@fleet-console/sdk/notifications/browser", namespace: sdkNotificationsBrowser },
  { name: "sdk-react-browser", specifier: "@fleet-console/sdk/react/browser", globalKey: "@fleet-console/sdk/react/browser", namespace: sdkReactBrowser },
];
const SHIM_URL_BY_SPECIFIER = new Map(SHIM_DEFINITIONS.map((definition) => [definition.specifier, `/plugin-runtime/shim/${definition.name}.mjs`]));
const SHIM_BY_NAME = new Map(SHIM_DEFINITIONS.map((definition) => [definition.name, definition]));
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const JS_IDENTIFIER = /^[A-Za-z_$][0-9A-Za-z_$]*$/u;

export function createPluginClientAssets(deps: PluginClientAssetsDeps): PluginClientAssets {
  const clientSources = new Map<string, string>();
  const preparedPlugins = new Set<string>();

  async function prepare(): Promise<void> {
    clientSources.clear();
    preparedPlugins.clear();
    for (const plugin of deps.plugins) {
      if (!plugin.external || !plugin.clientEntry) continue;
      try {
        const source = await readClientSource(plugin.clientEntry);
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

async function readClientSource(entry: string): Promise<string> {
  if (entry.endsWith(".ts") || entry.endsWith(".tsx")) return bundleClientSource(entry);
  if (entry.endsWith(".js") || entry.endsWith(".mjs")) return await readFile(entry, "utf8");
  throw new Error("unsupported_client_entry");
}

async function bundleClientSource(entry: string): Promise<string> {
  const { build } = await import("esbuild");
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
    plugins: [createShimExternalsPlugin()],
  });
  const bundled = output.outputFiles[0]?.text;
  if (!bundled) throw new Error("plugin_client_bundle_failed");
  return bundled;
}

function createShimExternalsPlugin(): Plugin {
  return {
    name: "fleet-console-plugin-client-shim-externals",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const shimUrl = SHIM_URL_BY_SPECIFIER.get(args.path);
        if (shimUrl) return { path: shimUrl, external: true };
        if (NODE_BUILTINS.has(args.path)) throw new Error(`Node builtin import is not allowed in plugin client: ${args.path}`);
        return null;
      });
    },
  };
}

function renderShim(definition: ShimDefinition): string {
  const namedExports = Object.keys(definition.namespace).filter((key) => key !== "default" && JS_IDENTIFIER.test(key));
  return [
    `const ns = globalThis.__fleetConsoleRuntime__?.[${JSON.stringify(definition.globalKey)}];`,
    `if (!ns) throw new Error(${JSON.stringify(`Fleet Console runtime shim unavailable: ${definition.globalKey}`)});`,
    ...namedExports.map((key) => `export const ${key} = ns[${JSON.stringify(key)}];`),
    "export default ns.default;",
    "",
  ].join("\n");
}
