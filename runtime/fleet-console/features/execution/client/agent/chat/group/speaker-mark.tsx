import type { ConversationParticipant, ConversationSpeaker, GroupTimelineEntry, GroupTimelineSnapshot } from "@fleet-console/sdk/conversation";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { mongleStateOf, operationAvatarKey, theaterAvatarKey, type MongleRole, type MongleState } from "@fleet-console/sdk/avatars";
import type { OperationCluster } from "@fleet-console/sdk/plugin";
import { React } from "@fleet-console/sdk/plugin/browser";

import { useConsoleState } from "../../../../../../core/client/src/hooks/use-store.js";
import type { ConsoleState } from "../../../../../../core/client/src/integration/types.js";
import { KeyedAvatar, operationMongleState } from "../../../../../workspace/client/avatars.js";
import { useConversationClusters, useConversationSubject } from "../../../../../workspace/client/conversation/conversation-slots.js";
import { getGroupT } from "./group-chat-i18n.js";

/**
 * 발화자 표식 — 그룹 대화의 말풍선·위임 줄·진행 줄·구성원 탭이 같은 표식을 쓴다.
 *
 * Operation 이 있는 발화자는 사이드바와 같은 몽글 아바타로 선다 — 같은 지휘관·구성원이 목록과 대화에서 다른 얼굴이면 사람이 둘을
 * 잇지 못한다. 사람과 Operation 이 없는 발화자만 첫 글자 칩이고, 구성원 톤(`{number, tone}`)은 이름 잉크가 그대로 쓴다.
 */
const TONES = new Set(["teal", "amber", "plum", "moss", "cerulean", "rose", "indigo", "crimson"]);

export function speakerTone(speaker: ConversationSpeaker): string | null {
  const tone = speaker.mark?.tone;
  return speaker.kind === "member" && tone && TONES.has(tone) ? tone : speaker.kind === "member" ? "teal" : null;
}

/** 같은 발화자를 가리키는 좌표 — 원장 보기·정지 대상의 키. 사람에게는 Operation 이 없다. */
export function speakerKey(speaker: ConversationSpeaker): string {
  return speaker.operationId ?? `${speaker.kind}:${speaker.name}`;
}

/**
 * 발화자가 여는 원장 — 지휘관·구성원이고 그 Operation 이 이 대화의 명부에 있을 때만 그 id, 아니면 null.
 * 말풍선 머리와 「구성원」 탭 줄이 같은 규칙으로 누를 수 있는 대상을 고른다. 명부에 없는 id 로 열면 가운데 칸이 대화에
 * 그대로 남으므로(셸의 본문 주인이 루트로 떨어진다) 눌리는 척하지 않게 그런 발화자는 대상이 아니다.
 */
export function ledgerTarget(speaker: ConversationSpeaker, participants: readonly ConversationParticipant[]): string | null {
  const operationId = speaker.operationId;
  if (!operationId || (speaker.kind !== "member" && speaker.kind !== "commander")) return null;
  return participants.some((participant) => participant.speaker.operationId === operationId) ? operationId : null;
}

/**
 * 사령관 표식이 쓸 Theater — 가운데 칸에 Operation 이 없는 플러그인 대화(사령관 기록)는 대화 subject 가 없으므로 그 대화가 직접 준다.
 * 없으면 지금 대화가 선 Operation 의 Theater 다.
 */
export const ConversationTheaterContext = React.createContext<string | null>(null);

/**
 * 발화자의 몽글 아바타 — 지휘관·일반 Operation 은 안테나, 구성원은 베이스만, 사령관은 별 배지. 사람과 Operation 이 없는 발화자는
 * 중립 첫 글자다. 모습은 Console 아바타 책에서 읽는다(사령관은 지금 대화가 선 Theater 의 것).
 *
 * `acting` 이면 작업 중인 Operation 표식이 사이드바와 같은 축(`useOperationMongleActivity`)으로 지금 하는 일(생각·읽기·편집…)을
 * 연기한다. 진행 줄만 켠다 — 지난 말풍선 표식은 그 말의 자리라 연기하지 않는다. 사령관은 Operation 이 없어 기본 리듬이다.
 */
const MARK_PX = { sm: 16, md: 22, lg: 32 } as const;

export function SpeakerMark({ speaker, size = "md", state = "idle", acting = false }: {
  readonly speaker: ConversationSpeaker;
  readonly size?: keyof typeof MARK_PX;
  readonly state?: MongleState;
  readonly acting?: boolean;
}) {
  const subject = useConversationSubject();
  const theater = React.useContext(ConversationTheaterContext);
  const sizeClass = size === "md" ? " group-chat-mark" : ` group-chat-mark is-${size}`;
  if (speaker.kind === "commodore" || (speaker.kind !== "human" && speaker.operationId)) {
    const key = speaker.kind === "commodore" ? theaterAvatarKey(theater ?? subject?.theaterId ?? "unknown") : operationAvatarKey(speaker.operationId!);
    const role: MongleRole = speaker.kind === "commodore" ? "commodore" : speaker.kind === "member" ? "member" : "commander";
    const activityOperationId = acting && speaker.kind !== "commodore" ? speaker.operationId : null;
    return <KeyedAvatar avatarKey={key} role={role} state={state} activityOperationId={activityOperationId} size={MARK_PX[size]} label={speaker.name} decorative className={sizeClass.trim()} />;
  }
  const letter = Array.from(speaker.name.trim())[0] ?? "?";
  const tone = speakerTone(speaker);
  if (tone) return <span className={`cluster-member-glyph is-tone-${tone}${sizeClass}`} aria-hidden="true">{letter}</span>;
  return <span className={`cluster-member-glyph is-neutral${sizeClass}`} aria-hidden="true">{letter}</span>;
}

