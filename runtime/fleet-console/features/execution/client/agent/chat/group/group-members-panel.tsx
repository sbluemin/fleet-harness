import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import type { ConversationParticipant, ConversationSpeaker, GroupTimelineSnapshot } from "./conversation-types.js";
import { activityKey } from "./group-conversation.js";
import { getGroupT } from "./group-chat-i18n.js";
import { SpeakerMark, SpeakerName, speakerKey } from "./speaker-mark.js";
import "./group-chat.css";

/**
 * 오른쪽 「구성원」 탭 본문 — 그룹 대화의 참여자 목록, 활동 상태, 원장 보기.
 *
 * 「원장 보기」는 가운데 칸에 그 참여자의 원장(기존 본문)을 읽기 전용으로 세운다 — 셸의 구성원 본문 선택과 같은 문이다.
 * 보고 있는 참여자에서 다시 누르면 대화로 돌아간다. 정지·제거·추가는 콜백 자리만 둔다 — 쓰기 연결(임무 16) 전에는 단추가 서지 않는다.
 * 제거는 지휘관에게 서지 않는다. 지휘관을 빼면 목표가 서지 않는다.
 */
export interface GroupMembersPanelProps {
  readonly snapshot: GroupTimelineSnapshot;
  readonly language: ConsoleLocale | undefined;
  /** 가운데 칸이 지금 원장을 보이는 참여자(셸의 구성원 본문 선택). 대화를 보고 있으면 null. */
  readonly ledgerOperationId: string | null;
  /** 원장을 열거나(id) 대화로 돌아간다(null). */
  readonly onOpenLedger?: (operationId: string | null) => void;
  readonly onStop?: (speaker: ConversationSpeaker) => void;
  readonly onRemove?: (speaker: ConversationSpeaker) => void;
  readonly onAdd?: () => void;
}

export function GroupMembersPanel({ snapshot, language, ledgerOperationId: focus, onOpenLedger, onStop, onRemove, onAdd }: GroupMembersPanelProps) {
  const t = getGroupT(language);
  const participants = snapshot.participants;
  return (
    <div className="group-members">
      <h3 className="group-members-heading">{t("group.members.heading", { count: participants.length })}</h3>
      <ul className="group-members-list">
        {participants.map((participant) => (
          <MemberRow
            key={speakerKey(participant.speaker)}
            participant={participant}
            language={language}
            showing={focus !== null && focus === participant.speaker.operationId}
            onLedger={onOpenLedger && participant.speaker.operationId && participant.speaker.kind !== "human"
              ? () => onOpenLedger(focus === participant.speaker.operationId ? null : participant.speaker.operationId!)
              : undefined}
            onStop={onStop && (participant.activity === "running" || participant.activity === "background") ? () => onStop(participant.speaker) : undefined}
            onRemove={onRemove && participant.speaker.kind === "member" ? () => onRemove(participant.speaker) : undefined}
          />
        ))}
      </ul>
      {onAdd ? <button type="button" className="group-members-add" onClick={onAdd}>＋ {t("group.members.add")}</button> : null}
    </div>
  );
}

function MemberRow({ participant, language, showing, onLedger, onStop, onRemove }: {
  readonly participant: ConversationParticipant;
  readonly language: ConsoleLocale | undefined;
  readonly showing: boolean;
  readonly onLedger: (() => void) | undefined;
  readonly onStop: (() => void) | undefined;
  readonly onRemove: (() => void) | undefined;
}) {
  const t = getGroupT(language);
  const { speaker, activity } = participant;
  const role = speaker.kind === "commander" ? t("group.commander")
    : speaker.kind === "member" ? t("group.member")
      : speaker.kind === "commodore" ? t("group.commodore")
        : speaker.kind === "human" ? t("group.you") : t("group.operation");
  return (
    <li className={`group-members-row${showing ? " is-showing" : ""}`}>
      <SpeakerMark speaker={speaker} />
      <span className="group-members-text">
        <SpeakerName speaker={speaker} className="group-members-name" />
        <span className="group-members-role">{role}</span>
        {onLedger || onStop || onRemove ? (
          <span className="group-members-actions">
            {onLedger ? <button type="button" className="group-chat-link" aria-pressed={showing} onClick={onLedger}>{showing ? t("group.ledger.back") : t("group.members.ledger")}</button> : null}
            {onStop ? <button type="button" className="group-chat-link" onClick={onStop}>{t("group.members.stop")}</button> : null}
            {onRemove ? <button type="button" className="group-chat-link is-danger" onClick={onRemove}>{t("group.members.remove")}</button> : null}
          </span>
        ) : null}
      </span>
      <span className="group-members-state">
        <span className={`group-members-dot is-${activity}`} aria-hidden="true" />
        {t(activityKey(activity))}
      </span>
    </li>
  );
}
