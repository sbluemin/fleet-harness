import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import { launchProviderGlyph } from "@fleet-console/sdk/components/launch-provider-glyphs";
import { React } from "@fleet-console/sdk/plugin/browser";

import { operationAvatarKey, theaterAvatarKey } from "@fleet-console/sdk/avatars";
import type { ConversationMemberProfile, ConversationParticipant, ConversationSpeaker, GroupTimelineSnapshot } from "@fleet-console/sdk/conversation";
import { activityKey, memberActivityVisual } from "./group-conversation.js";
import { getGroupT } from "./group-chat-i18n.js";
import { ledgerTarget, participantMongleState, SpeakerMark, SpeakerName, speakerKey } from "./speaker-mark.js";
import { AvatarEditor } from "../../../../../workspace/client/avatars.js";
import { useConsoleState } from "../../../../../../core/client/src/hooks/use-store.js";
import { useConversationClusters, useConversationSubject } from "../../../../../workspace/client/conversation/conversation-slots.js";
import "./group-chat.css";

/**
 * 오른쪽 「구성원」 탭 본문 — 그룹 대화의 참여자 목록과 활동 상태.
 *
 * 지휘관·구성원 줄 자체가 원장으로 가는 단추다 — 누르면 가운데 칸에 그 참여자의 원장(기존 본문)을 읽기 전용으로 세운다.
 * 보고 있는 줄을 다시 누르면 대화로 돌아간다. 원장이 없는 참여자(사람·Operation 이 아직 없는 구성원)의 줄은 단추가 아니다.
 * 제거·추가는 콜백 자리만 둔다 — 쓰기 연결(임무 16) 전에는 단추가 서지 않는다. 정지는 작업 줄과 입력창에 있다.
 * 제거는 지휘관에게 서지 않는다. 지휘관을 빼면 목표가 서지 않는다.
 * 보드 사실(`participant.profile`)이 오면 보드 행과 같은 글 — 제안 표식, 모델·강도(라우팅·꺼짐 표식), 브리프, 상태 낱말, 사유 줄 — 을 그대로 싣는다.
 * 글은 플러그인이 지어 보낸 것이라 이 탭은 로케일로 풀기만 한다. 상태 점은 언제나 관측한 활동이다.
 */
export interface GroupMembersPanelProps {
  readonly snapshot: GroupTimelineSnapshot;
  readonly language: ConsoleLocale | undefined;
  /** 가운데 칸이 지금 원장을 보이는 참여자(셸의 구성원 본문 선택). 대화를 보고 있으면 null. */
  readonly ledgerOperationId: string | null;
  /** 원장을 열거나(id) 대화로 돌아간다(null). */
  readonly onOpenLedger?: (operationId: string | null) => void;
  readonly onRemove?: (speaker: ConversationSpeaker) => void;
  readonly onAdd?: () => void;
  /** 아직 서지 않은 Operation 의 명부(시작 전 목표) — 세션이 없는 참여자의 상태를 「알 수 없음」 대신 「시작 전」으로 말한다. */
  readonly notStarted?: boolean;
}

export function GroupMembersPanel({ snapshot, language, ledgerOperationId: focus, onOpenLedger, onRemove, onAdd, notStarted = false }: GroupMembersPanelProps) {
  const t = getGroupT(language);
  const participants = snapshot.participants;
  return (
    <div className="group-members">
      <h3 className="group-members-heading">{t("group.members.heading", { count: participants.length })}</h3>
      <ul className="group-members-list">
        {participants.map((participant) => {
          const target = onOpenLedger ? ledgerTarget(participant.speaker, participants) : null;
          return (
            <MemberRow
              key={speakerKey(participant.speaker)}
              participant={participant}
              language={language}
              notStarted={notStarted}
              showing={focus !== null && focus === participant.speaker.operationId}
              onLedger={onOpenLedger && target ? () => onOpenLedger(focus === target ? null : target) : undefined}
              onRemove={onRemove && participant.speaker.kind === "member" ? () => onRemove(participant.speaker) : undefined}
            />
          );
        })}
      </ul>
      {onAdd ? <button type="button" className="group-members-add" onClick={onAdd}>＋ {t("group.members.add")}</button> : null}
    </div>
  );
}

