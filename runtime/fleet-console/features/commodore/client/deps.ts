import type { ComponentType } from "react";
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
import type { ClientObjectiveRecordsCapability } from "../../execution/shared/client-contract.js";
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
  readonly objectiveRecords: ClientObjectiveRecordsCapability;
  readonly navigate: ClientNavigateCapability;
  /**
   * 폰 사령관 화면 「지휘관 세션」 탭의 본문 — 그 사령관이 소유한 지휘관 세션 목록. 세션 행·확인 필요·시작 전·완료의 문법은 호스트의 폰 홈이 가진 것이라
   * 호스트가 그려 넘긴다. 없으면 탭은 서지 않는다.
   */
  readonly mobileSessions?: ComponentType<{ readonly commodoreId: string }>;
}
