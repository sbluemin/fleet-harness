import { useSyncExternalStore } from "react";

import type { RailPanelDescriptor } from "../../../../../features/workspace/shared/rail.js";

/**
 * 대화 중심 화면의 오른쪽 패널 앞 묶음 — 지금 가운데 칸에 선 Objective 의 탭(구성원 등).
 *
 * 탭은 레일 패널로 선다. 그래서 독점 슬롯·도구별 폭 기억·밀어내기를 레일 계약 그대로 받는다. 등록은 언제든 할 수
 * 있지만, 레일 목록에 실리는 것은 대화 중심 화면이 서 있는 동안뿐이다(`useConversationObjectiveTabsHost`). 그래서
 * 실험 기능이 꺼진 Console 의 도구 목록·팔레트·폭 저장은 한 칸도 달라지지 않는다.
 *
 * 호스트 번들 안의 소비자만 쓴다. 플러그인 번들은 이 모듈의 다른 사본을 가질 수 있으므로 여기에 등록하지 않는다.
 */
export type ConversationObjectiveTab = Extract<RailPanelDescriptor, { readonly render: unknown }> & {
  /** 앞 묶음 안의 순서 — 작은 값이 앞이다. 같으면 등록 순서. */
  readonly order?: number;
  /**
   * 이 탭이 속한 Theater 섹션(Theater Inbox 를 오른쪽 패널로 옮긴 자리) — 섹션이 둘 이상 서면 패널 머리가 섹션 줄을 세우고 고른 섹션의
   * 탭만 보인다. Theater 를 연 동안에는 그 Theater 의 섹션 탭만 선다.
   */
  readonly section?: ConversationTabSection;
};

export interface ConversationTabSection {
  readonly id: string;
  readonly title: string;
  readonly theaterId: string;
}

let tabs: readonly ConversationObjectiveTab[] = [];
let hostCount = 0;
let snapshot: readonly ConversationObjectiveTab[] = [];
let registered: readonly ConversationObjectiveTab[] = [];
const listeners = new Set<() => void>();

function sameTabs(left: readonly ConversationObjectiveTab[], right: readonly ConversationObjectiveTab[]): boolean {
  return left.length === right.length && left.every((tab, index) => tab === right[index]);
}

function publish(): void {
  const sorted = [...tabs].sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
  const next = hostCount > 0 ? sorted : [];
  const changed = !sameTabs(next, snapshot) || !sameTabs(sorted, registered);
  snapshot = next;
  registered = sorted;
  if (changed) for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 탭 하나를 등록한다. 같은 id 는 새 등록이 이긴다. 돌려준 함수로 걷는다. */
export function registerConversationObjectiveTab(tab: ConversationObjectiveTab): () => void {
  tabs = [...tabs.filter((existing) => existing.id !== tab.id), tab];
  publish();
  return () => {
    if (!tabs.includes(tab)) return;
    tabs = tabs.filter((existing) => existing !== tab);
    publish();
  };
}

/** 대화 중심 화면이 서 있음을 알린다. 걷는 함수는 언마운트 cleanup 에서 부른다. */
export function mountConversationObjectiveTabsHost(): () => void {
  hostCount += 1;
  publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    hostCount -= 1;
    publish();
  };
}

/**
 * 등록된 탭 전부 — 호스트가 서 있는지와 무관하다. 레일 목록에 싣지 않고 읽기만 하는 표면(모바일 대화 정보 화면)이 같은 원천을 읽는다.
 * 레일에 싣는 쪽(`useConversationObjectiveTabPanels`)은 그대로 호스트가 선 동안만 비어 있지 않다.
 */
export function useRegisteredConversationObjectiveTabs(): readonly ConversationObjectiveTab[] {
  return useSyncExternalStore(subscribe, () => registered, () => registered);
}

/** 레일 목록이 읽는 앞 묶음 — 대화 중심 화면 밖에서는 늘 빈 배열이다. */
export function useConversationObjectiveTabPanels(): readonly ConversationObjectiveTab[] {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
