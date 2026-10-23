import { useSyncExternalStore } from "react";

/**
 * 지휘관 원장 보기 — 「구성원」 탭에서 지휘관 줄을 눌러 가운데 칸에 지휘관의 기존 본문을 읽기 전용으로 세운 상태.
 *
 * 구성원 원장은 셸의 구성원 본문 선택(`selectNestedBody`)이 고르지만, 그 선택은 루트 자신을 고를 수 없다(루트를 고르면 「선택 없음」이다).
 * 지휘관의 원장은 루트의 기존 본문이므로 여기서 루트별로 따로 쥔다. 페이지 수명 동안만 살고 저장하지 않는다 — 구성원 본문 선택과 같다.
 *
 * 두 사실을 나눠 쥔다.
 * - `chosen`: 사람이 지휘관 원장을 골랐다. 가운데 칸 렌더러가 읽고, 「구성원」 탭에서 그 줄을 다시 누르거나 구성원을 고르거나
 *   원장 머리의 「대화로 돌아가기」를 누르면 걷힌다.
 * - `framed`: 지금 읽기 전용 틀이 그 본문을 감싸고 있다. 채팅 본문이 이것을 보고 입력 틀을 뺀다 — 고른 상태만으로 빼면
 *   틀 밖(캔버스·대화 중심 화면을 끈 뒤)의 같은 본문에서 입력이 사라진다. 본문은 본문 풀의 포털로 그려져 틀의 React
 *   context 가 닿지 않으므로 이 표식이 그 다리다.
 */
let chosen: ReadonlySet<string> = new Set();
const framed = new Map<string, number>();
const listeners = new Set<() => void>();
let revision = 0;

function notify(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const getRevision = () => revision;

/** 지휘관 원장을 열거나(true) 닫는다(false). 같은 값이면 아무 일도 하지 않는다. */
export function setCommanderLedger(rootObjectiveId: string, open: boolean): void {
  if (chosen.has(rootObjectiveId) === open) return;
  const next = new Set(chosen);
  if (open) next.add(rootObjectiveId); else next.delete(rootObjectiveId);
  chosen = next;
  notify();
}

/** 지휘관 원장을 골랐는가 — 플러그인 능력(`conversation.ledgerObjectiveId`)이 읽는다. */
export function isCommanderLedgerChosen(rootObjectiveId: string): boolean {
  return chosen.has(rootObjectiveId);
}

/** 고름이 바뀌면 깨운다. */
export function subscribeCommanderLedger(listener: () => void): () => void {
  return subscribe(listener);
}

export function useCommanderLedgerChosen(rootObjectiveId: string | null): boolean {
  useSyncExternalStore(subscribe, getRevision, getRevision);
  return rootObjectiveId !== null && chosen.has(rootObjectiveId);
}

/** 읽기 전용 틀이 지휘관 본문을 감싸는 동안 표식을 단다. 돌려준 함수로 뗀다(틀의 layout effect 수명). */
export function frameCommanderLedger(rootObjectiveId: string): () => void {
  framed.set(rootObjectiveId, (framed.get(rootObjectiveId) ?? 0) + 1);
  notify();
  return () => {
    const count = (framed.get(rootObjectiveId) ?? 1) - 1;
    if (count > 0) framed.set(rootObjectiveId, count); else framed.delete(rootObjectiveId);
    notify();
  };
}

/** 이 Objective 의 본문이 지금 지휘관 원장 틀 안에 서 있는가 — 채팅 본문이 입력 틀을 뺄지 읽는다. */
export function useCommanderLedgerFramed(objectiveId: string): boolean {
  useSyncExternalStore(subscribe, getRevision, getRevision);
  return framed.has(objectiveId);
}
