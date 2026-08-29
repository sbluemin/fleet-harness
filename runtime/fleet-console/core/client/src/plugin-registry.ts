import { createContext, useContext, useMemo } from "react";
import type { ExpandedSurfaceDescriptor } from "@fleet-console/sdk/expanded-surface";
import type { FloatingWidgetDescriptor } from "@fleet-console/sdk/floating";
import type { NotificationKindDescriptor } from "@fleet-console/sdk/notifications";
import type { OperationKindDescriptor, FleetClientPlugin, PersistentComponentDescriptor } from "@fleet-console/sdk/plugin";
import type { RailPanelDescriptor } from "@fleet-console/sdk/rail";
import type { SettingsSectionDescriptor } from "@fleet-console/sdk/settings";
import { plugins as builtInPlugins } from "virtual:fleet-plugins";

/** 발견됐지만 패널을 세우지 못한 플러그인. 화면이 "왜 없는지"를 말할 수 있게 남긴다. */
export interface PluginLoadFailure {
  readonly id: string;
  readonly name?: string;
  readonly reason: "unsupported_client_entry" | "client_build_failed" | "duplicate_id" | "invalid_client_module" | "client_load_failed";
}

export interface PluginRegistry {
  readonly plugins: readonly FleetClientPlugin[];
  /** 이 부팅에서 빠진 플러그인. 비어 있으면 전부 올라왔다는 뜻이다. */
  readonly failures: readonly PluginLoadFailure[];
  readonly operationKinds: readonly OperationKindDescriptor[];
  readonly settingsSections: readonly SettingsSectionDescriptor[];
  readonly notificationKinds: readonly NotificationKindDescriptor[];
  readonly railPanels: readonly RailPanelDescriptor[];
  readonly persistentComponents: readonly PersistentComponentDescriptor[];
  readonly floatingWidgets: readonly FloatingWidgetDescriptor[];
  readonly expandedSurfaces: readonly ExpandedSurfaceDescriptor[];
}

interface PluginRuntimeManifest {
  readonly plugins?: readonly PluginRuntimeManifestEntry[];
  readonly skipped?: readonly PluginLoadFailure[];
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
  const { entries, skipped } = await loadPluginRuntimeManifest();
  const failures: PluginLoadFailure[] = [...skipped];
  for (const entry of entries) {
    if (pluginIds.has(entry.id)) {
      console.warn(`Skipping external plugin with duplicate id: ${entry.id}`);
      failures.push({ id: entry.id, ...(entry.name ? { name: entry.name } : {}), reason: "duplicate_id" });
      continue;
    }
    const outcome = await loadExternalPlugin(entry);
    if (!outcome.plugin) {
      failures.push({ id: entry.id, ...(entry.name ? { name: entry.name } : {}), reason: outcome.reason });
      continue;
    }
    if (pluginIds.has(outcome.plugin.id)) {
      console.warn(`Skipping external plugin with duplicate id: ${outcome.plugin.id}`);
      failures.push({ id: outcome.plugin.id, reason: "duplicate_id" });
      continue;
    }
    pluginIds.add(outcome.plugin.id);
    plugins.push(outcome.plugin);
  }
  return createPluginRegistry(plugins, failures);
}

export function usePluginRegistry(): PluginRegistry {
  return useContext(PluginRegistryContext);
}

async function loadPluginRuntimeManifest(): Promise<{ entries: readonly PluginRuntimeManifestEntry[]; skipped: readonly PluginLoadFailure[] }> {
  try {
    const response = await fetch("/plugin-runtime/manifest");
    if (!response.ok) {
      console.warn(`Plugin runtime manifest unavailable: ${response.status}`);
      return { entries: [], skipped: [] };
    }
    const payload = await response.json() as PluginRuntimeManifest;
    // 서버가 준비 단계에서 떨군 플러그인은 목록에 아예 없다 — 그 사실은 skipped로만 온다.
    const skipped = Array.isArray(payload.skipped) ? payload.skipped : [];
    if (!Array.isArray(payload.plugins)) return { entries: [], skipped };
    return { entries: payload.plugins.filter(isPluginRuntimeManifestEntry), skipped };
  } catch (error) {
    console.warn("Plugin runtime manifest failed to load.", error);
    return { entries: [], skipped: [] };
  }
}

