import { createClientCapabilities } from "@fleet-console/sdk/plugin/browser";
import type { PluginInstallContext } from "@fleet-console/sdk/plugin";

import { collectExperimentModelOptions } from "./experiment-model-options.js";
import { getGlobalSettingsStoreState, isSavingGlobalSettingsField, setGlobalSettingsField, subscribe as subscribeGlobalSettings } from "../../../../features/settings/client/global-settings-store.js";
import { applySearchParams, subscribeConsoleLocation } from "./console-location.js";
import { closeExpandedSurface, closeExpandedSurfacesOf, getExpandedSurfaceState, openExpandedSurface } from "../chrome/expanded-surface/store.js";
import { resolveOperationActivity } from "../../../../features/execution/client/operation-activity.js";
import { clearOperationStatusDetail, setOperationStatusDetail } from "../../../../features/execution/client/operation-marks.js";
import { subscribeConsoleChannel } from "./operations-sse.js";
import { closeRailPanel, getRailStoreSnapshot, openRailPanel } from "../chrome/rail/rail-store.js";
import { clearOperationRuntime, dismissNotificationsForOperation, getState, openQuickLaunch, openQuickLaunchForOperation,
  openQuickLaunchWithDraft, raiseOperationNotification, requestOperationKeyboardFocus, resolveOperationFocusTarget, setActiveOperation, setActiveTheater, setOperationRuntime, setOperationRuntimeHydration, subscribe } from "./store.js";
import { restoreOperation } from "../../../../features/workspace/client/canvas/canvas-store.js";

export function createHostCapabilities(resync: () => void = () => undefined): PluginInstallContext {
  const base = createClientCapabilities(resync);
  return {
    ...base,
    operations: {
      ...base.operations,
      // 플러그인이 「이 Operation 으로」 — Theater 가 다르면 먼저 옮기고, 접혀 있으면 펴고, 활성으로 세운다.
      focus: (operationId) => {
        const operation = getState().operations.find((candidate) => candidate.id === operationId);
        if (!operation) return;
        if (getState().activeTheaterId !== operation.theaterId) setActiveTheater(operation.theaterId);
        // 패널로 서지 않는 단계는 지휘관 패널이 대신 선다 — 펴기·키보드 포커스도 그 대상으로. 활성화는 요청한 id 로 넘겨
        // 그 단계의 도착 표식까지 확인 처리한다(스토어가 같은 대상으로 돌린다).
        const target = resolveOperationFocusTarget(operationId);
        restoreOperation(target);
        setActiveOperation(operationId);
        requestOperationKeyboardFocus(target);
      },
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
      modelOptions: () => collectExperimentModelOptions(),
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
      getOperations: () => {
        const snapshot = getState();
        return snapshot.operations.map((operation) => ({
          id: operation.id,
          theaterId: operation.theaterId,
          type: operation.type,
          title: operation.title,
          activity: resolveOperationActivity(operation, snapshot.operationRuntime),
        }));
      },
      getActiveTheaterId: () => getState().activeTheaterId,
      setActiveTheater: (theaterId) => setActiveTheater(theaterId),
      subscribe: (listener) => subscribe(listener),
    },
    navigation: {
      getSearchParam: (key) => new URLSearchParams(window.location.search).get(key),
      setSearchParams: (next, options) => applySearchParams(next, options?.replace === true),
      // popstate만으로는 앱 내부 navigate를 못 듣는다 — 코어가 자기 이동도 알린다.
      subscribe: (listener) => subscribeConsoleLocation(listener),
    },
    surfaces: {
      open: (request) => openExpandedSurface(request),
      close: (instanceId) => closeExpandedSurface(instanceId),
      closeSurface: (surfaceId) => closeExpandedSurfacesOf(surfaceId),
      isOpen: (surfaceId) => getExpandedSurfaceState().instances.some((i) => i.surfaceId === surfaceId),
    },
    rail: {
      open: (panelId) => openRailPanel(panelId),
      close: (panelId) => closeRailPanel(panelId),
      isOpen: (panelId) => getRailStoreSnapshot().activePanelId === panelId,
    },
    consoleEvents: {
      subscribe: (channel, onEvent) => subscribeConsoleChannel(channel, onEvent),
    },
    composer: {
      open: (options) => {
        const mentionOperationId = options?.mentionOperationId;
        if (mentionOperationId) openQuickLaunchForOperation(mentionOperationId, typeof options?.draft === "string" ? options.draft : null);
        else if (typeof options?.draft === "string") openQuickLaunchWithDraft(options.draft);
        else openQuickLaunch();
      },
    },
  };
}
