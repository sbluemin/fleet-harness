import type { ConsoleClientCapabilities } from "./client-capabilities.js";
import type { CommodoreClientHost } from "../../../../features/commodore/shared/contracts/client.js";
import { requestShellOpenAt, requestShellRestartAt } from "../../../../features/workspace/client/navigation-events.js";
import { getActiveShellKey } from "../../../../features/execution/client/terminal/shell/shell-session-store.js";
import { openTheaterInbox, setTheaterInboxContext } from "../../../../features/workspace/client/theater-inbox/store.js";
import { setMobileListTheaterId } from "../chrome/mobile/mobile-store.js";
import { getViewedTheaterId, subscribeViewedTheater } from "./viewed-theater.js";
import type { PaneTarget } from "../../../../features/workspace/shared/pane.js";
import type { ExpandedSurfaceOpenRequest } from "../../../../features/workspace/shared/expanded-surface.js";
import { conversationTabId, getMobileDestination, requestMobileConversationTab, setMobileDestination, setMobileTool } from "../chrome/mobile/mobile-store.js";
import { closeMobileObjective, readMobileObjectiveId } from "../chrome/mobile/mobile-objective-url.js";
import { landPaneTarget, type PaneTargetBinding, type PaneTargetPorts } from "../chrome/pane/pane-target.js";
import { openPane } from "../chrome/pane/pane-store.js";
import { getViewModeSnapshot, subscribeViewMode } from "./view-mode-store.js";
import { SETTINGS_PANE_ID } from "../../../../features/settings/client/settings-entry.js";
import { openSettingsSurface } from "../../../../features/settings/client/settings-door.js";
import { createClientCapabilities } from "./http-capabilities.js";
import type { ShellOpenAtResult } from "../../../../features/workspace/shared/navigation.js";

import { loadModelRoster, readModelRoster, refreshModelRoster, rosterModelOptions, subscribeModelRoster } from "../../../../features/ai-gateway/client/model-roster-store.js";
import { getGlobalSettingsStoreState, isSavingGlobalSettingsField, setGlobalSettingsField, subscribe as subscribeGlobalSettings } from "../../../../features/settings/client/global-settings-store.js";
import { applySearchParams, navigateConsoleRoute, subscribeConsoleLocation } from "./console-location.js";
import { closeExpandedSurface, closeExpandedSurfacesOf, isExpandedSurfaceShown, openExpandedSurface } from "../chrome/expanded-surface/store.js";
import { resolveObjectiveRuntimeActivity } from "../../../../features/execution/client/objective-activity.js";
import { AgentChatTranscript, AgentConversation, AgentDecisionCard, AgentLedger, ComposerTopEntries } from "../../../../features/execution/client/agent/index.js";
import { ledgerObjectiveId, openLedger, subscribeLedger } from "../../../../features/execution/client/agent/chat/group/index.js";
import { clearObjectiveStatusDetail, setObjectiveStatusDetail } from "../../../../features/execution/client/objective-marks.js";
import { subscribeConsoleChannel, subscribeConsoleReconnect } from "./objective-records-sse.js";
import { closeRailPanel, getRailStoreSnapshot, isRailPanelOpen, openRailPanel, subscribeRailStore } from "../chrome/rail/rail-store.js";
import { getArenaInsets, subscribeArenaInsets } from "../../../../features/workspace/client/conversation/arena-insets.js";
import { theaterInboxCapability } from "../../../../features/workspace/client/theater-inbox/store.js";
import { closeConversationSurface, getConversationSurface, openConversationSurface, subscribeConversationSurface, type ConversationSurfaceSelection } from "../../../../features/workspace/client/conversation/conversation-surface-store.js";
import { getConversationSubject, subscribeConversationSubject } from "../../../../features/workspace/client/conversation/conversation-slots.js";
import { openNewSessionComposer } from "../../../../features/workspace/client/conversation/new-session-entry.js";
import { attachComposerQuoteTo, composerQuoteTargets, receiveComposerQuotes, subscribeComposerQuoteTargets } from "./composer-quotes.js";
import { clearObjectiveRuntime, dismissNotificationsForObjective, focusObjective, getState, ownObjectiveRuntime,
  raiseObjectiveNotification, setObjectiveRuntime, setObjectiveRuntimeHydration, subscribe } from "./store.js";

function viewTheaterInbox(theaterId: string): void {
  if (!getState().theaters.some((theater) => theater.id === theaterId)) return;
  if (getViewModeSnapshot().effective === "mobile") {
    setMobileListTheaterId(theaterId);
    closeMobileObjective();
    setMobileDestination({ kind: "home" });
  }
  else {
    closeConversationSurface();
    openTheaterInbox({ theaterId, sectionId: "console:settings", pageId: "system-prompt" });
  }
  navigateConsoleRoute("/objectives");
}