/**
 * 참여자의 지금 얼굴 — 구성원 탭과 말풍선의 최신 표식이 같은 기준으로 고른다. Operation 이 있는 참여자는 다른 표면과 같은
 * Console 공개 활동 축(지휘관은 구성원 활동을 끌어올린 팀 값)과 묶음의 검토 대기·결정 요청·임무 완료로, 사령관과 Operation 이
 * 없는 참여자는 그룹 스냅숏의 참여자 활동으로 고른다.
 */
export function participantMongleState(
  speaker: ConversationSpeaker,
  activity: ConversationParticipant["activity"] | undefined,
  state: Pick<ConsoleState, "operations" | "nestedOperations" | "operationRuntime">,
  clusters: readonly OperationCluster[],
): MongleState {
  if (speaker.kind !== "commodore" && speaker.kind !== "human" && speaker.operationId) return operationMongleState(speaker.operationId, state, clusters);
  return mongleStateOf({ activity: activity === undefined || activity === "unknown" ? null : activity });
}

/**
 * 발화자의 지금 상태를 보이는 표식 — 그 발화자의 가장 최근 말풍선 묶음 머리에만 선다. 지난 묶음의 표식은 그 말의 자리라
 * 쉼(idle)으로 둔다. Console 상태를 구독하므로 최신 머리 몇 개에만 쓴다.
 */
export function LiveSpeakerMark({ speaker, participants }: { readonly speaker: ConversationSpeaker; readonly participants: readonly ConversationParticipant[] }) {
  const state = useConsoleState();
  const clusters = useConversationClusters();
  const key = speakerKey(speaker);
  const activity = participants.find((participant) => speakerKey(participant.speaker) === key)?.activity;
  return <SpeakerMark speaker={speaker} state={participantMongleState(speaker, activity, state, clusters)} />;
}

/** 발화자 이름 — 구성원은 표식과 같은 톤의 잉크로, 그 밖은 중립 잉크로 선다. */
export function SpeakerName({ speaker, className = "" }: { readonly speaker: ConversationSpeaker; readonly className?: string }) {
  const tone = speakerTone(speaker);
  return <span className={`group-chat-name${tone ? ` is-tone-${tone}` : ` is-${speaker.kind}`}${className ? ` ${className}` : ""}`}>{speaker.name}</span>;
}

/**
 * 화면 언어로 발화자 이름을 고친다 — 사령관은 데이터가 주는 고정 이름 대신 이 화면의 「사령관」으로, 사람은 「나」로 부른다.
 * 스냅숏 하나를 한 번 고쳐 대화·진행 줄·구성원 탭이 같은 이름을 쓰게 한다. 플러그인 대화(SDK `ctx.chat.Conversation`)의 줄도
 * 같은 모양이라(노트 줄은 발화자가 없다) 같은 고침을 지난다.
 */
type LocalizableEntry = GroupTimelineEntry | { readonly kind: "note" };
type LocalizableSnapshot = Omit<GroupTimelineSnapshot, "entries"> & { readonly entries: readonly LocalizableEntry[] };

export function useLocalizedSnapshot<S extends LocalizableSnapshot>(snapshot: S, language: ConsoleLocale | undefined): S {
  return React.useMemo(() => {
    const t = getGroupT(language);
    const names = { commodore: t("group.commodore"), human: t("group.you") };
    const localized = (speaker: ConversationSpeaker): boolean => speaker.kind === "commodore" || speaker.kind === "human";
    const fix = (speaker: ConversationSpeaker): ConversationSpeaker => {
      if (speaker.kind !== "commodore" && speaker.kind !== "human") return speaker;
      const name = names[speaker.kind];
      return speaker.name === name ? speaker : { ...speaker, name };
    };
    const entries = snapshot.entries.map((entry): LocalizableEntry => {
      switch (entry.kind) {
        case "message": return localized(entry.speaker) ? { ...entry, speaker: fix(entry.speaker) } : entry;
        case "delegation": return localized(entry.sender) || entry.recipients.some(localized)
          ? { ...entry, sender: fix(entry.sender), recipients: entry.recipients.map(fix) } : entry;
        case "board-action": return { ...entry, speaker: fix(entry.speaker) };
        default: return entry;
      }
    });
    return {
      ...snapshot,
      entries,
      participants: snapshot.participants.map((participant) => (localized(participant.speaker) ? { ...participant, speaker: fix(participant.speaker) } : participant)),
      working: snapshot.working.map(fix),
    };
  }, [snapshot, language]);
}
