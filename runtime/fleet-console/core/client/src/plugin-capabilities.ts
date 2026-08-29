import { createClientCapabilities } from "@fleet-console/sdk/plugin/browser";
import type { PluginInstallContext } from "@fleet-console/sdk/plugin";

import { applySearchParams, subscribeConsoleLocation } from "./console-location.js";
import { closeExpandedSurface, closeExpandedSurfacesOf, getExpandedSurfaceState, openExpandedSurface } from "./expanded-surface/store.js";
import { clearOperationStatusDetail, setOperationStatusDetail } from "./operation-marks.js";
import { subscribeConsoleChannel } from "./operations-sse.js";
import { openRailPanel } from "./rail/rail-store.js";
import { clearOperationRuntime, dismissNotificationsForOperation, getState, openQuickLaunch, openQuickLaunchForOperation, raiseOperationNotification, setActiveTheater, setOperationRuntime, setOperationRuntimeHydration, subscribe } from "./store.js";

export function createHostCapabilities(resync: () => void = () => undefined): PluginInstallContext {
  const base = createClientCapabilities(resync);
  return {
    ...base,
    notifications: {
      emit: (notification) => raiseOperationNotification(notification),
      dismiss: (operationId) => dismissNotificationsForOperation(operationId),
    },
    runtime: {
      set: (operationId, runtimeState) => setOperationRuntime(operationId, runtimeState),
      clear: (operationId) => clearOperationRuntime(operationId),
      setHydration: (hydration, error) => setOperationRuntimeHydration(hydration, error),
    },
    statusDetail: {
      set: (operationId, detail) => setOperationStatusDetail(operationId, detail),
      clear: (operationId) => clearOperationStatusDetail(operationId),
    },
    consoleState: {
      getTheaters: () => getState().theaters.map((theater) => ({ id: theater.id, label: theater.label })),
      getActiveTheaterId: () => getState().activeTheaterId,
      setActiveTheater: (theaterId) => setActiveTheater(theaterId),
      subscribe: (listener) => subscribe(listener),
    },
    navigation: {
      getSearchParam: (key) => new URLSearchParams(window.location.search).get(key),
      setSearchParams: (next, options) => applySearchParams(next, options?.replace === true),
      // popstate만으로는 앱 내부 navigate를 못 듣는다 — 코어가 자기 이동도 알린다.
      subscribe: (listener) => subscribeConsoleLocation(listener),
    },
    surfaces: {
      open: (request) => openExpandedSurface(request),
      close: (instanceId) => closeExpandedSurface(instanceId),
      closeSurface: (surfaceId) => closeExpandedSurfacesOf(surfaceId),
      isOpen: (surfaceId) => getExpandedSurfaceState().instances.some((i) => i.surfaceId === surfaceId),
    },
    rail: {
      open: (panelId) => openRailPanel(panelId),
    },
    consoleEvents: {
      subscribe: (channel, onEvent) => subscribeConsoleChannel(channel, onEvent),
    },
    composer: {
      open: (options) => {
        const mentionOperationId = options?.mentionOperationId;
        if (mentionOperationId) openQuickLaunchForOperation(mentionOperationId);
        else openQuickLaunch();
      },
    },
  };
}
