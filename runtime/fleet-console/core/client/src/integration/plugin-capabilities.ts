import type { PaneTarget } from "@fleet-console/sdk/pane";
import type { ExpandedSurfaceOpenRequest } from "@fleet-console/sdk/expanded-surface";
import { setMobileTool } from "../chrome/mobile/mobile-store.js";
import { landPaneTarget, type PaneTargetBinding, type PaneTargetPorts } from "../chrome/pane/pane-target.js";
import { openPane } from "../chrome/pane/pane-store.js";
import { getViewModeSnapshot } from "./view-mode-store.js";
import { SETTINGS_PANE_ID } from "../../../../features/settings/client/settings-entry.js";
import { createClientCapabilities } from "@fleet-console/sdk/plugin/browser";
import type { PluginInstallContext } from "@fleet-console/sdk/plugin";
import type { ShellOpenAtResult } from "@fleet-console/sdk/navigation";

import { loadModelRoster, readModelRoster, refreshModelRoster, rosterModelOptions, subscribeModelRoster } from "../../../../features/ai-gateway/client/model-roster-store.js";
import { getGlobalSettingsStoreState, isSavingGlobalSettingsField, setGlobalSettingsField, subscribe as subscribeGlobalSettings } from "../../../../features/settings/client/global-settings-store.js";
import { applySearchParams, navigateConsoleRoute, subscribeConsoleLocation } from "./console-location.js";
import { closeExpandedSurface, closeExpandedSurfacesOf, getExpandedSurfaceState, openExpandedSurface } from "../chrome/expanded-surface/store.js";
import { resolveOperationActivity } from "../../../../features/execution/client/operation-activity.js";
import { clearOperationStatusDetail, setOperationStatusDetail } from "../../../../features/execution/client/operation-marks.js";
import { subscribeConsoleChannel, subscribeConsoleReconnect } from "./operations-sse.js";
import { closeRailPanel, getRailStoreSnapshot, openRailPanel, subscribeRailStore } from "../chrome/rail/rail-store.js";
import { getCanvasArenaInsets, subscribeCanvasArenaInsets } from "../../../../features/workspace/client/canvas/canvas-store.js";
import { clearOperationRuntime, dismissNotificationsForOperation, focusOperation, getState, openQuickLaunch, openQuickLaunchForOperation, openQuickLaunchForPluginTarget, ownOperationRuntime,
  openQuickLaunchWithDraft, raiseOperationNotification, setActiveTheater, setOperationRuntime, setOperationRuntimeHydration, subscribe } from "./store.js";

export interface HostCapabilityDependencies {
  readonly railBindings: readonly PaneTargetBinding[];
}

