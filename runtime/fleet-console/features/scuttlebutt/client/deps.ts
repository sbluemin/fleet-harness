import type { ClientConsoleStateCapability } from "../../workspace/shared/console-state.js";
import type { ClientExperimentsCapability, ClientSettingsCapability } from "../../settings/shared/client-ports.js";
import type { ClientModelsCapability } from "../../ai-gateway/shared/model-ports.js";
export interface ScuttlebuttClientDeps {
  readonly consoleState: ClientConsoleStateCapability;
  readonly experiments: ClientExperimentsCapability;
  readonly models: ClientModelsCapability;
  readonly settings: ClientSettingsCapability;
}
