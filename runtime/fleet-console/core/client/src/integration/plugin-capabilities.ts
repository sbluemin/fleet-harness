import { openTheaterInbox } from "../../../../features/workspace/client/theater-inbox/store.js";
import { setMobileListTheaterId } from "../chrome/mobile/mobile-store.js";
import { getViewedTheaterId, subscribeViewedTheater } from "./viewed-theater.js";
import type { PaneTarget } from "@fleet-console/sdk/pane";
import type { ExpandedSurfaceOpenRequest } from "@fleet-console/sdk/expanded-surface";
import { conversationTabId, getMobileDestination, requestMobileConversationTab, setMobileDestination, setMobileTool } from "../chrome/mobile/mobile-store.js";
import { closeMobileOperation, readMobileOperationId } from "../chrome/mobile/mobile-operation-url.js";
import { landPaneTarget, type PaneTargetBinding, type PaneTargetPorts } from "../chrome/pane/pane-target.js";
import { openPane } from "../chrome/pane/pane-store.js";
import { getViewModeSnapshot, subscribeViewMode } from "./view-mode-store.js";
import { SETTINGS_PANE_ID } from "../../../../features/settings/client/settings-entry.js";
import { openSettingsSurface } from "../../../../features/settings/client/settings-door.js";
import { createClientCapabilities } from "@fleet-console/sdk/plugin/browser";
import type { PluginInstallContext } from "@fleet-console/sdk/plugin";
import type { ShellOpenAtResult } from "@fleet-console/sdk/navigation";

import { loadModelRoster, readModelRoster, refreshModelRoster, rosterModelOptions, subscribeModelRoster } from "../../../../features/ai-gateway/client/model-roster-store.js";
import { getGlobalSettingsStoreState, isSavingGlobalSettingsField, setGlobalSettingsField, subscribe as subscribeGlobalSettings } from "../../../../features/settings/client/global-settings-store.js";
import { applySearchParams, navigateConsoleRoute, subscribeConsoleLocation } from "./console-location.js";
import { closeExpandedSurface, closeExpandedSurfacesOf, getExpandedSurfaceState, openExpandedSurface } from "../chrome/expanded-surface/store.js";
import { resolveOperationRuntimeActivity } from "../../../../features/execution/client/operation-activity.js";
import { AgentChatTranscript, AgentConversation } from "../../../../features/execution/client/agent/index.js";
import { ledgerOperationId, openLedger, subscribeLedger } from "../../../../features/execution/client/agent/chat/group/index.js";
import { clearOperationStatusDetail, setOperationStatusDetail } from "../../../../features/execution/client/operation-marks.js";
import { subscribeConsoleChannel, subscribeConsoleReconnect } from "./operations-sse.js";
import { closeRailPanel, getRailStoreSnapshot, openRailPanel, subscribeRailStore } from "../chrome/rail/rail-store.js";
import { getArenaInsets, subscribeArenaInsets } from "../../../../features/workspace/client/conversation/arena-insets.js";
import { theaterInboxCapability } from "../../../../features/workspace/client/theater-inbox/store.js";
import { closeConversationSurface, getConversationSurface, openConversationSurface, subscribeConversationSurface, type ConversationSurfaceSelection } from "../../../../features/workspace/client/conversation/conversation-surface-store.js";
import { getConversationSubject, subscribeConversationSubject } from "../../../../features/workspace/client/conversation/conversation-slots.js";
import { clearOperationRuntime, dismissNotificationsForOperation, focusOperation, getState, openQuickLaunch, openQuickLaunchForOperation, openQuickLaunchForPluginTarget, ownOperationRuntime,
  openQuickLaunchWithDraft, raiseOperationNotification, setOperationRuntime, setOperationRuntimeHydration, subscribe } from "./store.js";

function viewTheaterInbox(theaterId: string): void {
  if (!getState().theaters.some((theater) => theater.id === theaterId)) return;
  if (getViewModeSnapshot().effective === "mobile") {
    setMobileListTheaterId(theaterId);
    closeMobileOperation();
    setMobileDestination({ kind: "home" });
  }
  else {
    closeConversationSurface();
    openTheaterInbox({ theaterId, sectionId: "console:settings", pageId: "system-prompt" });
  }
  navigateConsoleRoute("/operations");
}

export interface HostCapabilityDependencies {
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
    navigateConsoleRoute("/operations");
  }
}

/**
 * 폰에서 엔트리의 대화 탭(`mobile.conversationPane`)으로 착지한다 — 그 대화를 열고 정보 화면의 그 탭을 세운다. `operationId`가 null이면
 * 지금 열린 대화(대화 화면·정보 화면이 서 있을 때)다. 대화가 없거나, 그 대화에 탭이 서지 않거나, 폰이 아니면 false — 부른 쪽이 기존 경로로 간다.
 */
