import type { ConsoleLocale, Translate } from "@fleet-console/sdk/i18n";
import { createTranslator } from "@fleet-console/sdk/i18n/translate";

/**
 * 그룹 대화 화면의 문구. 실행 기능의 큰 사전과 따로 두어, 같은 사전을 함께 고치는 다른 작업과 부딪히지 않게 한다.
 * 문구는 평이한 서술형이다 — 무엇이 일어났는지를 말한다.
 */
const en = {
  "group.aria.log": "Group conversation",
  "group.loading": "Loading the conversation…",
  "group.empty": "No messages yet.",
  "group.truncated": "Earlier messages are past the stored limit and are not shown.",
  "group.unavailable": "Can't read {names} right now — the session is asleep or runs in a terminal.",
  "group.unavailableOne": "Can't read one participant right now — the session is asleep or runs in a terminal.",
  "group.you": "You",
  "group.commander": "Commander",
  "group.member": "Member",
  "group.commodore": "Commodore",
  "group.operation": "Operation",
  "group.streaming": "Writing…",
  "group.delegation.sent": "Sent message",
  "group.delegation.result": "Delivery result",
  "group.delegation.pending": "No result yet",
  "group.delegation.unconfirmed": "not yet confirmed",
  "group.delegation.failed": "delivery failed",
  "group.delegation.openLedger": "View {name}'s messages",
  "group.joined": "{name} joined",
  "group.left": "{name} was removed · earlier messages stay",
  "group.board.openRecord": "View in Commodore record",
  "group.board.reason": "Reason",
  "group.working.one": "{name} is working",
  "group.working.many": "{names} are working",
  "group.working.stopHint": "Click a mark to stop only that participant",
  "group.working.stop": "Stop {name}",
  "group.ledger.banner": "{name}'s ledger · read only",
  "group.ledger.back": "Back to the conversation",
  "group.members.heading": "Participants {count}",
  "group.members.ledger": "Messages",
  "group.members.stop": "Stop",
  "group.members.remove": "Remove",
  "group.members.add": "Add member",
  "group.activity.running": "Working",
  "group.activity.background": "Background work",
  "group.activity.awaiting": "Waiting for an answer",
  "group.activity.idle": "Idle",
  "group.activity.ended": "Ended",
  "group.activity.unknown": "Unknown",
} as const;

export type GroupChatMessageKey = keyof typeof en;

const ko: Record<GroupChatMessageKey, string> = {
  "group.aria.log": "그룹 대화",
  "group.loading": "대화를 불러오는 중입니다…",
  "group.empty": "아직 오간 말이 없습니다.",
  "group.truncated": "앞부분은 보관 상한을 넘어 표시하지 않습니다.",
  "group.unavailable": "{names}의 원장은 지금 읽을 수 없습니다. 세션이 휴면 중이거나 터미널로 실행 중입니다.",
  "group.unavailableOne": "참여자 한 명의 원장을 지금 읽을 수 없습니다. 세션이 휴면 중이거나 터미널로 실행 중입니다.",
  "group.you": "나",
  "group.commander": "지휘관",
  "group.member": "구성원",
  "group.commodore": "사령관",
  "group.operation": "Operation",
  "group.streaming": "쓰는 중…",
  "group.delegation.sent": "보낸 메시지",
  "group.delegation.result": "전달 결과",
  "group.delegation.pending": "아직 결과가 없습니다",
  "group.delegation.unconfirmed": "도착 확인 전",
  "group.delegation.failed": "전달 실패",
  "group.delegation.openLedger": "{name} 원장 보기",
  "group.joined": "{name} 합류",
  "group.left": "{name} 제거됨 · 지난 메시지는 남습니다",
  "group.board.openRecord": "사령관 기록에서 보기",
  "group.board.reason": "이유",
  "group.working.one": "{name} 작업하는 중",
  "group.working.many": "{names} 작업하는 중",
  "group.working.stopHint": "표식을 누르면 그 참여자만 멈춥니다",
  "group.working.stop": "{name} 정지",
  "group.ledger.banner": "{name}의 원장 · 읽기 전용",
  "group.ledger.back": "대화로 돌아가기",
  "group.members.heading": "참여자 {count}",
  "group.members.ledger": "원장 보기",
  "group.members.stop": "정지",
  "group.members.remove": "제거",
  "group.members.add": "구성원 추가",
  "group.activity.running": "작업 중",
  "group.activity.background": "백그라운드 작업",
  "group.activity.awaiting": "답을 기다림",
  "group.activity.idle": "대기",
  "group.activity.ended": "끝남",
  "group.activity.unknown": "알 수 없음",
};

const translators: Record<ConsoleLocale, Translate<GroupChatMessageKey>> = {
  en: createTranslator({ en, ko }, "en"),
  ko: createTranslator({ en, ko }, "ko"),
};

export function getGroupT(locale: ConsoleLocale | undefined): Translate<GroupChatMessageKey> {
  return translators[locale ?? "en"];
}
