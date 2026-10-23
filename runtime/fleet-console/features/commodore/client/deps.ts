import type { ClientAgentChatCapability } from "../../execution/shared/chat-renderer.js";
import type { ClientRailCapability } from "../../workspace/shared/navigation-ports.js";
import type { ClientNavigateCapability } from "../../workspace/shared/navigation.js";
import type { ClientTheaterInboxCapability } from "../../workspace/shared/theater-inbox.js";
import type { ClientApiCapability } from "@fleet-console/infra/http/client-ports";
import type { ClientComposerCapability } from "../../execution/shared/composer-ports.js";
import type { ClientConsoleEventsCapability } from "../../workspace/shared/navigation-ports.js";
import type { ClientConsoleStateCapability } from "../../workspace/shared/console-state.js";
import type { ClientConversationCapability } from "../../workspace/shared/conversation-surfaces.js";
import type { ClientExperimentsCapability } from "../../settings/shared/client-ports.js";
import type { ClientModelsCapability } from "../../ai-gateway/shared/model-ports.js";
import type { ClientOperationsCapability } from "../../execution/shared/client-contract.js";
export interface CommodoreClientDeps {
  readonly chat: ClientAgentChatCapability;
  readonly rail: ClientRailCapability;
  readonly api: ClientApiCapability;
  readonly consoleEvents: ClientConsoleEventsCapability;
  readonly consoleState: ClientConsoleStateCapability;
  readonly experiments: ClientExperimentsCapability;
  readonly models: ClientModelsCapability;
  readonly composer: ClientComposerCapability;
  readonly conversation?: ClientConversationCapability;
  readonly theaterInbox?: ClientTheaterInboxCapability;
  readonly operations: ClientOperationsCapability;
  readonly navigate: ClientNavigateCapability;
}
