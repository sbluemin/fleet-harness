import { definePlugin } from "@fleet-console/sdk/plugin/browser";
import type { ExpandedSurfaceContext, ExpandedSurfaceDescriptor } from "@fleet-console/sdk/expanded-surface";
import type { PaneDescriptor } from "@fleet-console/sdk/pane";
import type { RailEntryDescriptor } from "@fleet-console/sdk/rail";

import { objectivesArchiveSections } from "./archive.js";
import { objectivesClusterSource } from "./clusters.js";
import { CommodoreDrawerHost } from "./commodore-drawer.js";
import { CommodoreMenuItem, CommodoreRow } from "./commodore-row.js";
import { commodoreMentionTargets, messageCommodoreMention } from "./commodore-mention.js";
import { installCommodoreState, subscribeCommodoreMentions } from "./commodore-state.js";
import { getT } from "./i18n/index.js";
import { decisionAttentionItems, MobileObjectiveDetail, MobileObjectiveList, OBJECTIVE_MOBILE_DETAIL_PANE } from "./mobile.js";
import { ObjectivePanel } from "./objectives-panel.js";
import { objectivesOnboarding } from "./onboarding.js";
import { activeTheaterId, handleMapOperationSelected, installObjectiveState, loadTheater, onObjectiveSurfaceClose, pendingDecisionCount, readAllTheaters, revealObjective, objectivesApi, subscribeObjective, toggleObjectivePlace } from "./objectives-state.js";
import "./objectives.css";

export const OBJECTIVE_SURFACE_ID = "objectives";

const ObjectiveIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 4.5l1.2 1.2 2-2.4M2.5 8.5l1.2 1.2 2-2.4M2.5 12.5l1.2 1.2 2-2.4M8 4.5h5.5M8 8.5h5.5M8 12.5h3.5" />
  </svg>
);

/** 같은 본문을 레일 primary와 기존 전용 확장 표면에 각각 세운다. */
export const objectivesPane: PaneDescriptor = {
  id: OBJECTIVE_SURFACE_ID,
  role: "primary",
  mounts: ["rail"],
  title: (ctx) => getT(ctx.language)("objectives.panel.title"),
  widthClass: "standard",
  // 모바일 목적지 화면에서는 호스트가 막대 창구(mobileBar)를 싣는다 — 그때만 모바일 목록이 선다.
  render: (ctx) => ctx.mobileBar
    ? <MobileObjectiveList ctx={ctx} />
    : <ObjectivePanel ctx={{ theaterId: ctx.theaterId, api: ctx.api, language: ctx.language, place: "rail", openLink: ctx.openLink, ...(ctx.sideBarVisible === undefined ? {} : { sideBarVisible: ctx.sideBarVisible }) }} />,
};

/** 모바일 목표 상세 — 모바일 목록이 `panes.open`으로만 연다. 데스크톱 보드는 이 페인을 열지 않는다. */
export const objectivesMobileDetailPane: PaneDescriptor = {
  id: OBJECTIVE_MOBILE_DETAIL_PANE,
  role: "detail",
  mounts: ["rail"],
  title: (ctx) => readAllTheaters().flatMap((state) => state.objectives).find((objective) => objective.id === ctx.params.objectiveId)?.title ?? getT(ctx.language)("objectives.panel.title"),
  // 막대는 모바일 호스트가 그린다 — 페인 캡션을 겹쳐 세우지 않는다.
  hideCaption: true,
  render: (ctx) => <MobileObjectiveDetail ctx={ctx} />,
};

export const objectivesSurface: ExpandedSurfaceDescriptor = {
  id: OBJECTIVE_SURFACE_ID,
  title: (ctx) => getT(ctx.language ?? "en")("objectives.panel.title"),
  minPaneWidth: 560,
  // 레일 아이콘이 여닫으므로 호스트의 부유 닫기는 중복이다.
  ownsClose: true,
  onClose: onObjectiveSurfaceClose,
  render: (ctx: ExpandedSurfaceContext) => <ObjectivePanel ctx={{ theaterId: ctx.theaterId, api: ctx.api, language: ctx.language, place: "expanded", openLink: ctx.openLink, ...(ctx.sideBarVisible === undefined ? {} : { sideBarVisible: ctx.sideBarVisible }) }} />,
};