async function loadExternalPlugin(entry: PluginRuntimeManifestEntry): Promise<{ plugin: FleetClientPlugin | null; reason: PluginLoadFailure["reason"] }> {
  try {
    const mod = await import(/* @vite-ignore */ entry.clientUrl) as PluginClientModule;
    const plugin = mod.default ?? mod.plugin;
    if (!isFleetClientPlugin(plugin)) {
      console.warn(`Skipping external plugin with invalid client module: ${entry.id}`);
      return { plugin: null, reason: "invalid_client_module" };
    }
    return { plugin, reason: "client_load_failed" };
  } catch (error) {
    console.warn(`Skipping external plugin after client load failure: ${entry.id}`, error);
    return { plugin: null, reason: "client_load_failed" };
  }
}

function createPluginRegistry(plugins: readonly FleetClientPlugin[], failures: readonly PluginLoadFailure[] = []): PluginRegistry {
  const railPanelIds = new Set<string>();
  const railPanels: RailPanelDescriptor[] = [];
  // 표면 id는 슬롯 저장소가 쓰는 주소다. rail 패널과 같은 규칙으로 접두 없이 두고
  // 선착순 중복 제거한다 — 접두를 붙이면 플러그인이 자기 지역 id로 부르는 open/close가
  // 승격된 id와 어긋나고, 능력이 플러그인별로 만들어지지 않는 한 그 간극을 메울 수 없다.
  // 대신 계약이 "콘솔 전체에서 유일"을 요구하고, 어긴 기여는 아래 경고로 드러난다.
  const expandedSurfaceIds = new Set<string>();
  const expandedSurfaces: ExpandedSurfaceDescriptor[] = [];
  for (const plugin of plugins) {
    for (const surface of plugin.expandedSurfaces ?? []) {
      if (expandedSurfaceIds.has(surface.id)) {
        console.warn(`Skipping expanded surface with duplicate id: ${surface.id}`);
        continue;
      }
      expandedSurfaceIds.add(surface.id);
      expandedSurfaces.push(surface);
    }
  }
  for (const plugin of plugins) {
    for (const panel of plugin.railPanels ?? []) {
      if (railPanelIds.has(panel.id)) {
        console.warn(`Skipping rail panel with duplicate id: ${panel.id}`);
        continue;
      }
      railPanelIds.add(panel.id);
      railPanels.push(panel);
    }
  }
  return {
    plugins,
    failures,
    persistentComponents: plugins.flatMap((plugin) => plugin.persistentComponents ?? []),
    operationKinds: plugins.flatMap((plugin) => plugin.operationKinds ?? []),
    settingsSections: plugins.flatMap((plugin) => plugin.settingsSections ?? []),
    notificationKinds: plugins.flatMap((plugin) => plugin.notificationKinds ?? []),
    railPanels,
    floatingWidgets: plugins.flatMap((plugin) => (plugin.floatingWidgets ?? []).map((descriptor) => ({
      ...descriptor,
      id: `${plugin.id}:${descriptor.id}`,
    }))),
    expandedSurfaces,
  };
}

/** 표면 id → 서술자. 레이어가 슬롯마다 조회하므로 배열이 아니라 맵으로 준다. */
export function useExpandedSurfaceDescriptors(): ReadonlyMap<string, ExpandedSurfaceDescriptor> {
  const { expandedSurfaces } = usePluginRegistry();
  return useMemo(
    () => new Map(expandedSurfaces.map((descriptor) => [descriptor.id, descriptor])),
    [expandedSurfaces],
  );
}

function isFleetClientPlugin(value: unknown): value is FleetClientPlugin {
  return typeof value === "object" && value !== null && typeof (value as { readonly id?: unknown }).id === "string";
}

function isPluginRuntimeManifestEntry(value: unknown): value is PluginRuntimeManifestEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { readonly id?: unknown; readonly clientUrl?: unknown; readonly apiVersion?: unknown };
  return typeof entry.id === "string" && typeof entry.clientUrl === "string" && Number.isInteger(entry.apiVersion);
}
