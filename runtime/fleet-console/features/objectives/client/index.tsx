import type { ObjectivesClientDeps } from "./deps.js";
import type { ClientFeatureDescriptor } from "../../workspace/shared/feature-surfaces.js";
import type { CommodoreClientHost } from "../../commodore/shared/contracts/client.js";
import type { PaneDescriptor } from "../../workspace/shared/pane.js";
import type { RailEntryDescriptor } from "../../workspace/shared/rail.js";

import { installCommodoreHost, isCommodoreConversationActive, subscribeCommodoreConversationActive } from "./board-commodore.js";
import { objectivesClusterSource } from "./clusters.js";
import { installLaunchRoster } from "./launch-control.js";
import { connectFreshConversation, freshConversationSurface, goToObjective } from "./fresh-conversation.js";
import { getT } from "./i18n/index.js";
import { objectiveConversationTabs, objectiveMobileConversationTabs } from "./head-tabs.js";
import { decisionAttentionItems, finishedObjectiveItems, subscribeFinishedObjectives, MobileConversationObjective, MobileObjectiveScreen, objectiveOfOperation, OBJECTIVE_MOBILE_DETAIL_PANE, personTurnCount, subscribeDecisionAttention } from "./mobile.js";
import { ObjectivePanel } from "./objectives-panel.js";
import { objectivesOnboarding } from "./onboarding.js";
import { viewedTheaterId, handleMapOperationSelected, installObjectiveState, loadTheater, objectivesApi, subscribeObjective, toggleObjectivePanel } from "./objectives-state.js";
import "./objectives.css";

const OBJECTIVES_ENTRY_ID = "objectives";
export const OBJECTIVE_SURFACE_ID = "objectives";

const ObjectiveIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 4.5l1.2 1.2 2-2.4M2.5 8.5l1.2 1.2 2-2.4M2.5 12.5l1.2 1.2 2-2.4M8 4.5h5.5M8 8.5h5.5M8 12.5h3.5" />
  </svg>
);

/** 목표 상세는 레일 primary 한 자리에만 선다. */
export const objectivesPane: PaneDescriptor = {
  id: OBJECTIVE_SURFACE_ID,
  role: "primary",
  mounts: ["rail"],
  title: (ctx) => getT(ctx.language)("objectives.panel.title"),
  widthClass: "standard",
  // 모바일 목적지 화면에서는 호스트가 막대 창구(mobileBar)를 싣는다 — 그때만 폰의 목표 화면(목록 없이 착지한 목표 하나)이 선다.
  render: (ctx) => ctx.mobileBar
    ? <MobileObjectiveScreen ctx={ctx} />
    : <ObjectivePanel ctx={{ theaterId: ctx.theaterId, api: ctx.api, language: ctx.language, openLink: ctx.openLink, ...(ctx.sideBarVisible === undefined ? {} : { sideBarVisible: ctx.sideBarVisible }) }} />,
};

/**
 * 폰 대화 정보 화면의 「목표」 탭 본문 — 호스트가 `mobile.conversationPane` 으로 대화 주인 Operation(`params.operationId`)을 실어 세운다.
 * 데스크톱 보드는 이 페인을 열지 않는다.
 */
export const objectivesMobileDetailPane: PaneDescriptor = {
  id: OBJECTIVE_MOBILE_DETAIL_PANE,
  role: "detail",
  mounts: ["rail"],
  title: (ctx) => objectiveOfOperation(ctx.params.operationId ?? "")?.title ?? getT(ctx.language)("objectives.panel.title"),
  // 머리는 호스트의 정보 화면이 그린다 — 페인 캡션을 겹쳐 세우지 않는다.
  hideCaption: true,
  render: (ctx) => <MobileConversationObjective ctx={ctx} />,
};

