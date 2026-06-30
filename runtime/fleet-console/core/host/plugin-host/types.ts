import type {
  DiscoveredFleetPlugin as SdkDiscoveredFleetPlugin,
  FleetPluginEventsHost,
  FleetPluginHostCapabilities as SdkFleetPluginHostCapabilities,
  FleetPluginLifecycleHost as SdkFleetPluginLifecycleHost,
  FleetPluginOperationsHost,
  FleetPluginPathsHost,
  FleetPluginSecurityHost,
  FleetPluginStorageHost,
  FleetPluginHttpHost,
} from "@fleet-console/sdk/plugin";

export interface DiscoveredFleetPlugin extends SdkDiscoveredFleetPlugin {
  readonly external: boolean;
}

// server-side lifecycle 확장: SDK 불변 유지, core/host 전용 probe 등록 기제
export interface FleetPluginLifecycleHost extends SdkFleetPluginLifecycleHost {
  registerLivenessProbe(probe: () => boolean): () => void;
}

// server.ts가 registerLivenessProbe를 포함한 lifecycle로 구성할 수 있도록 재선언
export interface FleetPluginHostCapabilities extends Omit<SdkFleetPluginHostCapabilities, "lifecycle"> {
  readonly operations: FleetPluginOperationsHost;
  readonly events: FleetPluginEventsHost;
  readonly paths: FleetPluginPathsHost;
  readonly storage: FleetPluginStorageHost;
  readonly http: FleetPluginHttpHost;
  readonly security: FleetPluginSecurityHost;
  readonly lifecycle: FleetPluginLifecycleHost;
}

export type {
  FleetPluginDefinition,
  FleetPluginEventsHost,
  FleetPluginHttpHost,
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
