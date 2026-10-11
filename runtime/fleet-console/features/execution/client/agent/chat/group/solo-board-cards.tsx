import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import { useGroupConversationActions } from "../group-write.js";
import { useGroupTimeline } from "../group-timeline-store.js";
import { DecisionCard, SettledDecisionLine, type SettledDecision } from "./group-cards.js";
import { useLocalizedSnapshot } from "./speaker-mark.js";
import "./group-chat.css";

/**
 * 1:1 대화(구성원 없는 지휘관·일반 채팅)의 보드 카드 — 대화 중심 화면에서 기존 채팅 본문 안에 선다.
 *
 * 그룹 대화와 같은 결정 요청 카드·답한 결정 줄을 쓴다. 결정은 이 Operation 을 지휘관으로 둔 목표 묶음이 줄 때만 있고,
 * 일반 채팅에는 묶음이 없으므로 아무것도 서지 않는다. 허용 요청 카드는 채팅 본문이 이미 같은 계약으로 그린다.
 */
export function SoloBoardCards({ operationId, language }: { readonly operationId: string; readonly language: ConsoleLocale | undefined }) {
  const snapshot = useLocalizedSnapshot(useGroupTimeline(operationId), language);
  const actions = useGroupConversationActions(operationId);
  const [settled, setSettled] = React.useState<readonly SettledDecision[]>([]);
  React.useEffect(() => setSettled([]), [operationId]);
  const commander = snapshot.participants.find((participant) => participant.speaker.kind === "commander")?.speaker ?? null;
  const decision = snapshot.decision && !settled.some((entry) => entry.id === snapshot.decision!.id) ? snapshot.decision : null;
  if (!decision && settled.length === 0) return null;
  return (
    <div className="group-solo-cards">
      {settled.map((entry) => <SettledDecisionLine key={entry.id} settled={entry} language={language} />)}
      {decision ? (
        <DecisionCard
          decision={decision}
          actions={actions}
          asker={commander}
          language={language}
          onSettled={(entry) => setSettled((current) => [...current.filter((item) => item.id !== entry.id), entry])}
        />
      ) : null}
    </div>
  );
}