export const objectivesEntry: RailEntryDescriptor = {
  id: OBJECTIVES_ENTRY_ID,
  title: (locale) => getT(locale)("objectives.panel.title"),
  icon: () => <ObjectiveIcon />,
  scope: "theater",
  // primary 가 맨 앞이어야 한다 — 레일 표면은 첫 primary 를 세운다. 상세는 폰 대화 정보 화면의 탭 본문이다.
  panes: [OBJECTIVE_SURFACE_ID, OBJECTIVE_MOBILE_DETAIL_PANE],
  activate: (ctx) => toggleObjectivePanel(ctx.rail),
  // 표면은 활성 Operation 의 목표로 열린다 — 입구를 누르는 순간 활성이 풀리면 따라갈 목표가 사라진다.
  keepsOperationActive: true,
  // 대화 중심 화면의 Operation 대화에서 도구 줄이 걷혀도 목표 입구는 「구성원」 곁 글자 단추 「목표」로 남는다.
  conversationTab: true,
  // 그 글자 단추는 목표가 있는 대화에서 상세의 오늘·기한(위 줄)과 세 탭(목표·구성원·결과물)으로 펼쳐진다. 구성원은 대상의 구성원 탭을 대신한다.
  conversationTabs: objectiveConversationTabs,
  // 사람의 차례 수(사람이 답할 결정 요청과 사령관이 넘긴 항목) — 표면을 닫아 두어도 아이콘 배지로 선다.
  // 대화 중심 화면에서는 레일 목표 상세가 결정 요청을 세우지 않으므로(가운데 대화의 카드가 받는다) 배지도 세우지 않는다.
  attention: {
    // 사령관 상태도 「확인 필요」 행의 메모(사령관이 답하는 중)를 바꾼다. 대화 배치가 바뀌면 배지 수도 다시 읽는다.
    subscribe: (listener) => {
      const offAttention = subscribeDecisionAttention(listener);
      const offLayout = subscribeCommodoreConversationActive(listener);
      return () => { offAttention(); offLayout(); };
    },
    count: (theaterId) => (isCommodoreConversationActive() ? 0 : personTurnCount(theaterId)),
    label: (count, locale) => getT(locale)("objectives.requests.badge", { count }),
    // 모바일 「확인 필요」 — 결정 요청마다 한 행, 누르면 그 목표의 대화 「목표」 탭(지휘관 Operation 이 없으면 목표 화면).
    items: decisionAttentionItems,
  },
  // 폰에는 목표 보드(목록)를 따로 두지 않는다 — 홈 칩 없이(`chip: false`) 목적지 화면만 남아 착지한 목표 하나를 세우고(시작 전 목표 등),
  // 목표의 내용·동작은 그 대화의 정보 화면 「목표」 탭이 받는다(`conversationPane`, 목표에 속한 대화에만 선다).
  // 아이콘은 시안 아이콘 한 벌(impl-spec §A)이다 — 「확인 필요」 행의 출처 표식에 쓴다. 데스크톱 레일 아이콘은 그대로.
  mobile: {
    destination: { order: 10, label: (locale) => getT(locale)("objectives.panel.title"), chip: false },
    conversationPane: { paneId: OBJECTIVE_MOBILE_DETAIL_PANE, tabs: objectiveMobileConversationTabs, shown: { subscribe: subscribeObjective, get: (operationId) => objectiveOfOperation(operationId) !== null } },
    // 홈 「완료 N」(접힘) — 끝난 목표. 시작 전 목표는 호스트가 묶음 줄(`row.glyph: "fresh"`)로 「시작 전 N」에 세운다.
    // 원천은 완료로 지휘관이 보관된 목표다 — 살아 있는 대화 행과 겹치지 않는다.
    finished: { subscribe: subscribeFinishedObjectives, items: finishedObjectiveItems },
    icon: () => <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r=".8" fill="currentColor" /></svg>,
  },
  search: async ({ query, theaterId, limit, language }) => {
    const api = objectivesApi();
    if (!api) return [];
    await loadTheater(api, theaterId);
    const response = await api.fetch("/objectives/palette-search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId, query, limit }) });
    if (!response.ok) return [];
    const result = await response.json() as { objectives: { id: string; title: string; done?: boolean }[] };
    const t = getT(language);
    const subtitle = t("objectives.palette.subtitle");
    // 완료로 지휘관이 보관된 목표는 복원하지 않고 가운데 칸의 완료 화면으로 연다 — 범위 넓히기는 그 화면의 입력창이 받는다.
    return result.objectives.map((objective) => ({
      id: `objectives:${objective.id}`, title: objective.title, subtitle: objective.done ? `${subtitle} · ${t("objectives.graph.state.done")}` : subtitle,
      activate: () => goToObjective(objective.id, theaterId, !!objective.done),
    }));
  },
};

export { commodoreBoard as objectivesCommodoreBoard } from "./board-commodore.js";

export function createObjectivesClient(commodore: CommodoreClientHost) {
  const install = (ctx: ObjectivesClientDeps): (() => void) => {
      const dispose = installObjectiveState(ctx);
      const disposeCommodore = installCommodoreHost(commodore);
      // 시작 전 목표의 시작 화면도 같은 능력으로 가운데 칸에 선다.
      const disposeFresh = connectFreshConversation(ctx.conversation);
      // 지휘관·구성원 메뉴는 Console 모델 로스터를 구독한다.
      const disposeRoster = installLaunchRoster(ctx.models);
      return () => { disposeRoster(); disposeFresh(); disposeCommodore(); dispose(); };

  };
  const surface: ClientFeatureDescriptor = {
    id: "objectives",

    railEntries: [objectivesEntry],
    onboarding: objectivesOnboarding,
    panes: [objectivesPane, objectivesMobileDetailPane],
    // 지휘관과 담당 Operation은 한 묶음이다 — 호스트는 이 서술자로 지휘관 패널의 구성원·임무 줄을 그린다.
    operationClusters: objectivesClusterSource,
    conversationSurfaces: [freshConversationSurface],
  };
  return { surface, install, operationSelected: handleMapOperationSelected };
}
