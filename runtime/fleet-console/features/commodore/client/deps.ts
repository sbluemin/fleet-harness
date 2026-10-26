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
/** 「지휘관 세션」 탭 본문의 입력. `leave`는 다른 화면으로 옮기는 동작을 받아, 사령관 화면이 세부를 접고 그 history 항목이 걷힌 뒤에 부른다. */
export interface CommodoreMobileSessionsProps {
  readonly commodoreId: string;
  readonly leave: (run: () => void) => void;
}
/**
 * 「지휘관 세션」 탭 — 본문과 그 본문 머리의 「확인 필요 N」 수. 세부 첫 화면의 행이 같은 수를 보이도록 한 원천(호스트의 확인 필요 요약)에서 함께 온다.
 * `useAttentionCount`는 React 훅이다 — 렌더 중에 늘 부른다.
 */
export interface CommodoreMobileSessions {
  readonly List: ComponentType<CommodoreMobileSessionsProps>;
  readonly useAttentionCount: (commodoreId: string) => number;
}
/** 폰 사령관 세부의 동작 중 호스트 폰 셸이 가진 것 — 시트와 새 세션 화면은 호스트 소유라 호스트가 열어 준다. */
export interface CommodoreMobileActions {
  readonly delete: (commodoreId: string) => void;
  /** 「이름·모양 바꾸기」 시트를 연다(홈 행 길게 누르기와 같은 시트). `label`은 지금 보이는 이름, `alias`는 저장된 별칭(없으면 빈 문자열). */
  readonly editLook: (input: { readonly commodoreId: string; readonly label: string; readonly alias: string }) => void;
  /** 이 사령관이 주인인 새 세션을 연다. 새 세션은 홈 자리에 서므로 부르는 쪽이 세부를 먼저 접는다. */
  readonly newSession: (commodoreId: string) => void;
}
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
  readonly mobileSessions?: CommodoreMobileSessions;
  /** 폰 사령관 세부의 「편집」·⋮ 「새 세션」. 없으면 그 동작이 서지 않는다. */
  readonly mobileActions?: CommodoreMobileActions;
}
