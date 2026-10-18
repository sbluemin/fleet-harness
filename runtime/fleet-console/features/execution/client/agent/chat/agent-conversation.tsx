import type { AgentConversationProps } from "@fleet-console/sdk/components/agent-chat-transcript";
import { React } from "@fleet-console/sdk/plugin/browser";

import { ChatReferenceContext } from "./chat-reference.js";
import { GroupConversation, type BoardActionRecordRequest, type ConversationLogSnapshot } from "./group/group-conversation.js";
import { ConversationTheaterContext, LedgerTargetContext, speakerKey, useLocalizedSnapshot, type LedgerTargetRule } from "./group/speaker-mark.js";

/**
 * 플러그인 소유 대화를 Operation 대화와 같은 화면으로 — SDK `ctx.chat.Conversation` 의 호스트 구현.
 *
 * 화면 문법(말풍선·발화자 표식·가운데 줄·진행 줄·입력 자리)은 그룹 대화(`GroupConversation`) 하나가 진다. 여기는 플러그인이 준
 * 줄을 스냅숏 모양으로 감싸 발화자 이름을 화면 언어로 고치고(그룹 대화와 같은 `useLocalizedSnapshot`), 사령관 표식이 쓸 Theater 를 알려 준다. 플러그인의 카드는 그룹 대화와 같은 본문 끝 자리에 선다.
 * 원장은 플러그인이 `openLedger` 를 줄 때만 선다 — 그때 명부의 발화자(Operation 이 없는 사령관도)가 그룹 대화와 같은 입구(말풍선 이름·
 * 진행 줄 표식과 낱말)로 그 원장을 연다. 플러그인 대화는 턴을 접지 않으므로 진행 칩이 없다.
 */
export function AgentConversation({ entries, participants, working, language, theaterId, loading = false, empty, older = null, reveal = null, openBoardAction = null, openLedger = null, cards, composer, composerTopEntries = false, references }: AgentConversationProps) {
  const snapshot = useLocalizedSnapshot(React.useMemo<ConversationLogSnapshot>(() => ({
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
  }), [entries, participants, working, loading]), language);
  const openRecord = React.useMemo(() => {
    if (!openBoardAction) return undefined;
    return (request: BoardActionRecordRequest) => {
      const entry = entries.find((candidate) => candidate.id === request.entryId);
      if (entry?.kind === "board-action") openBoardAction.open(entry);
    };
  }, [entries, openBoardAction]);
  // 플러그인 대화의 발화자에게는 Operation id 가 없을 수 있다 — 명부 안의 발화자를 그 표식 키로 고르고, 누르면 그 발화자를 돌려준다.
  const ledgerRule = React.useCallback<LedgerTargetRule>((speaker, roster) => {
    const key = speakerKey(speaker);
    return roster.some((participant) => speakerKey(participant.speaker) === key) ? key : null;
  }, []);
  const onOpenLedger = React.useMemo(() => {
    if (!openLedger) return undefined;
    return (key: string) => {
      const speaker = snapshot.participants.find((participant) => speakerKey(participant.speaker) === key)?.speaker;
      if (speaker) openLedger(speaker);
    };
  }, [openLedger, snapshot.participants]);
  const conversation = (
    <GroupConversation
      snapshot={snapshot}
      language={language}
      {...(onOpenLedger ? { onOpenLedger } : {})}
      {...(openRecord ? { onOpenCommodoreRecord: openRecord, boardActionLabel: openBoardAction!.label } : {})}
      {...(empty !== undefined ? { empty } : {})}
      older={older}
      reveal={reveal}
      cards={cards}
      composer={composer}
      composerTopEntries={composerTopEntries}
    />
  );
  return (
    <ConversationTheaterContext.Provider value={theaterId ?? null}>
      <ChatReferenceContext.Provider value={references ?? null}>
        {onOpenLedger ? <LedgerTargetContext.Provider value={ledgerRule}>{conversation}</LedgerTargetContext.Provider> : conversation}
      </ChatReferenceContext.Provider>
    </ConversationTheaterContext.Provider>
  );
}
