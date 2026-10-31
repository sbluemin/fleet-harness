import { useRef, useState, useSyncExternalStore } from "react";
import type { ConsoleLocale, LocalizedText } from "@fleet-console/i18n";
import type { RailEntryConversationPane, RailEntryConversationTab, RailEntryConversationTabs, RailEntryConversationTabsState } from "../../workspace/shared/rail.js";

import { unseenRecords, type Objective } from "../shared/types.js";
import { freshConversationObjectiveId, shownFinishedObjective, subscribeFreshConversation, subscribeShownFinished } from "./fresh-conversation.js";
import { getT, type ObjectiveMessageKey } from "./i18n/index.js";
import { objectiveOfObjective } from "./mobile.js";
import { DETAIL_TABS, detailTabOf, ObjectiveScheduleRow, type DetailTab } from "./objectives-panel.js";
import { findAnyObjective, followedObjectiveId, isObjectiveSurfaceOpen, objectiveDisplayOwnerId, patchOwnerView, readOwnerView, readBoard, subscribeObjective, subscribeObjectiveView } from "./objectives-state.js";

/**
 * 목표 상세의 탭과 오늘·기한은 Console 오른쪽 패널 머리(아바타·이름 아래)에 두 줄로 선다 — 첫 줄은 오늘·기한(사령관 패널의 섹션 줄 자리),
 * 둘째 줄은 목표·구성원·결과물 글자 탭이다. 상세는 고른 탭의 본문만 그린다. 「구성원」은 대상의 구성원 탭을 대신한다(한 머리에 둘 서지 않는다).
 */

const T = (key: ObjectiveMessageKey): LocalizedText => (locale: ConsoleLocale) => getT(locale)(key);
const TAB_TITLES: Record<DetailTab, LocalizedText> = {
  goal: T("objectives.tabs.goal"),
  crew: T("objectives.tabs.crew"),
  results: T("objectives.tabs.results"),
};
const DECISION_DOT = { tone: "attention", label: T("objectives.tabs.decisionDot") } as const;
const UNSEEN_DOT = { tone: "unseen", label: T("objectives.tabs.unseenDot") } as const;

/**
 * 머리 탭이 가리키는 목표 — 패널이 열려 있으면 패널이 보이는 목표, 닫혀 있으면 열 때 따라갈 목표(시작 전 화면·완료 화면·지금 대화의 목표).
 */
function headObjective(contextTheaterId: string | null): { readonly theaterId: string | null; readonly objective: Objective | null } {
  const theaterId = objectiveDisplayOwnerId(contextTheaterId);
  if (isObjectiveSurfaceOpen()) {
    const selected = readOwnerView(theaterId).selected;
    if (!selected) return { theaterId, objective: null };
    const shownDone = shownFinishedObjective();
    return { theaterId, objective: readBoard(theaterId).objectives.find((objective) => objective.id === selected && !objective.removed) ?? (shownDone?.id === selected ? shownDone : null) };
  }
  const standing = freshConversationObjectiveId();
  if (standing) return { theaterId, objective: findAnyObjective(standing) };
  const shownDone = shownFinishedObjective();
  if (shownDone) return { theaterId, objective: shownDone };
  const objectiveId = followedObjectiveId();
  return { theaterId, objective: objectiveId ? objectiveOfObjective(objectiveId) : null };
}

function subscribeHead(listener: () => void): () => void {
  const offs = [subscribeObjective(listener), subscribeObjectiveView(listener), subscribeFreshConversation(listener), subscribeShownFinished(listener)];
  return () => { for (const off of offs) off(); };
}

// 같은 상태에는 같은 객체를 돌려준다 — 호스트가 useSyncExternalStore 로 읽는다.
const tabsCache = new Map<string, { readonly key: string; readonly state: RailEntryConversationTabsState }>();
function readHeadTabs(contextTheaterId: string | null): RailEntryConversationTabsState {
  // 대화가 곧 목표다 — 목표를 아직 읽지 못한 순간에도 세 탭은 그대로 서고, 점만 비어 있다.
  const { theaterId, objective } = headObjective(contextTheaterId);
  const selected = detailTabOf(readOwnerView(theaterId).detailTab);
  return readTabs(contextTheaterId ?? "", objective, selected);
}

function readTabs(slot: string | undefined, objective: Objective | null, selected: DetailTab): RailEntryConversationTabsState {
  const decision = !!objective?.decisionRequest && !objective.done;
  const unseen = !!objective?.missions.some((mission) => unseenRecords(mission) > 0);
  const key = `${selected}|${decision}|${unseen}`;
  const cacheSlot = slot ?? `mobile:${key}`;
  const cached = tabsCache.get(cacheSlot);
  if (cached?.key === key) return cached.state;
  const tabs = DETAIL_TABS.map((id): RailEntryConversationTab => ({
    id,
    title: TAB_TITLES[id],
    // 결정 내역은 목표 탭 맨 아래, 임무 그래프는 구성원 탭 맨 아래에 산다 — 점도 그 탭에 선다.
    ...(id === "goal" && decision ? { dot: DECISION_DOT } : id === "crew" && unseen ? { dot: UNSEEN_DOT } : {}),
    ...(id === "crew" ? { replacesMembers: true } : {}),
  }));
  const state = { tabs, selected };
  tabsCache.set(cacheSlot, { key, state });
  return state;
}

/** 폰에서는 현재 대화의 세 보기를 정보 옆에 올린다 — 선택과 본문은 같은 보기 상태를 읽는다. */
export const objectiveMobileConversationTabs: NonNullable<RailEntryConversationPane["tabs"]> = {
  subscribe: subscribeHead,
  read: (objectiveId) => {
    const objective = objectiveOfObjective(objectiveId);
    return readTabs(undefined, objective, detailTabOf(readOwnerView(objective?.commodoreId ?? null).detailTab));
  },
  select: (tabId, objectiveId) => {
    const objective = objectiveOfObjective(objectiveId);
    if (objective) patchOwnerView(objective.commodoreId, () => ({ detailTab: detailTabOf(tabId) }));
  },
};

/**
 * 탭 줄 위 한 줄의 오늘·기한 — 목표를 직접 받는 행을 objectives-panel의 공용 줄로 둔다.
 */
function ObjectiveHeadTools({ theaterId: contextTheaterId, language }: { readonly theaterId: string | null; readonly language: ConsoleLocale }) {
  const read = () => headObjective(contextTheaterId).objective;
  const objective = useSyncExternalStore(subscribeHead, read, read);
  if (!objective) return null;
  return <ObjectiveScheduleRow objective={objective} language={language} />;
}

export const objectiveConversationTabs: RailEntryConversationTabs = {
  subscribe: subscribeHead,
  read: readHeadTabs,
  select: (tabId, contextTheaterId) => patchOwnerView(objectiveDisplayOwnerId(contextTheaterId), () => ({ detailTab: detailTabOf(tabId) })),
  renderTools: ({ theaterId, language }) => <ObjectiveHeadTools theaterId={theaterId} language={language} />,
};
