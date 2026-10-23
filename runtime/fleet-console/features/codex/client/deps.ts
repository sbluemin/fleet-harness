import type { ClientComposerCapability } from "../../execution/shared/composer-ports.js";
import type { ClientConsoleEventsCapability, ClientExpandedSurfacesCapability, ClientNavigationCapability, ClientRailCapability } from "../../workspace/shared/navigation-ports.js";
import type { ClientConsoleStateCapability } from "../../workspace/shared/console-state.js";
import type { ClientOperationsCapability } from "../../execution/shared/client-contract.js";
export interface CodexClientDeps {
  readonly consoleState: ClientConsoleStateCapability;
  readonly navigation: ClientNavigationCapability;
  readonly surfaces: ClientExpandedSurfacesCapability;
  readonly rail: ClientRailCapability;
  readonly composer: ClientComposerCapability;
  readonly operations: ClientOperationsCapability;
  readonly consoleEvents: ClientConsoleEventsCapability;
}
