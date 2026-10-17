import type { AgentDecisionCardProps } from "@fleet-console/sdk/components/agent-chat-transcript";

import { DecisionCard } from "./group/group-cards.js";
import { ConversationTheaterContext } from "./group/speaker-mark.js";
import "./group/group-chat.css";

/**
 * 플러그인이 사람에게 묻는 결정 카드 — SDK `ctx.chat.DecisionCard` 의 호스트 구현.
 *
 * 그룹 대화의 결정 카드(`DecisionCard`) 그대로다. 플러그인 표면에는 그룹 대화 동작이 없으므로 보내는 길은 계약의
 * `decision.answer` 하나이고, 사령관 표식이 쓸 Theater 만 알려 준다. 카드 문법·문구·스타일은 그룹 대화와 한 곳에서 진다.
 */
export function AgentDecisionCard({ decision, asker, language, theaterId, mobile = false, onAnswered }: AgentDecisionCardProps) {
  return (
    <ConversationTheaterContext.Provider value={theaterId ?? null}>
      <DecisionCard decision={decision} actions={null} asker={asker} language={language} phone={mobile} onAnswered={onAnswered} />
    </ConversationTheaterContext.Provider>
  );
}
