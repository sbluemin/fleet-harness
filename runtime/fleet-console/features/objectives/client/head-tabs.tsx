import type { ConsoleLocale, LocalizedText } from "@fleet-console/i18n";
import type { RailEntryConversationPane, RailEntryConversationTab, RailEntryConversationTabsState } from "../../workspace/shared/rail.js";

import { unseenRecords, type Objective } from "../shared/types.js";
import { subscribeFreshConversation, subscribeShownFinished } from "./fresh-conversation.js";
import { getT, type ObjectiveMessageKey } from "./i18n/index.js";
import { objectiveOfObjective } from "./mobile.js";
import { DETAIL_TABS, detailTabOf, type DetailTab } from "./objectives-panel.js";
import { patchOwnerView, readOwnerView, subscribeObjective, subscribeObjectiveView } from "./objectives-state.js";
import { openResultWindow } from "./result-window.js";

const T = (key: ObjectiveMessageKey): LocalizedText => (locale: ConsoleLocale) => getT(locale)(key);
const TAB_TITLES: Record<DetailTab, LocalizedText> = {
  goal: T("objectives.tabs.goal"),
  crew: T("objectives.tabs.crew"),
};
const UNSEEN_DOT = { tone: "unseen", label: T("objectives.tabs.unseenDot") } as const;

function subscribeHead(listener: () => void): () => void {
  const offs = [subscribeObjective(listener), subscribeObjectiveView(listener), subscribeFreshConversation(listener), subscribeShownFinished(listener)];
  return () => { for (const off of offs) off(); };
}

// 같은 상태에는 같은 객체를 돌려준다 — 호스트가 useSyncExternalStore 로 읽는다.
const tabsCache = new Map<string, { readonly key: string; readonly state: RailEntryConversationTabsState }>();
function readTabs(slot: string | undefined, objective: Objective | null, selected: DetailTab): RailEntryConversationTabsState {
  const unseen = !!objective?.missions.some((mission) => unseenRecords(mission) > 0);
  const key = `${selected}|${unseen}`;
  const cacheSlot = slot ?? `mobile:${key}`;
  const cached = tabsCache.get(cacheSlot);
  if (cached?.key === key) return cached.state;
  const tabs = [
    ...DETAIL_TABS.map((id): RailEntryConversationTab => ({
      id,
      title: TAB_TITLES[id],
      // 결정 내역은 목표 탭 맨 아래, 임무 그래프는 구성원 탭 맨 아래에 산다 — 점도 그 탭에 선다.
      ...(id === "crew" && unseen ? { dot: UNSEEN_DOT } : {}),
      ...(id === "crew" ? { replacesMembers: true } : {}),
    })),
    // 증거는 상세 탭이 아니다 — 누르면 뷰어만 연다.
    { id: "evidence", title: T("objectives.results.title"), external: true },
  ];
  const state = { tabs, selected };
  tabsCache.set(cacheSlot, { key, state });
  return state;
}

/** 폰에서는 현재 대화의 목표·구성원과 증거 칸을 정보 옆에 올린다 — 선택과 본문은 같은 보기 상태를 읽는다. 증거는 뷰어를 연다. */
export const objectiveMobileConversationTabs: NonNullable<RailEntryConversationPane["tabs"]> = {
  subscribe: subscribeHead,
  read: (objectiveId) => {
    const objective = objectiveOfObjective(objectiveId);
    return readTabs(undefined, objective, detailTabOf(readOwnerView(objective?.commodoreId ?? null).detailTab));
  },
  select: (tabId, objectiveId) => {
    if (tabId === "evidence") {
      const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // 구성원 대화에서는 objectiveId 가 구성원 id 다 — 뷰어에는 그 구성원이 속한 목표를 넘긴다.
      // 목록에 없는(끝난) 목표는 받은 id 그대로 연다.
      const target = objectiveOfObjective(objectiveId)?.id ?? objectiveId;
      if (target) openResultWindow(target, "", opener);
      return;
    }
    const objective = objectiveOfObjective(objectiveId);
    if (objective) patchOwnerView(objective.commodoreId, () => ({ detailTab: detailTabOf(tabId) }));
  },
};
