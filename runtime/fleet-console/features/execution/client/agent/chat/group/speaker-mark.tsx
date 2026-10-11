import type { ConversationSpeaker, GroupTimelineEntry, GroupTimelineSnapshot } from "@fleet-console/sdk/conversation";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import { getGroupT } from "./group-chat-i18n.js";

/**
 * 발화자 표식 — 그룹 대화의 말풍선·위임 줄·진행 줄·구성원 탭이 같은 표식을 쓴다.
 *
 * 구성원 표식은 플러그인이 준 `{number, tone}` 으로 Console 이 직접 그린다(플러그인 구현을 가져오지 않는다).
 * 모양과 톤은 지휘관 패널 노드 줄의 `cluster-member-glyph` 와 같다 — 같은 구성원이 노드 줄과 대화에서 다른 얼굴이면
 * 사람이 둘을 잇지 못한다. 지휘관은 노드 줄과 같은 좌표 글리프, 사령관은 깃발, 사람과 일반 Operation 은 중립 첫 글자다.
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

const CoordGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true">
    <circle cx="8" cy="4" r="2" />
    <circle cx="4" cy="12" r="2" />
    <circle cx="12" cy="12" r="2" />
    <path d="M7 5.7L5 10.3M9 5.7l2 4.6" />
  </svg>
);

const PennantGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 14V2.5" />
    <path d="M4 3h8l-2.2 3L12 9H4" />
  </svg>
);

export function SpeakerMark({ speaker, size = "md" }: { readonly speaker: ConversationSpeaker; readonly size?: "sm" | "md" }) {
  const tone = speakerTone(speaker);
  const sizeClass = size === "sm" ? " group-chat-mark is-sm" : " group-chat-mark";
  if (speaker.kind === "commander") {
    return <span className={`cluster-member-glyph is-commander${sizeClass}`} aria-hidden="true"><CoordGlyph /></span>;
  }
  if (speaker.kind === "commodore") {
    return <span className={`cluster-member-glyph is-commander is-commodore${sizeClass}`} aria-hidden="true"><PennantGlyph /></span>;
  }
  const letter = Array.from(speaker.name.trim())[0] ?? "?";
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