function MemberRow({ participant, language, notStarted, showing, onLedger, onRemove }: {
  readonly participant: ConversationParticipant;
  readonly language: ConsoleLocale | undefined;
  readonly notStarted: boolean;
  readonly showing: boolean;
  readonly onLedger: (() => void) | undefined;
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
  // 얼굴은 다른 표면과 같은 기준이다 — 말풍선의 최신 표식과 같은 `participantMongleState` 를 지난다.
  const consoleState = useConsoleState();
  const clusters = useConversationClusters();
  const avatar = speaker.kind === "commodore"
    ? { key: theaterAvatarKey(subject?.theaterId ?? "unknown"), role: "commodore" as const }
    : speaker.kind !== "human" && speaker.operationId
      ? { key: operationAvatarKey(speaker.operationId), role: speaker.kind === "member" ? "member" as const : "commander" as const }
      : null;
  const profile = participant.profile;
  const text = (value: Parameters<typeof resolveLocalizedText>[0]) => resolveLocalizedText(value, language ?? "en");
  const identity = (
    <>
      {avatar ? null : <SpeakerMark speaker={speaker} />}
      <span className="group-members-text">
        <span className="group-members-title">
          <SpeakerName speaker={speaker} className="group-members-name" />
          {profile?.badge ? ((badge) => <span className="group-members-badge" title={badge}>{badge}</span>)(text(profile.badge)) : null}
        </span>
        <span className="group-members-role">{role}</span>
        {profile?.launch ? <MemberLaunch launch={profile.launch} text={text} /> : null}
        {profile?.brief ? <span className="group-members-brief" title={profile.brief}>{profile.brief}</span> : null}
        {profile?.note ? <span className={`group-members-note${profile.note.tone === "warn" ? " is-warn" : ""}`} title={profile.note.title}>{text(profile.note.text)}</span> : null}
      </span>
      <span className={`group-members-state${profile?.status?.tone === "danger" ? " is-danger" : ""}`}>
        <span className={`group-members-dot is-${activity}`} aria-hidden="true" />
        {profile?.status ? text(profile.status.text) : notStarted && activity === "unknown" ? t("group.activity.notStarted") : t(activityKey(activity))}
      </span>
    </>
  );
  // 줄의 다른 단추(제거)는 줄 단추 안에 넣지 않고 그 아래 형제로 둔다 — 단추 안의 단추는 서지 않고, 누름이 겹치지 않는다.
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
        <AvatarEditor layout="inline" avatarKey={avatar.key} role={avatar.role} state={participantMongleState(speaker, participant.activity, consoleState, clusters)} size={26} label={speaker.name}>
          {main}
        </AvatarEditor>
      ) : main}
      {onRemove ? (
        <span className="group-members-actions">
          <button type="button" className="group-chat-link is-danger" onClick={onRemove}>{t("group.members.remove")}</button>
        </span>
      ) : null}
    </li>
  );
}

/**
 * 모델·강도 한 줄 — [라우팅·폴백 표식] [공급자 글리프] 낱말 [꺼짐·폴백 표식]. 좁은 칸에서는 낱말만 줄임표로 접고(풀네임은 hover),
 * 표식은 자리를 지킨다. 다음 기동에 쓰이지 않는 값(struck)은 보드처럼 취소선을 긋는다.
 */
function MemberLaunch({ launch, text }: {
  readonly launch: NonNullable<ConversationMemberProfile["launch"]>;
  readonly text: (value: Parameters<typeof resolveLocalizedText>[0]) => string;
}) {
  const label = text(launch.label);
  const effort = launch.effort ? text(launch.effort) : "";
  return (
    <span className="group-members-launch">
      {launch.via ? <span className={`group-members-via${launch.via.tone === "warn" ? " is-warn" : ""}`} title={launch.via.title ? text(launch.via.title) : undefined}>{text(launch.via.label)}</span> : null}
      <span className="group-members-launch-coord" title={launch.title ? text(launch.title) : [label, effort].filter(Boolean).join(" · ")}>
        {launch.provider ? <span className={`operation-launch-provider-glyph fc-coord-trigger-provider is-${launch.provider}`} aria-hidden="true">{launchProviderGlyph(launch.provider)}</span> : null}
        <span className={`group-members-launch-label${launch.struck ? " is-off" : ""}`}>{label}</span>
        {effort ? <><span className="group-members-launch-dot" aria-hidden="true">·</span><span className="group-members-launch-effort">{effort}</span></> : null}
      </span>
      {launch.badge ? <span className="group-members-launch-badge">{text(launch.badge)}</span> : null}
    </span>
  );
}