function revealMobileConversationTab(binding: PaneTargetBinding | undefined, operationId: string | null): boolean {
  const pane = binding?.entry.mobile?.conversationPane;
  if (!binding || !pane || binding.entry.conversationTab !== true || getViewModeSnapshot().effective !== "mobile") return false;
  const destination = getMobileDestination().kind;
  const requested = operationId ?? (destination === "home" || destination === "info" ? readMobileOperationId() : null);
  if (requested === null) return false;
  // 구성원을 가리키면 대화 주인은 그 묶음의 부모다 — 정보 화면은 주인의 것이고, 포커스도 부모로 옮겨 간다.
  const state = getState();
  const owner = state.nestedOperations.find((node) => node.id === requested)?.parentOperationId ?? requested;
  if (!state.operations.some((operation) => operation.id === owner)) return false;
  if (pane.shown?.get(owner) === false) return false;
  const tab = conversationTabId(binding.entry.id);
  navigateConsoleRoute("/operations");
  // 이미 열린 대화면 보던 본문(구성원)을 그대로 두고 정보 화면만 세운다.
  if (readMobileOperationId() === owner) {
    setMobileDestination({ kind: "info", tab });
    return true;
  }
  requestMobileConversationTab(owner, tab);
  focusOperation(owner);
  return true;
}

function revealExpandedSurface(request: ExpandedSurfaceOpenRequest): string {
  const instanceId = openExpandedSurface(request);
  if (getViewModeSnapshot().effective === "mobile") {
    setMobileTool({ kind: "surface", instanceId });
    navigateConsoleRoute("/operations");
  }
  return instanceId;
}

export function createHostPaneTargetPorts(bindings: readonly PaneTargetBinding[]): PaneTargetPorts {
  return {
    bindings,
    activateTheater: (theaterId) => {
      if (!getState().theaters.some((theater) => theater.id === theaterId)) return false;
      viewTheaterInbox(theaterId);
      return true;
    },
    openRail: revealRailPanel,
    openPane,
    openExpanded: revealExpandedSurface,
    requestId: () => crypto.randomUUID(),
    showTarget: (target) => {
      if (getViewModeSnapshot().effective === "mobile" && target.paneId === SETTINGS_PANE_ID) {
        const section = target.params?.section;
        navigateConsoleRoute("/settings", section === undefined ? "" : `?section=${encodeURIComponent(section)}`);
        return true;
      }
      // 대화 중심 화면의 설정은 레일 페인이 아니라 가운데 모달이다 — 팔레트 검색 결과·플러그인의 설정 목표도 같은 문으로 든다.
      if (target.paneId === SETTINGS_PANE_ID && (getViewModeSnapshot().effective === "desktop")) {
        navigateConsoleRoute("/operations");
        openSettingsSurface(target.params?.section);
        return true;
      }
      if (getViewModeSnapshot().effective === "mobile") {
        const owner = bindings.find((binding) => binding.panes.some((pane) => pane.id === target.paneId));
        if (owner?.panes.find((pane) => pane.id === target.paneId)?.mounts.includes("rail")) {
          revealRailPanel(owner.entry.id);
          openPane({ paneId: target.paneId, params: target.params, mount: "rail" });
          return true;
        }
      }
      navigateConsoleRoute("/operations");
      return false;
    },
  };
}

