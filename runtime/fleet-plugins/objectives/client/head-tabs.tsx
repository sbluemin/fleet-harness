import { useState, useSyncExternalStore } from "react";
import type { ConsoleLocale, LocalizedText } from "@fleet-console/sdk/i18n";
import type { RailEntryConversationTab, RailEntryConversationTabs, RailEntryConversationTabsState } from "@fleet-console/sdk/rail";

import { unseenRecords, type Objective } from "../server/types.js";
import { DatePicker } from "./date-picker.js";
import { freshConversationObjectiveId, shownFinishedObjective, subscribeFreshConversation, subscribeShownFinished } from "./fresh-conversation.js";
import { getT, type ObjectiveMessageKey } from "./i18n/index.js";
import { objectiveOfOperation } from "./mobile.js";
import { CalGlyph, DETAIL_TABS, detailTabOf, dueLabel, dueShort, SunGlyph, todayIso, type DetailTab } from "./objectives-panel.js";
import { findAnyObjective, followedOperationId, isObjectiveSurfaceOpen, objectiveDisplayTheaterId, objectivesApi, operationSummaries, patchObjectiveView, post, readObjectiveView, readTheater, subscribeObjective, subscribeObjectiveView } from "./objectives-state.js";

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
  const theaterId = objectiveDisplayTheaterId(contextTheaterId);
  if (isObjectiveSurfaceOpen()) {
    const selected = readObjectiveView(theaterId).selected;
    if (!selected) return { theaterId, objective: null };
    const shownDone = shownFinishedObjective();
    return { theaterId, objective: readTheater(theaterId).objectives.find((objective) => objective.id === selected && !objective.removed) ?? (shownDone?.id === selected ? shownDone : null) };
  }
  const standing = freshConversationObjectiveId();
  if (standing) return { theaterId, objective: findAnyObjective(standing) };
  const shownDone = shownFinishedObjective();
  if (shownDone) return { theaterId, objective: shownDone };
  const operationId = followedOperationId();
  return { theaterId, objective: operationId ? objectiveOfOperation(operationId) : null };
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
  const selected = detailTabOf(readObjectiveView(theaterId).detailTab);
  const decision = !!objective?.decisionRequest && !objective.done;
  const unseen = !!objective?.missions.some((mission) => unseenRecords(mission) > 0);
  const key = `${selected}|${decision}|${unseen}`;
  const slot = contextTheaterId ?? "";
  const cached = tabsCache.get(slot);
  if (cached?.key === key) return cached.state;
  const tabs = DETAIL_TABS.map((id): RailEntryConversationTab => ({
    id,
    title: TAB_TITLES[id],
    // 결정 내역은 목표 탭 맨 아래, 임무 그래프는 구성원 탭 맨 아래에 산다 — 점도 그 탭에 선다.
    ...(id === "goal" && decision ? { dot: DECISION_DOT } : id === "crew" && unseen ? { dot: UNSEEN_DOT } : {}),
    ...(id === "crew" ? { replacesMembers: true } : {}),
  }));
  const state = { tabs, selected };
  tabsCache.set(slot, { key, state });
  return state;
}

/**
 * 탭 줄 위 한 줄의 오늘·기한 — 글리프와 짧은 낱말이 섹션 줄 문법(작은 pill)으로 선다. 불리언이라 켜짐은 면 없이 잉크(brass-ink)로만
 * 말하고, 기한이 지나면 coral. 기한 지우기는 달력의 「기한 없음」과 고른 날짜의 재선택이 맡는다.
 */
function ObjectiveHeadTools({ theaterId: contextTheaterId, language }: { readonly theaterId: string | null; readonly language: ConsoleLocale }) {
  const read = () => headObjective(contextTheaterId).objective;
  const objective = useSyncExternalStore(subscribeHead, read, read);
  const readActivity = () => (objective ? operationSummaries().find((operation) => operation.id === objective.id)?.activity ?? null : null);
  const activity = useSyncExternalStore(subscribeObjective, readActivity, readActivity);
  if (!objective) return null;
  return <ObjectiveScheduleTools objective={objective} language={language} editable={!objective.done && activity !== "running" && activity !== "background"}
    patch={(next) => { const api = objectivesApi(); if (api) void post(api, "/objective/patch", { objectiveId: objective.id, patch: next, language }).catch(() => undefined); }} />;
}

/** 오늘·기한의 공용 UI. host 표면은 자기 권한과 목표 patch를 명시적으로 주입한다. */
export function ObjectiveScheduleTools({ objective, language, editable, patch }: {
  readonly objective: Objective; readonly language: ConsoleLocale; readonly editable: boolean;
  readonly patch: (next: Record<string, unknown>) => void;
}) {
  const [dateAnchor, setDateAnchor] = useState<DOMRect | null>(null);
  const lang = language === "ko" ? "ko" : "en";
  const t = getT(lang);
  const overdue = !!objective.dueDate && objective.dueDate < todayIso() && !objective.done;
  const todayLabel = t(objective.today ? "objectives.schedule.removeToday" : "objectives.schedule.addToday");
  const dueText = objective.dueDate ? t("objectives.tabs.dueTip", { date: dueLabel(objective.dueDate, lang) }) : t("objectives.schedule.setDue");
  return (
    <span className="objectives-head-tools" role="group" aria-label={t("objectives.schedule.title")}>
      <button type="button" className={`objectives-tab-glyph${objective.today ? " is-on" : ""}`} aria-pressed={objective.today} aria-label={todayLabel} title={todayLabel} disabled={!editable} onClick={() => patch({ today: !objective.today })}><SunGlyph /><span aria-hidden="true">{t("objectives.tabs.today")}</span></button>
      <button type="button" className={`objectives-tab-glyph${objective.dueDate ? " is-on" : ""}${overdue ? " is-overdue" : ""}`} aria-label={dueText} title={dueText} disabled={!editable} aria-haspopup="dialog" aria-expanded={!!dateAnchor} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setDateAnchor((value) => (value ? null : rect)); }}>
        <CalGlyph /><span aria-hidden="true">{t("objectives.schedule.due")}{objective.dueDate ? <span> · {dueShort(objective.dueDate, lang)}</span> : null}</span>
      </button>
      {dateAnchor ? <DatePicker anchor={dateAnchor} value={objective.dueDate} language={lang} t={t} onPick={(next) => patch({ dueDate: next })} onClose={() => setDateAnchor(null)} /> : null}
    </span>
  );
}

export const objectiveConversationTabs: RailEntryConversationTabs = {
  subscribe: subscribeHead,
  read: readHeadTabs,
  select: (tabId, contextTheaterId) => patchObjectiveView(objectiveDisplayTheaterId(contextTheaterId), () => ({ detailTab: detailTabOf(tabId) })),
  renderTools: ({ theaterId, language }) => <ObjectiveHeadTools theaterId={theaterId} language={language} />,
};