export interface HostCapabilityDependencies {
  readonly commodore?: CommodoreClientHost;
  /**
   * 레일 바인딩. 함수를 주면 부를 때마다 지금의 목록을 읽는다 — 설치한 능력이 레일 목록이 바뀔 때마다(대화 중심 화면의 탭이
   * 서고 걷힐 때마다) 다시 만들어지지 않게, 앱은 함수로 넘긴다. 배열을 주면 그 시점의 목록으로 고정된다.
   */
  readonly railBindings: readonly PaneTargetBinding[] | (() => readonly PaneTargetBinding[]);
}

function revealRailPanel(entryId: string): void {
  openRailPanel(entryId);
  if (getViewModeSnapshot().effective === "mobile") {
    setMobileTool({ kind: "rail", id: entryId }, getViewedTheaterId());
    navigateConsoleRoute("/objectives");
  }
}

/**
 * 폰에서 엔트리의 대화 탭(`mobile.conversationPane`)으로 착지한다 — 그 대화를 열고 정보 화면의 그 탭을 세운다. `objectiveId`가 null이면
 * 지금 열린 대화(대화 화면·정보 화면이 서 있을 때)다. 대화가 없거나, 그 대화에 탭이 서지 않거나, 폰이 아니면 false — 부른 쪽이 기존 경로로 간다.
 */
function revealMobileConversationTab(binding: PaneTargetBinding | undefined, objectiveId: string | null): boolean {
  const pane = binding?.entry.mobile?.conversationPane;
  if (!binding || !pane || binding.entry.conversationTab !== true || getViewModeSnapshot().effective !== "mobile") return false;
  const destination = getMobileDestination().kind;
  const requested = objectiveId ?? (destination === "home" || destination === "info" ? readMobileObjectiveId() : null);
  if (requested === null) return false;
  // 구성원을 가리키면 대화 주인은 그 묶음의 부모다 — 정보 화면은 주인의 것이고, 포커스도 부모로 옮겨 간다.
  const state = getState();
  const owner = state.nestedObjectiveRecords.find((node) => node.id === requested)?.parentObjectiveId ?? requested;
  if (!state.objectiveRecords.some((objectiveRecord) => objectiveRecord.id === owner)) return false;
  if (pane.shown?.get(owner) === false) return false;
  const tab = conversationTabId(binding.entry.id);
  navigateConsoleRoute("/objectives");
  // 이미 열린 대화면 보던 본문(구성원)을 그대로 두고 정보 화면만 세운다.
  if (readMobileObjectiveId() === owner) {
    setMobileDestination({ kind: "info", tab });
    return true;
  }
  requestMobileConversationTab(owner, tab);
  focusObjective(owner);
  return true;
}

function revealExpandedSurface(request: ExpandedSurfaceOpenRequest): string {
  const instanceId = openExpandedSurface(request);
  if (getViewModeSnapshot().effective === "mobile") {
    setMobileTool({ kind: "surface", instanceId });
    navigateConsoleRoute("/objectives");
  }
  return instanceId;
}

export function createHostPaneTargetPorts(bindings: readonly PaneTargetBinding[]): PaneTargetPorts {
  return {
    bindings,
    activateTheater: (theaterId) => {
      if (!getState().theaters.some((theater) => theater.id === theaterId)) return false;
      if (getViewModeSnapshot().effective === "mobile") {
        viewTheaterInbox(theaterId);
      } else if (getViewedTheaterId() !== theaterId) {
        // 페인 착지는 Theater 설정을 여는 요청이 아니다. 같은 Theater면 대화를 그대로 두고,
        // 다른 Theater면 문맥만 바꿔 뒤따르는 Inbox 효과가 목표 페인을 덮지 않게 한다.
        closeConversationSurface();
        setTheaterInboxContext({ theaterId, address: { sectionId: "console:settings", pageId: "system-prompt" } });
      }
      return true;
    },
    openRail: revealRailPanel,
    openPane,
    openExpanded: revealExpandedSurface,
    requestId: () => crypto.randomUUID(),
    showTarget: (target) => {
      // 설정은 레일 페인이 아니라 설정의 문이다(데스크톱 모달, 폰 /settings) — 팔레트 검색 결과·플러그인의 설정 목표도 같은 문으로 든다.
      if (target.paneId === SETTINGS_PANE_ID) {
        if (getViewModeSnapshot().effective !== "mobile") navigateConsoleRoute("/objectives");
        openSettingsSurface(target.params?.section);
        return true;
      }
      if (getViewModeSnapshot().effective === "mobile") {
        const owner = bindings.find((binding) => binding.panes.some((pane) => pane.id === target.paneId));
        if (owner?.panes.find((pane) => pane.id === target.paneId)?.mounts.includes("rail")) {
          // 배치 전환 중에는 모바일 틀이 목적지 목록을 등록하기 전일 수 있다. 선언으로 화면을 열고, 마운트가 다시 읽을 params 도 함께 싣는다.
          if (owner.entry.mobile?.destination) {
            setMobileTool(null);
            openRailPanel(owner.entry.id);
            setMobileDestination({ kind: "plugin", entryId: owner.entry.id, ...(target.params ? { params: target.params } : {}) });
            navigateConsoleRoute("/objectives");
          } else revealRailPanel(owner.entry.id);
          openPane({ paneId: target.paneId, params: target.params, mount: "rail" });
          return true;
        }
      }
      navigateConsoleRoute("/objectives");
      return false;
    },
  };
}

