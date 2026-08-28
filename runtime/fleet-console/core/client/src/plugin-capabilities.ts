import { createClientCapabilities } from "@fleet-console/sdk/plugin/browser";
import type { PluginInstallContext } from "@fleet-console/sdk/plugin";

import { closeExpandedSurface, getExpandedSurfaceState, openExpandedSurface } from "./expanded-surface/store.js";
import { clearOperationStatusDetail, setOperationStatusDetail } from "./operation-marks.js";
import { clearOperationRuntime, dismissNotificationsForOperation, openQuickLaunch, openQuickLaunchForOperation, raiseOperationNotification, setOperationRuntime, setOperationRuntimeHydration } from "./store.js";

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
    surfaces: {
      open: (request) => openExpandedSurface(request),
      close: (instanceId) => closeExpandedSurface(instanceId),
      isOpen: (surfaceId) => getExpandedSurfaceState().instances.some((i) => i.surfaceId === surfaceId),
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
