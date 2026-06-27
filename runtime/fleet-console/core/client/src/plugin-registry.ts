import { createContext, useContext } from "react";
import type { NotificationKindDescriptor } from "@fleet-console/sdk/notifications";
import type { OperationKindDescriptor, FleetClientPlugin } from "@fleet-console/sdk/plugin";
import type { SettingsSectionDescriptor } from "@fleet-console/sdk/settings";
import { plugins as builtInPlugins } from "virtual:fleet-plugins";

export interface PluginRegistry {
  readonly plugins: readonly FleetClientPlugin[];
  readonly operationKinds: readonly OperationKindDescriptor[];
  readonly settingsSections: readonly SettingsSectionDescriptor[];
  readonly notificationKinds: readonly NotificationKindDescriptor[];
}

interface PluginRuntimeManifest {
  readonly plugins?: readonly PluginRuntimeManifestEntry[];
}

interface PluginRuntimeManifestEntry {
  readonly id: string;
  readonly name?: string;
  readonly clientUrl: string;
  readonly apiVersion: number;
}

type PluginClientModule = {
  readonly default?: unknown;
  readonly plugin?: unknown;
};

const EMPTY_PLUGIN_REGISTRY: PluginRegistry = createPluginRegistry(builtInPlugins);

const PluginRegistryContext = createContext<PluginRegistry>(EMPTY_PLUGIN_REGISTRY);

export const PluginRegistryProvider = PluginRegistryContext.Provider;

export async function loadPluginRegistry(): Promise<PluginRegistry> {
  const plugins = [...builtInPlugins];
  const pluginIds = new Set(plugins.map((plugin) => plugin.id));
  const entries = await loadPluginRuntimeManifestEntries();
  for (const entry of entries) {
    if (pluginIds.has(entry.id)) {
      console.warn(`Skipping external plugin with duplicate id: ${entry.id}`);
      continue;
    }
    const plugin = await loadExternalPlugin(entry);
    if (!plugin) continue;
    if (pluginIds.has(plugin.id)) {
      console.warn(`Skipping external plugin with duplicate id: ${plugin.id}`);
      continue;
    }
    pluginIds.add(plugin.id);
    plugins.push(plugin);
  }
  return createPluginRegistry(plugins);
}

export function usePluginRegistry(): PluginRegistry {
  return useContext(PluginRegistryContext);
}

async function loadPluginRuntimeManifestEntries(): Promise<readonly PluginRuntimeManifestEntry[]> {
  try {
    const response = await fetch("/plugin-runtime/manifest");
    if (!response.ok) {
      console.warn(`Plugin runtime manifest unavailable: ${response.status}`);
      return [];
    }
    const payload = await response.json() as PluginRuntimeManifest;
    if (!Array.isArray(payload.plugins)) return [];
    return payload.plugins.filter(isPluginRuntimeManifestEntry);
  } catch (error) {
    console.warn("Plugin runtime manifest failed to load.", error);
    return [];
  }
}

async function loadExternalPlugin(entry: PluginRuntimeManifestEntry): Promise<FleetClientPlugin | null> {
  try {
    const mod = await import(/* @vite-ignore */ entry.clientUrl) as PluginClientModule;
    const plugin = mod.default ?? mod.plugin;
    if (!isFleetClientPlugin(plugin)) {
      console.warn(`Skipping external plugin with invalid client module: ${entry.id}`);
      return null;
    }
    return plugin;
  } catch (error) {
    console.warn(`Skipping external plugin after client load failure: ${entry.id}`, error);
    return null;
  }
}

function createPluginRegistry(plugins: readonly FleetClientPlugin[]): PluginRegistry {
  return {
    plugins,
    operationKinds: plugins.flatMap((plugin) => plugin.operationKinds ?? []),
    settingsSections: plugins.flatMap((plugin) => plugin.settingsSections ?? []),
    notificationKinds: plugins.flatMap((plugin) => plugin.notificationKinds ?? []),
  };
}

function isFleetClientPlugin(value: unknown): value is FleetClientPlugin {
  return typeof value === "object" && value !== null && typeof (value as { readonly id?: unknown }).id === "string";
}

function isPluginRuntimeManifestEntry(value: unknown): value is PluginRuntimeManifestEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { readonly id?: unknown; readonly clientUrl?: unknown; readonly apiVersion?: unknown };
  return typeof entry.id === "string" && typeof entry.clientUrl === "string" && Number.isInteger(entry.apiVersion);
}
