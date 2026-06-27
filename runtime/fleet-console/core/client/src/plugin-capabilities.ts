import { createClientCapabilities } from "@fleet-console/sdk/plugin/browser";
import type { PluginInstallContext } from "@fleet-console/sdk/plugin";

import { clearOperationStatus, dismissNotificationsForOperation, raiseOperationNotification, setOperationStatus } from "./store.js";

export function createHostCapabilities(resync: () => void = () => undefined): PluginInstallContext {
  const base = createClientCapabilities(resync);
  return {
    ...base,
    notifications: {
      emit: (notification) => raiseOperationNotification(notification),
      dismiss: (operationId) => dismissNotificationsForOperation(operationId),
    },
    status: {
      set: (operationId, status) => setOperationStatus(operationId, status),
      clear: (operationId) => clearOperationStatus(operationId),
    },
  };
}
