import type { AgentConversationProps } from "@fleet-console/sdk/components/agent-chat-transcript";
import { React } from "@fleet-console/sdk/plugin/browser";

import { ChatReferenceContext } from "./chat-reference.js";
import { GroupConversation, type BoardActionRecordRequest, type ConversationLogSnapshot } from "./group/group-conversation.js";
import { ConversationTheaterContext } from "./group/speaker-mark.js";

/**
 * 플러그인 소유 대화를 Operation 대화와 같은 화면으로 — SDK `ctx.chat.Conversation` 의 호스트 구현.
 *
 * 화면 문법(말풍선·발화자 표식·가운데 줄·진행 줄·입력 자리)은 그룹 대화(`GroupConversation`) 하나가 진다. 여기는 플러그인이 준
 * 줄을 스냅숏 모양으로 감싸고, 사령관 표식이 쓸 Theater 를 알려 주기만 한다. 결정 카드·원장·정지는 플러그인 대화에 없다.
 */
export function AgentConversation({ entries, participants, working, language, theaterId, loading = false, empty, older = null, reveal = null, openBoardAction = null, composer, references }: AgentConversationProps) {
  const snapshot = React.useMemo<ConversationLogSnapshot>(() => ({
    rootOperationId: null,
    entries,
    participants,
    working,
    decision: null,
    holds: [],
    preview: null,
    loading,
    truncated: false,
    unavailableOperationIds: [],
  }), [entries, participants, working, loading]);
  const openRecord = React.useMemo(() => {
    if (!openBoardAction) return undefined;
    return (request: BoardActionRecordRequest) => {
      const entry = entries.find((candidate) => candidate.id === request.entryId);
      if (entry?.kind === "board-action") openBoardAction.open(entry);
    };
  }, [entries, openBoardAction]);
  return (
    <ConversationTheaterContext.Provider value={theaterId ?? null}>
      <ChatReferenceContext.Provider value={references ?? null}>
      <GroupConversation
        snapshot={snapshot}
        language={language}
        {...(openRecord ? { onOpenCommodoreRecord: openRecord, boardActionLabel: openBoardAction!.label } : {})}
        {...(empty !== undefined ? { empty } : {})}
        older={older}
        reveal={reveal}
        composer={composer}
      />
      </ChatReferenceContext.Provider>
    </ConversationTheaterContext.Provider>
  );
}