// Shell 배치 요청이 성공했을 때만 작업 화면으로 돌아가 Shell 표면을 연다.
function revealShellOnSuccess(result: ShellOpenAtResult): ShellOpenAtResult {
  if (result.ok) {
    navigateConsoleRoute("/objectives");
    revealExpandedSurface({ surfaceId: "shell" });
  }
  return result;
}

// 능력의 current() 는 같은 대화면 같은 참조를 돌려준다(useSyncExternalStore) — 선택 객체마다 한 번만 만든다.
const publicSurfaces = new WeakMap<ConversationSurfaceSelection, { readonly surfaceId: string; readonly params: Readonly<Record<string, unknown>> }>();
function publicSurface(selection: ConversationSurfaceSelection | null) {
  if (selection === null) return null;
  let view = publicSurfaces.get(selection);
  if (!view) {
    view = { surfaceId: selection.surfaceId, params: selection.params };
    publicSurfaces.set(selection, view);
  }
  return view;
}

export function createHostCapabilities(
  resync: () => void = () => undefined,
  dependencies: HostCapabilityDependencies = { railBindings: [] },
): ConsoleClientCapabilities {
  const base = createClientCapabilities(resync);
  const source = dependencies.railBindings;
  const readBindings = (): readonly PaneTargetBinding[] => (typeof source === "function" ? source() : source);
  const land = (target: PaneTarget) => landPaneTarget(target, createHostPaneTargetPorts(readBindings()));
  const capabilities: ConsoleClientCapabilities = {
    ...base,
    objectiveRecords: {
      ...base.objectiveRecords,
      // 플러그인의 「이 Objective 으로」는 검색·알림과 같은 이동 요청이다 — 대화 화면이 그 Objective 을 가운데에 세운다.
      // 확대 도구는 focusObjective이 접어 대화를 드러낸다 — 도구 자체는 같은 자리에 남는다.
      focus: (objectiveId) => focusObjective(objectiveId),
    },
    notifications: {
      emit: (notification) => raiseObjectiveNotification(notification),
      dismiss: (objectiveId) => dismissNotificationsForObjective(objectiveId),
    },
    // 실험 설정은 코어 general 설정의 한 항목이다 — 플러그인은 스토어 스냅샷에서 읽고 같은 구독으로 깨어난다.
    experiments: {
      read: () => getGlobalSettingsStoreState().state?.experiments ?? null,
      subscribe: (listener) => subscribeGlobalSettings(listener),
      update: (next) => setGlobalSettingsField("experiments", next),
      saving: () => isSavingGlobalSettingsField("experiments"),
      modelOptions: async () => rosterModelOptions(await loadModelRoster("agent")),
    },
    // 모델 로스터 — Settings › AI Gateway에서 켠 모델. 모든 모델 선택지가 이 캐시 하나를 읽는다.
    models: {
      read: (target) => readModelRoster(target),
      load: (target) => loadModelRoster(target),
      subscribe: (listener) => subscribeModelRoster(listener),
      refresh: () => refreshModelRoster(),
    },
    runtime: {
      set: (objectiveId, runtimeState) => setObjectiveRuntime(objectiveId, runtimeState),
      clear: (objectiveId) => clearObjectiveRuntime(objectiveId),
      setHydration: (hydration, error) => setObjectiveRuntimeHydration(hydration, error),
    },
    statusDetail: {
      set: (objectiveId, detail) => setObjectiveStatusDetail(objectiveId, detail),
      clear: (objectiveId) => clearObjectiveStatusDetail(objectiveId),
    },
    consoleState: {
      getTheaters: () => getState().theaters.map((theater) => ({ id: theater.id, label: theater.label, ...(theater.alias ? { alias: theater.alias } : {}) })),
      // 기본은 사이드바와 같은 목록(구성원 제외)이다 — 부관단처럼 목록을 읽는 플러그인이 따로 거르지 않아도 된다.
      // 구성원을 거느리는 플러그인(목표)만 nested 로 부모와 함께 읽는다.
      // nested 읽기의 부모 요약은 끌어올리기 전 자기 활동(ownActivity)도 싣는다 — 같은 규칙(resolveObjectiveRuntimeActivity)을 원 런타임에 쓴다.
      // 활동은 표시 어휘가 아니라 원시 값이다(background 를 접지 않는다) — 플러그인 계약이고, 접는 것은 각 표면의 표시 몫이다.
      getObjectiveRecords: (options) => {
        const snapshot = getState();
        const nested = options?.nested === true;
        const objectiveRecords = nested ? [...snapshot.objectiveRecords, ...snapshot.nestedObjectiveRecords] : snapshot.objectiveRecords;
        const parents = nested ? new Set(snapshot.nestedObjectiveRecords.map((objectiveRecord) => objectiveRecord.parentObjectiveId)) : null;
        const own = parents && parents.size > 0 ? ownObjectiveRuntime() : null;
        return objectiveRecords.map((objectiveRecord) => ({
          id: objectiveRecord.id,
          theaterId: objectiveRecord.theaterId,
          type: "agent",
          title: objectiveRecord.title,
          activity: resolveObjectiveRuntimeActivity(objectiveRecord, snapshot.objectiveRecordRuntime),
          ...(nested && objectiveRecord.parentObjectiveId ? { parentObjectiveId: objectiveRecord.parentObjectiveId } : {}),
          ...(own && parents!.has(objectiveRecord.id) ? { ownActivity: resolveObjectiveRuntimeActivity(objectiveRecord, own) } : {}),
        }));
      },
      getActiveTheaterId: getViewedTheaterId,
      getViewedTheaterId,
      viewTheater: viewTheaterInbox,
      getActiveObjectiveId: () => getState().activeObjectiveId,
      getConnection: () => getState().connection,
      getObjectiveRuntimeHydration: () => getState().objectiveRecordRuntimeHydration,
      getSelectedObjectiveId: () => getState().selectedObjectiveId,
      setActiveTheater: viewTheaterInbox,
      subscribe: subscribeViewedTheater,
      // 확정 인셋은 아레나 스토어에서, 레일을 끄는 동안의 차이는 레일 스토어에서 — 캔버스가 --arena-right 를 따라가는 것과 같은 셈.
      getMapInsets: () => {
        const settled = getArenaInsets();
        const { railOccupiedPx, railSettledPx } = getRailStoreSnapshot();
        return { left: settled.left, right: Math.max(0, settled.right + railOccupiedPx - railSettledPx) };
      },
      subscribeMapInsets: (listener) => {
        const offRail = subscribeRailStore(listener);
        const offArena = subscribeArenaInsets(listener);
        return () => { offRail(); offArena(); };
      },
    },
    navigate: {
      openFile: async (request) => {
        const binding = readBindings().find((item) => item.entry.handles?.openFile);
        const handler = binding?.entry.handles?.openFile;
        if (!handler) return { ok: false, reason: "no_handler" };
        if (!getState().theaters.some((theater) => theater.id === request.theaterId)) return { ok: false, reason: "not_found" };
        const target = await handler(request, capabilities);
        if ("ok" in target) {
          if (target.ok) capabilities.rail.open(binding!.entry.id);
          return target;
        }
        return land({ ...target, theaterId: request.theaterId, params: {
          theaterId: request.theaterId, path: request.path, pathKind: request.pathKind,
          ...(request.line === undefined ? {} : { line: String(request.line) }),
          ...(request.column === undefined ? {} : { column: String(request.column) }),
          ...target.params,
        } });
      },
      openWikiEntry: async (request) => {
        const binding = readBindings().find((item) => item.entry.handles?.openWikiEntry);
        const handler = binding?.entry.handles?.openWikiEntry;
        if (!handler) return { ok: false, reason: "no_handler" };
        if (!getState().theaters.some((theater) => theater.id === request.theaterId)) return { ok: false, reason: "not_found" };
        const result = await handler(request, capabilities);
        if (result && !result.ok) return result;
        viewTheaterInbox(request.theaterId);
        capabilities.rail.open(binding!.entry.id);
        navigateConsoleRoute("/objectives");
        return { ok: true };
      },
    },
    shell: {
      // 옮기는 것은 지금 보이는 대화의 Shell 이다(대화마다 하나) — 대화 칸이 알린 키를 싣는다.
      openAt: async (request) => revealShellOnSuccess(await requestShellOpenAt(request, { shell: getActiveShellKey() })),
      restartAt: async (request) => revealShellOnSuccess(await requestShellRestartAt(request, { shell: getActiveShellKey() })),
    },
    navigation: {
      getSearchParam: (key) => new URLSearchParams(window.location.search).get(key),
      setSearchParams: (next, options) => applySearchParams(next, options?.replace === true),
      // popstate만으로는 앱 내부 navigate를 못 듣는다 — 코어가 자기 이동도 알린다.
      subscribe: (listener) => subscribeConsoleLocation(listener),
    },
    surfaces: {
      // 폰에서 대화 탭을 선언한 엔트리의 확대 표면은 지금 열린 대화의 그 탭으로 선다(`RailEntryMobile.conversationPane`).
      open: (request) => (revealMobileConversationTab(readBindings().find((binding) => binding.entry.surfaceId === request.surfaceId), null) ? "" : revealExpandedSurface(request)),
      close: (instanceId) => closeExpandedSurface(instanceId),
      closeSurface: (surfaceId) => closeExpandedSurfacesOf(surfaceId),
      isOpen: (surfaceId) => isExpandedSurfaceShown(surfaceId),
    },
    rail: {
      open: (panelId, params) => {
        const binding = readBindings().find((item) => item.entry.id === panelId);
        // 폰에서 대화를 가리킨 열기는 그 대화 정보 화면의 탭으로 선다(`RailEntryMobile.conversationPane`).
        if (params?.objectiveId && revealMobileConversationTab(binding, params.objectiveId)) return;
        const primary = binding?.panes.find((pane) => pane.role === "primary");
        if (params && primary) land({ paneId: primary.id, params });
        else revealRailPanel(panelId);
      },
      close: (panelId) => {
        // 폰에서 지금 보이는 목적지 화면을 그 엔트리가 닫으면(보던 대상이 사라짐 등) 빈 화면 대신 홈으로 돌아간다.
        const destination = getMobileDestination();
        if (getViewModeSnapshot().effective === "mobile" && destination.kind === "plugin" && destination.entryId === panelId) setMobileDestination({ kind: "home" });
        closeRailPanel(panelId);
      },
      isOpen: (panelId) => isRailPanelOpen(panelId),
    },
    consoleEvents: {
      subscribe: (channel, onEvent) => subscribeConsoleChannel(channel, onEvent),
      onReconnect: (listener) => subscribeConsoleReconnect(listener),
    },
    chat: { Transcript: AgentChatTranscript, Conversation: AgentConversation, DecisionCard: AgentDecisionCard, Ledger: AgentLedger, ComposerTopEntries },
    theaterInbox: theaterInboxCapability,
    // 대화 중심 화면 — 켜짐 여부와 가운데 칸의 플러그인 대화. 꺼져 있으면 open 은 아무것도 세우지 않는다.
    conversation: {
      isActive: () => (getViewModeSnapshot().effective === "desktop"),
      subscribe: (listener) => {
        const disposeLayout = subscribeViewMode(listener);
        const disposeSurface = subscribeConversationSurface(listener);
        const disposeSubject = subscribeConversationSubject(listener);
        return () => { disposeLayout(); disposeSurface(); disposeSubject(); };
      },
      open: (surfaceId, params) => {
        const opened = openConversationSurface(surfaceId, params);
        if (opened) navigateConsoleRoute("/objectives");
        return opened;
      },
      close: (surfaceId) => closeConversationSurface(surfaceId),
      current: () => publicSurface(getConversationSurface()),
      // 대화 중심 화면의 셸과 모바일 셸이 같은 자리(conversation-slots)에 지금 선 대화의 주인을 싣는다.
      subjectObjectiveId: () => getConversationSubject()?.id ?? null,
      ledgerObjectiveId: (rootObjectiveId) => ledgerObjectiveId(rootObjectiveId),
      openLedger: (rootObjectiveId, objectiveId) => openLedger(rootObjectiveId, objectiveId),
      subscribeLedger: (listener) => subscribeLedger(listener),
    },
    composer: {
      open: (options) => openNewSessionComposer(options),
      attachQuote: (target, quote) => attachComposerQuoteTo(target, quote),
      quoteTargets: (theaterId) => composerQuoteTargets(theaterId),
      subscribeQuoteTargets: (listener) => subscribeComposerQuoteTargets(listener),
      receiveQuotes: (pluginId, receiver) => receiveComposerQuotes(pluginId, receiver),
    },
  };
  return capabilities;
}
