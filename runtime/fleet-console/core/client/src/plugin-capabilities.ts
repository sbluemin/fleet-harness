import { createClientCapabilities } from "@fleet-console/sdk/plugin/browser";
import type { PluginInstallContext } from "@fleet-console/sdk/plugin";
import type { TerminalFontSettings } from "@fleet-console/sdk/operations";

import { clearOperationStatus, dismissNotificationsForOperation, getState, raiseOperationNotification, setOperationStatus } from "./store.js";

export interface OperationRenderClientState {
  readonly terminalFont: TerminalFontSettings;
}

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

export function getOperationRenderClientState(): OperationRenderClientState {
  const state = getState();
  return {
    terminalFont: state.terminalFont,
  };
}
