import type { ClientApiCapability } from "@fleet-console/infra/http/client-ports";
import type { ClientConsoleEventsCapability } from "../../workspace/shared/navigation-ports.js";
import type { ClientConsoleStateCapability } from "../../workspace/shared/console-state.js";
import type { ClientConversationCapability } from "../../workspace/shared/conversation-surfaces.js";
import type { ClientExperimentsCapability } from "../../settings/shared/client-ports.js";
import type { ClientNotificationsCapability } from "../shared/notification-ports.js";
import type { ClientOperationRuntimeCapability, ClientOperationStatusDetailCapability, ClientOperationsCapability } from "../shared/client-contract.js";
export interface ExecutionClientDeps {
  readonly api: ClientApiCapability;
  readonly notifications: ClientNotificationsCapability;
  readonly consoleState: ClientConsoleStateCapability;
  readonly runtime: ClientOperationRuntimeCapability;
  readonly statusDetail: ClientOperationStatusDetailCapability;
  readonly experiments: ClientExperimentsCapability;
  readonly conversation?: ClientConversationCapability;
  readonly consoleEvents: ClientConsoleEventsCapability;
  readonly operations: ClientOperationsCapability;
}
