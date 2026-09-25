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
import { clearOperationRuntime, dismissNotificationsForOperation, focusOperation, getState, openQuickLaunch, openQuickLaunchForOperation, ownOperationRuntime,
  openQuickLaunchWithDraft, raiseOperationNotification, setActiveTheater, setOperationRuntime, setOperationRuntimeHydration, subscribe } from "./store.js";

export function createHostCapabilities(resync: () => void = () => undefined): PluginInstallContext {
  const base = createClientCapabilities(resync);
  return {
    ...base,
    operations: {
      ...base.operations,
      // 플러그인의 「이 Operation 으로」는 검색·알림과 같은 이동 요청이다 — 자리는 소비 경로가 모드별로 정한다
      // (War Room 이면 무대에 올리고, 아니면 Theater 전환·펴기·companion·최대화·Formation 을 따른다).
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
