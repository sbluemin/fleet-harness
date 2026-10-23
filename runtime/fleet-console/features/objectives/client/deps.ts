import type { ClientNavigateCapability } from "../../workspace/shared/navigation.js";
import type { ClientApiCapability } from "@fleet-console/infra/http/client-ports";
import type { ClientComposerCapability } from "../../execution/shared/composer-ports.js";
import type { ClientConsoleEventsCapability, ClientExpandedSurfacesCapability, ClientNavigationCapability, ClientRailCapability } from "../../workspace/shared/navigation-ports.js";
import type { ClientConsoleStateCapability } from "../../workspace/shared/console-state.js";
import type { ClientConversationCapability } from "../../workspace/shared/conversation-surfaces.js";
import type { ClientModelsCapability } from "../../ai-gateway/shared/model-ports.js";
import type { ClientNotificationsCapability } from "../../execution/shared/notification-ports.js";
import type { ClientOperationRuntimeCapability, ClientOperationsCapability } from "../../execution/shared/client-contract.js";
import type { ClientPreferencesCapability } from "../../settings/shared/client-ports.js";
export interface ObjectivesClientDeps {
  readonly api: ClientApiCapability;
  readonly consoleEvents: ClientConsoleEventsCapability;
  readonly consoleState: ClientConsoleStateCapability;
  readonly operations: ClientOperationsCapability;
  readonly preferences: ClientPreferencesCapability;
  readonly runtime: ClientOperationRuntimeCapability;
  readonly rail: ClientRailCapability;
  readonly conversation?: ClientConversationCapability;
  readonly models: ClientModelsCapability;
  readonly navigate: ClientNavigateCapability;
  readonly navigation: ClientNavigationCapability;
  readonly composer: ClientComposerCapability;
  readonly surfaces: ClientExpandedSurfacesCapability;
  readonly notifications: ClientNotificationsCapability;
}
