import type { ConversationSpeaker, GroupTimelineEntry, GroupTimelineSnapshot } from "@fleet-console/sdk/conversation";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { operationAvatarKey, theaterAvatarKey, type MongleRole, type MongleState } from "@fleet-console/sdk/avatars";
import { React } from "@fleet-console/sdk/plugin/browser";

import { KeyedAvatar } from "../../../../../workspace/client/avatars.js";
import { useConversationSubject } from "../../../../../workspace/client/conversation/conversation-slots.js";
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
 * 발화자의 몽글 아바타 — 지휘관·일반 Operation 은 안테나, 구성원은 베이스만, 사령관은 별 배지. 사람과 Operation 이 없는 발화자는
 * 중립 첫 글자다. 모습은 Console 아바타 책에서 읽는다(사령관은 지금 대화가 선 Theater 의 것).
 */
export function SpeakerMark({ speaker, size = "md", state = "idle" }: { readonly speaker: ConversationSpeaker; readonly size?: "sm" | "md"; readonly state?: MongleState }) {
  const subject = useConversationSubject();
  const sizeClass = size === "sm" ? " group-chat-mark is-sm" : " group-chat-mark";
  if (speaker.kind === "commodore" || (speaker.kind !== "human" && speaker.operationId)) {
    const key = speaker.kind === "commodore" ? theaterAvatarKey(subject?.theaterId ?? "unknown") : operationAvatarKey(speaker.operationId!);
    const role: MongleRole = speaker.kind === "commodore" ? "commodore" : speaker.kind === "member" ? "member" : "commander";
    return <KeyedAvatar avatarKey={key} role={role} state={state} size={size === "sm" ? 16 : 22} label={speaker.name} decorative className={sizeClass.trim()} />;
  }
  const letter = Array.from(speaker.name.trim())[0] ?? "?";
  const tone = speakerTone(speaker);
  if (tone) return <span className={`cluster-member-glyph is-tone-${tone}${sizeClass}`} aria-hidden="true">{letter}</span>;
  return <span className={`cluster-member-glyph is-neutral${sizeClass}`} aria-hidden="true">{letter}</span>;
}

/** 발화자 이름 — 구성원은 표식과 같은 톤의 잉크로, 그 밖은 중립 잉크로 선다. */
export function SpeakerName({ speaker, className = "" }: { readonly speaker: ConversationSpeaker; readonly className?: string }) {
  const tone = speakerTone(speaker);
  return <span className={`group-chat-name${tone ? ` is-tone-${tone}` : ` is-${speaker.kind}`}${className ? ` ${className}` : ""}`}>{speaker.name}</span>;
}

/**
 * 화면 언어로 발화자 이름을 고친다 — 사령관은 데이터가 주는 고정 이름 대신 이 화면의 「사령관」으로 부른다.
 * 스냅숏 하나를 한 번 고쳐 대화·진행 줄·구성원 탭이 같은 이름을 쓰게 한다.
 */
export function useLocalizedSnapshot(snapshot: GroupTimelineSnapshot, language: ConsoleLocale | undefined): GroupTimelineSnapshot {
  return React.useMemo(() => {
    const commodore = getGroupT(language)("group.commodore");
    const fix = (speaker: ConversationSpeaker): ConversationSpeaker => (speaker.kind === "commodore" && speaker.name !== commodore ? { ...speaker, name: commodore } : speaker);
    const entries = snapshot.entries.map((entry): GroupTimelineEntry => {
      switch (entry.kind) {
        case "message": return entry.speaker.kind === "commodore" ? { ...entry, speaker: fix(entry.speaker) } : entry;
        case "delegation": return entry.sender.kind === "commodore" || entry.recipients.some((recipient) => recipient.kind === "commodore")
          ? { ...entry, sender: fix(entry.sender), recipients: entry.recipients.map(fix) } : entry;
        case "board-action": return { ...entry, speaker: fix(entry.speaker) };
        default: return entry;
      }
    });
    return {
      ...snapshot,
      entries,
      participants: snapshot.participants.map((participant) => (participant.speaker.kind === "commodore" ? { ...participant, speaker: fix(participant.speaker) } : participant)),
      working: snapshot.working.map(fix),
    };
  }, [snapshot, language]);
}
