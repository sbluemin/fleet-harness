import { definePlugin } from "@fleet-console/sdk/plugin/browser";
import type { ExpandedSurfaceContext, ExpandedSurfaceDescriptor } from "@fleet-console/sdk/expanded-surface";
import type { PaneDescriptor } from "@fleet-console/sdk/pane";
import type { RailEntryDescriptor } from "@fleet-console/sdk/rail";

import { objectivesArchiveSections } from "./archive.js";
import { objectivesClusterSource } from "./clusters.js";
import { commodoreInboxSection } from "./commodore-inbox-section.js";
import { COMMODORE_MOBILE_PANE, commodoreDestinationTrailing, MobileCommodore, PennantIcon } from "./commodore-mobile.js";
import { commodoreTheaterContribution } from "./commodore-header.js";
import { commodoreMentionTargets, messageCommodoreMention } from "./commodore-mention.js";
import { installLaunchRoster } from "./launch-control.js";
import { COMMODORE_ENTRY_ID, commodoreDestinationShown, installCommodoreState, noteCommodoreLanguage, subscribeCommodoreMentions } from "./commodore-state.js";
import { commodoreConversationSurface, connectCommodoreConversation } from "./commodore-conversation.js";
import { getT } from "./i18n/index.js";
import { decisionAttentionItems, MobileObjectiveDetail, MobileObjectiveList, OBJECTIVE_MOBILE_DETAIL_PANE, subscribeDecisionAttention } from "./mobile.js";
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
    // 사령관 상태도 「확인 필요」 행의 메모(사령관이 답하는 중)를 바꾼다.
    subscribe: subscribeDecisionAttention,
    count: pendingDecisionCount,
    label: (count, locale) => getT(locale)("objectives.requests.badge", { count }),
    // 모바일 「확인 필요」 — 결정 요청마다 한 행, 누르면 그 목표 상세.
    items: decisionAttentionItems,
  },
  // 모바일 드로어의 고정 목적지 — Theater 다음, 파일·위키 위.
  // 모바일 드로어·「플러그인」 화면의 아이콘 — 시안 아이콘 한 벌(impl-spec §A)이다. 데스크톱 레일 아이콘은 그대로.
  mobile: { destination: { order: 10, label: (locale) => getT(locale)("objectives.panel.title") }, icon: () => <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r=".8" fill="currentColor" /></svg> },
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

/** 모바일 사령관 화면 — 드로어 목적지 「사령관」의 본문. 데스크톱은 사이드바 줄과 「사령관 기록」 시트를 그대로 쓴다. */
export const commodoreMobilePane: PaneDescriptor = {
  id: COMMODORE_MOBILE_PANE,
  role: "primary",
  mounts: ["rail"],
  title: (ctx) => getT(ctx.language)("objectives.commodore.name"),
  hideCaption: true,
  render: (ctx) => ctx.mobileBar ? <MobileCommodore ctx={ctx} /> : null,
};

/**
 * 폰 전용 엔트리 — 실험 기능 「자율 운영」이 켜져 있을 때만 드로어 「목표」 위에 「사령관」 목적지로 선다.
 * 데스크톱 레일·팔레트에는 오르지 않는다(`mobile.desktop: false`).
 */
export const commodoreEntry: RailEntryDescriptor = {
  id: COMMODORE_ENTRY_ID,
  title: (locale) => getT(locale)("objectives.commodore.name"),
  icon: () => <PennantIcon />,
  scope: "theater",
  panes: [COMMODORE_MOBILE_PANE],
  // 드로어 「목표」(order 10) 위. 줄 오른쪽 칸은 자율 운영 루프의 상태(S-53 CM-1c)다.
  mobile: { desktop: false, destination: { order: 5, shown: commodoreDestinationShown, trailing: commodoreDestinationTrailing }, icon: () => <PennantIcon /> },
};

const objectivesPlugin = definePlugin({
  id: "objectives",
  install: (ctx) => {
    const dispose = installObjectiveState(ctx);
    const disposeCommodore = installCommodoreState(ctx);
    // 대화 중심 화면(Console 실험 기능)이 서 있으면 Theater 머리·Inbox 의 사령관 기록 요청이 가운데 칸에 사령관 대화를 연다.
    const disposeConversation = connectCommodoreConversation(ctx.conversation, ctx.theaterInbox);
    // 지휘관·구성원 메뉴는 Console 모델 로스터를 구독한다.
    const disposeRoster = installLaunchRoster(ctx.models);
    const theaterId = activeTheaterId();
    if (theaterId) void loadTheater(ctx.api, theaterId);
    return () => { disposeRoster(); disposeConversation(); disposeCommodore(); dispose(); };
  },
  onMapOperationSelected: handleMapOperationSelected,
  railEntries: [objectivesEntry, commodoreEntry],
  onboarding: objectivesOnboarding,
  panes: [objectivesPane, objectivesMobileDetailPane, commodoreMobilePane],
  expandedSurfaces: [objectivesSurface],
  // 지휘관과 담당 Operation은 한 묶음이다 — 호스트는 이 서술자로 지휘관 패널의 구성원·임무 줄을 그린다.
  operationClusters: objectivesClusterSource,
  // 끝난 목표와 정리된 목표는 사이드바 트리가 아니라 보관함에 선다.
  archiveSections: objectivesArchiveSections,
  // 사령관(자율 운영) — Theater 머리의 글리프(켬 brass·끔 회색)·턴 물결·머리를 누르면 여는 칸·우클릭 메뉴의 켜기/끄기. 실험 기능이 꺼져 있으면 빌려 주지 않는다.
  theaterContributions: [commodoreTheaterContribution],
  // Quick Launch '@' — 지금 Theater 의 사령관(자율 운영이 실제로 돌 때만)에게 사령관 기록 입력과 같은 경로로 보낸다.
  mentionTargets: commodoreMentionTargets,
  subscribeMentionTargets: subscribeCommodoreMentions,
  messageMentionTarget: messageCommodoreMention,
  // 사령관 — Theater Inbox 의 섹션(기록·지시·정보·설정). 시트 틀은 호스트가 그린다.
  theaterInboxSections: [commodoreInboxSection],
  // 상주 기여라 머리 글리프·Inbox 가 닫혀 있어도 언어를 알린다 — 리액트 밖의 Quick Launch '@' 행이 이 값으로 문구를 고른다.
  persistentComponents: [{ id: "commodore-language", render: ({ language }) => { if (language) noteCommodoreLanguage(language); return null; } }],
  // 대화 중심 화면에서는 같은 사령관이 Inbox 시트 대신 가운데 칸(기록)과 오른쪽 패널(행위 기록·지시·정보·설정)에 선다.
  conversationSurfaces: [commodoreConversationSurface],
});

export const plugins = [objectivesPlugin] as const;