// Shell 배치 요청이 성공했을 때만 작업 화면으로 돌아가 Shell 표면을 연다.
function revealShellOnSuccess(result: ShellOpenAtResult): ShellOpenAtResult {
  if (result.ok) {
    navigateConsoleRoute("/operations");
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
): PluginInstallContext {
  const base = createClientCapabilities(resync);
  const source = dependencies.railBindings;
  const readBindings = (): readonly PaneTargetBinding[] => (typeof source === "function" ? source() : source);
  const land = (target: PaneTarget) => landPaneTarget(target, createHostPaneTargetPorts(readBindings()));
  const capabilities: PluginInstallContext = {
    ...base,
    operations: {
      ...base.operations,
      // 플러그인의 「이 Operation 으로」는 검색·알림과 같은 이동 요청이다 — 대화 화면이 그 Operation 을 가운데에 세운다.
      // 확대 도구는 focusOperation이 접어 대화를 드러낸다 — 도구 자체는 같은 자리에 남는다.
      focus: (operationId) => focusOperation(operationId),
    },
    notifications: {
      emit: (notification) => raiseOperationNotification(notification),
      dismiss: (operationId) => dismissNotificationsForOperation(operationId),
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
      set: (operationId, runtimeState) => setOperationRuntime(operationId, runtimeState),
      clear: (operationId) => clearOperationRuntime(operationId),
      setHydration: (hydration, error) => setOperationRuntimeHydration(hydration, error),
    },
    statusDetail: {
      set: (operationId, detail) => setOperationStatusDetail(operationId, detail),
      clear: (operationId) => clearOperationStatusDetail(operationId),
    },
    consoleState: {
      getTheaters: () => getState().theaters.map((theater) => ({ id: theater.id, label: theater.label, ...(theater.alias ? { alias: theater.alias } : {}) })),
      // 기본은 사이드바와 같은 목록(구성원 제외)이다 — 부관단처럼 목록을 읽는 플러그인이 따로 거르지 않아도 된다.
      // 구성원을 거느리는 플러그인(목표)만 nested 로 부모와 함께 읽는다.
      // nested 읽기의 부모 요약은 끌어올리기 전 자기 활동(ownActivity)도 싣는다 — 같은 규칙(resolveOperationRuntimeActivity)을 원 런타임에 쓴다.
      // 활동은 표시 어휘가 아니라 원시 값이다(background 를 접지 않는다) — 플러그인 계약이고, 접는 것은 각 표면의 표시 몫이다.
      getOperations: (options) => {
        const snapshot = getState();
        const nested = options?.nested === true;
        const operations = nested ? [...snapshot.operations, ...snapshot.nestedOperations] : snapshot.operations;
        const parents = nested ? new Set(snapshot.nestedOperations.map((operation) => operation.parentOperationId)) : null;
        const own = parents && parents.size > 0 ? ownOperationRuntime() : null;
        return operations.map((operation) => ({
          id: operation.id,
          theaterId: operation.theaterId,
          type: operation.type,
          title: operation.title,
          activity: resolveOperationRuntimeActivity(operation, snapshot.operationRuntime),
          ...(nested && operation.parentOperationId ? { parentOperationId: operation.parentOperationId } : {}),
          ...(own && parents!.has(operation.id) ? { ownActivity: resolveOperationRuntimeActivity(operation, own) } : {}),
        }));
      },
      getActiveTheaterId: getViewedTheaterId,
      getViewedTheaterId,
      viewTheater: viewTheaterInbox,
      getActiveOperationId: () => getState().activeOperationId,
      getConnection: () => getState().connection,
      getOperationRuntimeHydration: () => getState().operationRuntimeHydration,
      getSelectedOperationId: () => getState().selectedOperationId,
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
        navigateConsoleRoute("/operations");
        return { ok: true };
      },
    },
    shell: {
      openAt: async (request) => revealShellOnSuccess(await base.shell.openAt(request)),
      restartAt: async (request) => revealShellOnSuccess(await base.shell.restartAt(request)),
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
      isOpen: (surfaceId) => getExpandedSurfaceState().instances.some((i) => i.surfaceId === surfaceId),
    },
    rail: {
      open: (panelId, params) => {
        const binding = readBindings().find((item) => item.entry.id === panelId);
        // 폰에서 대화를 가리킨 열기는 그 대화 정보 화면의 탭으로 선다(`RailEntryMobile.conversationPane`).
        if (params?.operationId && revealMobileConversationTab(binding, params.operationId)) return;
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
      isOpen: (panelId) => getRailStoreSnapshot().activePanelId === panelId,
    },
    consoleEvents: {
      subscribe: (channel, onEvent) => subscribeConsoleChannel(channel, onEvent),
      onReconnect: (listener) => subscribeConsoleReconnect(listener),
    },
    chat: { Transcript: AgentChatTranscript, Conversation: AgentConversation },
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
        if (opened) navigateConsoleRoute("/operations");
        return opened;
      },
      close: (surfaceId) => closeConversationSurface(surfaceId),
      current: () => publicSurface(getConversationSurface()),
      // 대화 중심 화면의 셸과 모바일 셸이 같은 자리(conversation-slots)에 지금 선 대화의 주인을 싣는다.
      subjectOperationId: () => getConversationSubject()?.id ?? null,
      ledgerOperationId: (rootOperationId) => ledgerOperationId(rootOperationId),
      openLedger: (rootOperationId, operationId) => openLedger(rootOperationId, operationId),
      subscribeLedger: (listener) => subscribeLedger(listener),
    },
    composer: {
      open: (options) => {
        const mentionOperationId = options?.mentionOperationId;
        if (mentionOperationId) openQuickLaunchForOperation(mentionOperationId, typeof options?.draft === "string" ? options.draft : null);
        else if (options?.mentionTarget) openQuickLaunchForPluginTarget(options.mentionTarget, typeof options.draft === "string" ? options.draft : null);
        else if (typeof options?.draft === "string") openQuickLaunchWithDraft(options.draft);
        else openQuickLaunch();
      },
    },
  };
  return capabilities;
}
