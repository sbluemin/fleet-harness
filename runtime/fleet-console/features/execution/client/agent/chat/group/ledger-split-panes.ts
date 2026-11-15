import { useSyncExternalStore } from "react";

import type { ConversationSpeaker } from "../../../../shared/conversation/types.js";

/**
 * 원장 분할 화면의 칸 표식 — 어떤 Objective 의 본문이 지금 분할 칸 안에 서 있고, 그 칸의 주인이 누구인가.
 *
 * 칸 본문은 본문 풀의 포털로 그려져 분할 칸의 React context 가 닿지 않는다. 그래서 분할 칸이 layout effect 동안 objectiveId →
 * 발화자 표식을 달고, 채팅 본문이 이것을 읽어 분할 칸에서만 바닥 줄 왼쪽(모델 좌표)을 칸 주인의 아바타·이름으로 바꾼다.
 * 개별 원장 틀(`commander-ledger` 의 framed)과 같은 다리이며, 분할 칸 밖의 같은 본문은 표식이 없어 예전 그대로다.
 */
const marks = new Map<string, { readonly speaker: ConversationSpeaker; readonly count: number }>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 분할 칸이 이 Objective 본문을 세운 동안 칸 주인 표식을 단다. 돌려준 함수로 뗀다(칸의 layout effect 수명). */
export function markLedgerSplitPane(objectiveId: string, speaker: ConversationSpeaker): () => void {
  const current = marks.get(objectiveId);
  marks.set(objectiveId, { speaker, count: (current?.count ?? 0) + 1 });
  if (current?.speaker !== speaker) notify();
  return () => {
    const entry = marks.get(objectiveId);
    if (!entry) return;
    if (entry.count > 1) { marks.set(objectiveId, { ...entry, count: entry.count - 1 }); return; }
    marks.delete(objectiveId);
    notify();
  };
}

/** 이 Objective 본문이 분할 칸 안에 서 있으면 그 칸 주인, 아니면 null. */
export function useLedgerSplitPaneSpeaker(objectiveId: string): ConversationSpeaker | null {
  return useSyncExternalStore(subscribe, () => marks.get(objectiveId)?.speaker ?? null, () => null);
}