function revealRailPanel(entryId: string): void {
  openRailPanel(entryId);
  if (getViewModeSnapshot().effective === "mobile") {
    setMobileTool({ kind: "rail", id: entryId });
    navigateConsoleRoute("/operations");
  }
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
      setActiveTheater(theaterId);
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

export function createHostCapabilities(
  resync: () => void = () => undefined,
  dependencies: HostCapabilityDependencies = { railBindings: [] },
): PluginInstallContext {
  const base = createClientCapabilities(resync);
  const bindings = dependencies.railBindings;
  const land = (target: PaneTarget) => landPaneTarget(target, createHostPaneTargetPorts(bindings));
  const capabilities: PluginInstallContext = {
    ...base,
    operations: {
      ...base.operations,
      // 플러그인의 「이 Operation 으로」는 검색·알림과 같은 이동 요청이다 — 자리는 소비 경로가 모드별로 정한다
      // (War Room 이면 무대에 올리고, 아니면 Theater 전환·펴기·companion·최대화·모두 정렬을 따른다).
      // 확장 표면은 focusOperation 이 정리한다 — 플러그인은 자기 표면을 따로 닫지 않는다.
      // `snap: "full"` 힌트는 Cruise에서 Snap 전체 칸으로 앉히고, 스냅할 수 없는 모드·화면에서는 같은 일반 이동으로 폴백한다.
      // 패널로 서지 않는 단계는 스토어가 지휘관으로 돌리고, 요청한 단계의 도착 표식·알림까지 치운다.
      focus: (operationId, options) => focusOperation(operationId, options?.snap === "full" ? { snapFull: true } : undefined),
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
      getTheaters: () => getState().theaters.map((theater) => ({ id: theater.id, label: theater.label })),
      // 기본은 사이드바와 같은 목록(구성원 제외)이다 — 부관단처럼 목록을 읽는 플러그인이 따로 거르지 않아도 된다.
      // 구성원을 거느리는 플러그인(목표)만 nested 로 부모와 함께 읽는다.
      // nested 읽기의 부모 요약은 끌어올리기 전 자기 활동(ownActivity)도 싣는다 — 같은 규칙(resolveOperationActivity)을 원 런타임에 쓴다.
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
          activity: resolveOperationActivity(operation, snapshot.operationRuntime),
          ...(nested && operation.parentOperationId ? { parentOperationId: operation.parentOperationId } : {}),
          ...(own && parents!.has(operation.id) ? { ownActivity: resolveOperationActivity(operation, own) } : {}),
        }));
      },
      getActiveTheaterId: () => getState().activeTheaterId,
      getActiveOperationId: () => getState().activeOperationId,
      getConnection: () => getState().connection,
      getOperationRuntimeHydration: () => getState().operationRuntimeHydration,
      getSelectedOperationId: () => getState().selectedOperationId,
      setActiveTheater: (theaterId) => setActiveTheater(theaterId),
      subscribe: (listener) => subscribe(listener),
      // 확정 인셋은 아레나 스토어에서, 레일을 끄는 동안의 차이는 레일 스토어에서 — 캔버스가 --arena-right 를 따라가는 것과 같은 셈.
      getMapInsets: () => {
        const settled = getCanvasArenaInsets();
        const { railOccupiedPx, railSettledPx } = getRailStoreSnapshot();
        return { left: settled.left, right: Math.max(0, settled.right + railOccupiedPx - railSettledPx) };
      },
      subscribeMapInsets: (listener) => {
        const offRail = subscribeRailStore(listener);
        const offArena = subscribeCanvasArenaInsets(listener);
        return () => { offRail(); offArena(); };
      },
    },
    navigate: {
      openFile: async (request) => {
        const binding = bindings.find((item) => item.entry.handles?.openFile);
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
        const binding = bindings.find((item) => item.entry.handles?.openWikiEntry);
        const handler = binding?.entry.handles?.openWikiEntry;
        if (!handler) return { ok: false, reason: "no_handler" };
        if (!getState().theaters.some((theater) => theater.id === request.theaterId)) return { ok: false, reason: "not_found" };
        const result = await handler(request, capabilities);
        if (result && !result.ok) return result;
        setActiveTheater(request.theaterId);
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
      open: (request) => revealExpandedSurface(request),
      close: (instanceId) => closeExpandedSurface(instanceId),
      closeSurface: (surfaceId) => closeExpandedSurfacesOf(surfaceId),
      isOpen: (surfaceId) => getExpandedSurfaceState().instances.some((i) => i.surfaceId === surfaceId),
    },
    rail: {
      open: (panelId, params) => {
        const primary = bindings.find((binding) => binding.entry.id === panelId)?.panes.find((pane) => pane.role === "primary");
        if (params && primary) land({ paneId: primary.id, params });
        else revealRailPanel(panelId);
      },
      close: (panelId) => closeRailPanel(panelId),
      isOpen: (panelId) => getRailStoreSnapshot().activePanelId === panelId,
    },
    consoleEvents: {
      subscribe: (channel, onEvent) => subscribeConsoleChannel(channel, onEvent),
      onReconnect: (listener) => subscribeConsoleReconnect(listener),
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
