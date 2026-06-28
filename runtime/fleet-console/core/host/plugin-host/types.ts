import type { DiscoveredFleetPlugin as SdkDiscoveredFleetPlugin } from "@fleet-console/sdk/plugin";

export interface DiscoveredFleetPlugin extends SdkDiscoveredFleetPlugin {
  readonly external: boolean;
}

export type {
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
} from "@fleet-console/sdk/plugin";
