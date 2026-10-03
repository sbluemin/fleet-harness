import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { MentionTargetDescriptor } from "@fleet-console/sdk/plugin";

import type { AdmiralId, ChatSession } from "./chat-session.js";

/**
 * 플러그인 객체(모듈 스코프)와 마운트된 무리를 잇는 다리.
 *
 * Quick Launch 덱은 리액트 밖에서 `mentionTargets()`를 부르는데, 근무표와 로케일과 세션은 전부
 * 마운트된 `ScuttlebuttFlock` 안에 있다. 그래서 무리가 자기 상태를 여기에 실어 두고, 플러그인
 * 객체는 그것만 읽는다 — 무리가 없으면 대상도 없다는 사실이 그대로 계약이 된다(대답할 새가
 * 화면에 없으면 답이 설 자리도 없다).
 *
 * 이 싱글턴은 **플러그인 번들 안에서만** 산다. 호스트와 플러그인은 모듈 사본을 따로 실을 수 있어
 * 그 경계를 넘는 조율에는 쓸 수 없다(Console 배포 계약).
 */
export interface ScuttlebuttMentionBridge {
  /** 지금 근무 중인 부관만. 꺼 둔 부관은 목록에 서지 않는다. */
  readonly onDuty: () => readonly AdmiralId[];
  /**
   * 계급을 뺀 이름만("토리"). 덱은 카테고리 밴드가 이미 "부관"을 말하므로, 여기서 계급을
   * 다시 실으면 행선지 태그가 "부관 · 토리 부관"이 된다.
   */
  readonly label: (admiral: AdmiralId) => string;
  readonly locale: () => ConsoleLocale | undefined;
  readonly ask: (admiral: AdmiralId, text: string, inline?: boolean) => Promise<void>;
  readonly session: (admiral: AdmiralId) => ChatSession;
  readonly handoff: (text: string) => void;
}

// 표시 여부는 전송 약속이나 세션 단계와 별개다. 닫힘·레인 전환·도킹 접힘에서 즉시 해제된다.
const visibleCounts = new Map<AdmiralId, number>();
const visibilityListeners = new Set<() => void>();
let visibleConversations: readonly AdmiralId[] = [];
export function readScuttlebuttConversationVisibility(): readonly AdmiralId[] { return visibleConversations; }
export function subscribeScuttlebuttConversationVisibility(listener: () => void): () => void {
  visibilityListeners.add(listener);
  return () => { visibilityListeners.delete(listener); };
}
export function showScuttlebuttConversation(admiral: AdmiralId): () => void {
  const update = (delta: number) => {
    const count = (visibleCounts.get(admiral) ?? 0) + delta;
    if (count > 0) visibleCounts.set(admiral, count); else visibleCounts.delete(admiral);
    const next = [...visibleCounts.keys()];
    if (next.length === visibleConversations.length && next.every((id, i) => visibleConversations[i] === id)) return;
    visibleConversations = next;
    for (const listener of [...visibilityListeners]) listener();
  };
  update(1);
  return () => update(-1);
}

let bridge: ScuttlebuttMentionBridge | null = null;
const listeners = new Set<() => void>();
export function notifyScuttlebuttMentions(): void {
  for (const listener of [...listeners]) listener();
}
export function subscribeScuttlebuttMentions(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function connectScuttlebuttMentions(next: ScuttlebuttMentionBridge): () => void {
  bridge = next;
  notifyScuttlebuttMentions();
  return () => {
    if (bridge === next) { bridge = null; notifyScuttlebuttMentions(); }
  };
}

export function readScuttlebuttMentionBridge(): ScuttlebuttMentionBridge | null {
  return bridge;
}