export const objectivesEntry: RailEntryDescriptor = {
  id: "objectives",
  title: (locale) => getT(locale)("objectives.panel.title"),
  icon: () => <ObjectiveIcon />,
  scope: "theater",
  // primary 가 맨 앞이어야 한다 — 레일 표면은 첫 primary 를 세운다. 상세는 모바일 목록만 연다.
  panes: [OBJECTIVE_SURFACE_ID, OBJECTIVE_MOBILE_DETAIL_PANE],
  surfaceId: OBJECTIVE_SURFACE_ID,
  activate: (ctx) => toggleObjectivePlace(ctx.rail, ctx.surfaces),
  // 표면은 활성 Operation 의 목표로 열린다 — 입구를 누르는 순간 활성이 풀리면 따라갈 목표가 사라진다.
  keepsOperationActive: true,
  // 사람의 답을 기다리는 결정 요청 수 — 표면을 닫아 두어도 아이콘 배지로 선다.
  attention: {
    subscribe: subscribeObjective,
    count: pendingDecisionCount,
    label: (count, locale) => getT(locale)("objectives.requests.badge", { count }),
    // 모바일 「확인 필요」 — 결정 요청마다 한 행, 누르면 그 목표 상세.
    items: decisionAttentionItems,
  },
  // 모바일 드로어의 고정 목적지 — Theater 다음, 파일·위키 위.
  mobile: { destination: { order: 10 } },
  search: async ({ query, theaterId, limit, language }) => {
    const api = objectivesApi();
    if (!api) return [];
    await loadTheater(api, theaterId);
    const response = await api.fetch("objectives", "/palette-search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theaterId, query, limit }) });
    if (!response.ok) return [];
    const result = await response.json() as { objectives: { id: string; title: string }[] };
    const subtitle = getT(language)("objectives.palette.subtitle");
    return result.objectives.map((objective) => ({ id: `objectives:${objective.id}`, title: objective.title, subtitle, activate: () => { revealObjective({ objectiveId: objective.id }); } }));
  },
};

const objectivesPlugin = definePlugin({
  id: "objectives",
  install: (ctx) => {
    const dispose = installObjectiveState(ctx);
    const disposeCommodore = installCommodoreState(ctx);
    const theaterId = activeTheaterId();
    if (theaterId) void loadTheater(ctx.api, theaterId);
    return () => { disposeCommodore(); dispose(); };
  },
  onMapOperationSelected: handleMapOperationSelected,
  railEntries: [objectivesEntry],
  onboarding: objectivesOnboarding,
  panes: [objectivesPane, objectivesMobileDetailPane],
  expandedSurfaces: [objectivesSurface],
  // 지휘관과 담당 Operation은 한 묶음이다 — 호스트는 이 서술자로 지휘관 패널의 구성원·임무 줄을 그린다.
  operationClusters: objectivesClusterSource,
  // 끝난 목표와 정리된 목표는 사이드바 트리가 아니라 보관함에 선다.
  archiveSections: objectivesArchiveSections,
  // 사령관(자율 운영) — Theater 머리 아래 줄과 「…」 메뉴의 「사령관 지시…」. 실험 기능이 꺼져 있으면 둘 다 그리지 않는다.
  theaterContributions: [{ id: "commodore", row: (context) => <CommodoreRow {...context} />, menu: (context) => <CommodoreMenuItem {...context} /> }],
  // Quick Launch '@' — 지금 Theater 의 사령관(자율 운영이 실제로 돌 때만)에게 사령관 기록 입력과 같은 경로로 보낸다.
  mentionTargets: commodoreMentionTargets,
  subscribeMentionTargets: subscribeCommodoreMentions,
  messageMentionTarget: messageCommodoreMention,
  // 「사령관 기록」 서랍은 줄이 접혀 사라져도 열린 채로 남는다.
  persistentComponents: [{ id: "commodore-drawer", render: (context) => <CommodoreDrawerHost {...context} /> }],
});

export const plugins = [objectivesPlugin] as const;
