import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import { mongleStateOf, operationAvatarKey, theaterAvatarKey } from "@fleet-console/sdk/avatars";
import type { ConversationParticipant, ConversationSpeaker, GroupTimelineSnapshot } from "@fleet-console/sdk/conversation";
import { activityKey, memberActivityVisual } from "./group-conversation.js";
import { getGroupT } from "./group-chat-i18n.js";
import { SpeakerMark, SpeakerName, speakerKey } from "./speaker-mark.js";
import { AvatarEditor, operationMongleState } from "../../../../../workspace/client/avatars.js";
import { useClusterIndex } from "../../../../../workspace/client/operation-clusters.js";
import { useConsoleState } from "../../../../../../core/client/src/hooks/use-store.js";
import { useConversationSubject } from "../../../../../workspace/client/conversation/conversation-slots.js";
import "./group-chat.css";

/**
 * 오른쪽 「구성원」 탭 본문 — 그룹 대화의 참여자 목록과 활동 상태.
 *
 * 구성원 줄 자체가 원장으로 가는 단추다 — 누르면 가운데 칸에 그 구성원의 원장(기존 본문)을 읽기 전용으로 세운다. 셸의 구성원 본문
 * 선택과 같은 문이다. 보고 있는 구성원 줄을 다시 누르면 대화로 돌아간다. 지휘관 줄은 원장 대상이 아니라 단추가 아니다. 정지·제거·추가는 콜백 자리만 둔다 — 쓰기 연결(임무 16) 전에는 단추가 서지 않는다.
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
            onLedger={onOpenLedger && participant.speaker.operationId && participant.speaker.kind === "member"
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
  const { speaker } = participant;
  const activity = memberActivityVisual(participant.activity);
  const role = speaker.kind === "commander" ? t("group.commander")
    : speaker.kind === "member" ? t("group.member")
      : speaker.kind === "commodore" ? t("group.commodore")
        : speaker.kind === "human" ? t("group.you") : t("group.operation");
  // Operation 이 있는 참여자(사령관 포함)의 아바타는 이 탭에서 고친다 — 대화 중심 화면에만 서는 탭이다. 사람은 첫 글자 칩 그대로다.
  const subject = useConversationSubject();
  // 얼굴은 다른 표면과 같은 기준이다 — Operation 이 있는 참여자는 Console 의 공개 활동 축(지휘관은 구성원을 끌어올린 값)과
  // 묶음의 검토 대기·결정 요청·임무 완료로, 사령관은 이 줄의 활동으로 고른다.
  const consoleState = useConsoleState();
  const clusterIndex = useClusterIndex();
  const avatar = speaker.kind === "commodore"
    ? { key: theaterAvatarKey(subject?.theaterId ?? "unknown"), role: "commodore" as const }
    : speaker.kind !== "human" && speaker.operationId
      ? { key: operationAvatarKey(speaker.operationId), role: speaker.kind === "member" ? "member" as const : "commander" as const }
      : null;
  const identity = (
    <>
      {avatar ? null : <SpeakerMark speaker={speaker} />}
      <span className="group-members-text">
        <SpeakerName speaker={speaker} className="group-members-name" />
        <span className="group-members-role">{role}</span>
      </span>
      <span className="group-members-state">
        <span className={`group-members-dot is-${activity}`} aria-hidden="true" />
        {t(activityKey(activity))}
      </span>
    </>
  );
  // 줄의 다른 단추(정지·제거)는 줄 단추 안에 넣지 않고 그 아래 형제로 둔다 — 단추 안의 단추는 서지 않고, 누름이 겹치지 않는다.
  const main = onLedger ? (
    <button type="button" className={`group-members-main${avatar ? " has-avatar" : ""}`} aria-pressed={showing} onClick={onLedger}>
      {identity}
    </button>
  ) : (
    <div className={`group-members-main${avatar ? " has-avatar" : ""}`}>{identity}</div>
  );
  return (
    <li className={`group-members-row${onLedger ? " is-openable" : ""}${showing ? " is-showing" : ""}`}>
      {avatar ? (
        <AvatarEditor layout="inline" avatarKey={avatar.key} role={avatar.role} state={speaker.kind !== "commodore" && speaker.operationId
          ? operationMongleState(speaker.operationId, consoleState, clusterIndex.clusters)
          : mongleStateOf({ activity: activity === "unknown" ? null : activity })} size={26} label={speaker.name}>
          {main}
        </AvatarEditor>
      ) : main}
      {onStop || onRemove ? (
        <span className="group-members-actions">
          {onStop ? <button type="button" className="group-chat-link" onClick={onStop}>{t("group.members.stop")}</button> : null}
          {onRemove ? <button type="button" className="group-chat-link is-danger" onClick={onRemove}>{t("group.members.remove")}</button> : null}
        </span>
      ) : null}
    </li>
  );
}
