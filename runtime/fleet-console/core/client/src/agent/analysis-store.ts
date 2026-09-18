import { React } from "@fleet-console/sdk/plugin/browser";
import type { ClientApiCapability, ClientSettingsCapability, OperationRenderContext } from "@fleet-console/sdk/plugin";

import { getOperationGaze, subscribeConsoleUseGestures } from "../console-use-gestures.js";
import { AnalysisApiError, clearAnalysisArtifacts, fetchAnalysisCatalog, fetchAnalysisJournal, sendAnalysisMessage, startAnalysis, stopAnalysis, subscribeAnalysis } from "./analysis-api.js";
import { analysisReducer, initialAnalysisState, type AnalysisAction, type AnalysisState } from "./analysis-state.js";
import { subscribeInstalledExperiments } from "./experiments-api.js";

export interface AnalysisStore {
  readonly getSnapshot: () => AnalysisState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispatch: (action: AnalysisAction) => void;
  readonly send: (text: string) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly reset: () => Promise<void>;
  readonly refreshCatalog: () => void;
  /** 서버에 살아 있는 분석가(에이전트가 시작한 것 포함)를 이어받는다 — 원장을 그리고 스트림을 붙인다. 이미 시작된 스토어면 아무 일도 없다. */
  readonly adopt: () => void;
  readonly dispose: () => void;
  readonly updateContext: (settings: ClientSettingsCapability | undefined, language: "en" | "ko" | undefined) => void;
}

interface AnalysisStoreBinding {
  readonly state: AnalysisState;
  readonly dispatch: (action: AnalysisAction) => void;
  readonly send: (text: string) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly reset: () => Promise<void>;
  readonly refreshCatalog: () => void;
  readonly adopt: () => void;
}

const stores = new Map<string, AnalysisStore>();
const disposalFlights = new Map<string, Promise<void>>();

export function useAnalysisStore(context: OperationRenderContext): AnalysisStoreBinding {
  const store = getAnalysisStore(context.operationId, context.api, context.settings, context.language);
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  // 패널이 열릴 때마다 채택을 시도한다 — 스토어는 캡션 칩 때문에 분석가가 시작되기 전에 만들어질 수 있고, 그 사이
  // 에이전트가 console_analyst 로 시작·질문했으면 지금 그 원장을 그려야 「분석가 시작」 대신 대화가 보인다.
  React.useEffect(() => { store.adopt(); }, [store]);
  React.useEffect(() => subscribeConsoleUseGestures(() => { if (getOperationGaze(context.operationId)?.tool === "console_analyst") store.adopt(); }), [store, context.operationId]);
  return { state, dispatch: store.dispatch, send: store.send, stop: store.stop, reset: store.reset, refreshCatalog: store.refreshCatalog, adopt: store.adopt };
}

export function getAnalysisStore(operationId: string, api: ClientApiCapability, settings?: ClientSettingsCapability, language?: "en" | "ko"): AnalysisStore {
  const existing = stores.get(operationId);
  if (existing) {
    existing.updateContext(settings, language);
    return existing;
  }
  const store = createAnalysisStore(operationId, api, settings, language);
  stores.set(operationId, store);
  return store;
}

export function disposeAnalysisStore(operationId: string): void {
  stores.get(operationId)?.dispose();
}

// re-arm 전용 조회 API — dispose된 Operation의 store를 재생성하지 않아야 한다(orphan 방지).

const CONNECT_WAIT_MS = 2_000;
/* 무활동 상한 — 총량 상한이 아니다. v1의 120s 고정 상한은 이벤트가 계속 흘러도 턴을 죽여
   아티팩트 저작 같은 긴 턴이 주 희생자였다(2026-09-01 결정으로 제거). 이 값은 이벤트 수신마다
   재무장되므로, 살아 있는 턴은 얼마든지 길어질 수 있고 SSE가 조용히 끊긴 고착만 걸린다. */
const ANALYSIS_INACTIVITY_TIMEOUT_MS = 180_000;

function createAnalysisStore(operationId: string, api: ClientApiCapability, _initialSettings?: ClientSettingsCapability, initialLanguage?: "en" | "ko"): AnalysisStore {
  let state = initialAnalysisState;
  let language = initialLanguage;
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let catalogFlight: Promise<void> | null = null;
  let startFlight: Promise<void> | null = null;
  let startController: AbortController | null = null;
  let stopFlight: Promise<void> | null = null;
  let resetFlight: Promise<void> | null = null;
  let streamGeneration = 0;
  let runGeneration = 0;
  const listeners = new Set<() => void>();

  const dispatch = (action: AnalysisAction) => {
    if (disposed) return;
    const next = analysisReducer(state, action);
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };

  const disarmWatchdog = () => {
    if (watchdog === null) return;
    clearTimeout(watchdog);
    watchdog = null;
  };
  // SSE가 끊겨 complete/error를 영영 못 받으면 busy가 고착되므로 무활동 감시를 둔다 —
  // 이벤트가 올 때마다 재무장하고, 침묵이 상한을 넘겼을 때만 턴을 닫는다.
  const armWatchdog = () => {
    disarmWatchdog();
    watchdog = setTimeout(() => {
      watchdog = null;
      dispatch({ type: "error", message: "Analysis response timed out.", now: Date.now() });
    }, ANALYSIS_INACTIVITY_TIMEOUT_MS);
  };

  const invalidateRun = () => {
    disarmWatchdog();
    streamGeneration += 1;
    runGeneration += 1;
    const closeStream = unsubscribe;
    unsubscribe = null;
    closeStream?.();
  };

  const endLostSession = () => {
    invalidateRun();
    dispatch({ type: "session-lost", now: Date.now() });
  };

  // 서버의 connected 첫 프레임을 기다려 초기 chunk 유실 레이스를 닫는다(폴백 상한 포함).
  const openStream = async () => {
    if (unsubscribe) return;
    const generation = ++streamGeneration;
    let resolveConnected: (() => void) | null = null;
    const connected = new Promise<void>((resolve) => { resolveConnected = resolve; });
    unsubscribe = subscribeAnalysis(api, operationId, (event) => {
      if (generation !== streamGeneration || disposed) return;
      if (event.type === "connected") {
        dispatch({ type: "event", event, now: Date.now() });
        resolveConnected?.();
        resolveConnected = null;
        return;
      }
      if (event.type === "error" && isLostSessionCode(event.error.code)) {
        resolveConnected?.();
        resolveConnected = null;
        endLostSession();
        return;
      }
      if (event.type === "complete" || event.type === "error") disarmWatchdog();
      // 살아 있는 턴의 이벤트는 감시를 재무장한다 — 긴 분석·아티팩트 저작은 침묵이 아니다.
      else if (watchdog !== null) armWatchdog();
      const queued = event.type === "complete" ? state.queue[0] : undefined;
      dispatch({ type: "event", event, now: Date.now() });
      if (queued !== undefined && !state.busy && !disposed && generation === streamGeneration) {
        dispatch({ type: "queue-cancel", index: 0 });
        void store.send(queued);
      }
    });
    await Promise.race([connected, new Promise<void>((resolve) => setTimeout(resolve, CONNECT_WAIT_MS))]);
  };

  const dispose = () => {
    if (disposed) return;
    const previousDisposal = disposalFlights.get(operationId);
    const pendingReset = resetFlight;
    const pendingStop = stopFlight;
    const pendingStart = startFlight;
    const pendingStartController = startController;
    disposed = true;
    stores.delete(operationId);
    invalidateRun();
    unsubscribeExperiments();
    listeners.clear();
    pendingStartController?.abort();
    const flight = (async () => {
      if (previousDisposal) await previousDisposal;
      if (pendingStart) await pendingStart.catch(() => {});
      if (pendingReset) await pendingReset.catch(() => {});
      if (pendingStop) await pendingStop.catch(() => {});
      await stopAnalysis(api, operationId);
    })().catch(() => {});
    disposalFlights.set(operationId, flight);
    void flight.finally(() => {
      if (disposalFlights.get(operationId) === flight) disposalFlights.delete(operationId);
    });
  };

  // 카탈로그는 AI Gateway 선별에서 나오고 그 선별은 Console 설정에서 바뀐다 — 설정을 다녀오는 동안
  // 이 store는 살아 있으므로(Operation 단위 수명), 다시 열 때 읽지 않으면 방금 추가한 모델이 목록에
  // 영원히 없다. 선택이 잠긴 뒤(started)에는 읽지 않는다 — 진행 중 세션의 표시 선택을 뒤에서
  // 갈아끼우게 된다. 그 잠금은 reset이 푸는 자리이므로 reset도 이 읽기를 함께 돌린다: 한 번이라도
  // 돌린 세션은 started가 complete 뒤에도 참이라, 여기서 읽지 않으면 초기화해도 새 모델이 없다.
  // 좌표(모델·강도)도 이 응답에 실려 온다 — Settings가 바뀌면 아래 구독이 같은 읽기를 돌린다. 이미 읽는
  // 중이면(첫 마운트의 하이드레이션 포함) 그 결과를 기다린다 — 아래 하이드레이션 주석 참조.
  const refreshCatalogNow = (): void => {
    if (state.started || catalogFlight) return;
    catalogFlight = fetchAnalysisCatalog(api)
      .then((catalog) => {
        if (disposed || state.started) return;
        dispatch({ type: "catalog", catalog });
      })
      // 목록 갱신 실패는 조용히 지나간다 — 이미 들고 있는 카탈로그로 계속 쓸 수 있고,
      // 여기서 오류 문구를 띄우면 아직 아무것도 요청하지 않은 화면이 실패한 것처럼 읽힌다.
      .catch(() => undefined)
      .finally(() => { catalogFlight = null; });
  };
  const unsubscribeExperiments = subscribeInstalledExperiments(() => { if (!disposed) refreshCatalogNow(); });

  let adoptFlight: Promise<void> | null = null;
  const adopt = (): void => {
    if (disposed || state.started || adoptFlight) return;
    adoptFlight = fetchAnalysisJournal(api, operationId)
      .then(async (journal) => {
        if (disposed || !journal.started || state.started) return;
        dispatch({ type: "hydrate", started: true, ...(journal.model ? { model: journal.model } : {}), entries: journal.entries, now: Date.now() });
        if (state.busy) armWatchdog();
        await openStream();
      })
      .catch(() => undefined)
      .finally(() => { adoptFlight = null; });
  };
  const store: AnalysisStore = {
    adopt,
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch,
    send: async (text) => {
      const previousDisposal = disposalFlights.get(operationId);
      if (previousDisposal) await previousDisposal;
      if (resetFlight) {
        try { await resetFlight; } catch { return; }
      }
      if (stopFlight) await stopFlight;
      const trimmed = text.trim();
      if (!trimmed || state.busy || disposed) return;
      const starting = !state.started;
      const generation = ++runGeneration;
      // Output language belongs to the server session created by this start. Later global
      // language changes update panel copy live, but apply to output only after reset/restart.
      const startBody = language ? { language } : {};
      dispatch({ type: "sending", started: starting, text: trimmed, now: Date.now() });
      if (starting) {
        const controller = new AbortController();
        const flight = startAnalysis(api, operationId, startBody, controller.signal);
        startController = controller;
        startFlight = flight;
        try {
          await flight;
        } catch (error) {
          if (disposed || generation !== runGeneration) return;
          // 리로드 등으로 서버 세션이 이미 살아 있으면 그 세션을 이어받는다.
          const exists = error instanceof AnalysisApiError && error.code === "analysis_session_exists";
          if (!exists) {
            dispatch({ type: "start-failed", message: failureMessage(error), now: Date.now() });
            return;
          }
        } finally {
          if (startController === controller) startController = null;
          if (startFlight === flight) startFlight = null;
        }
        if (disposed || generation !== runGeneration || !state.started) return;
        await openStream();
        if (generation !== runGeneration || !state.started) return;
      }
      try {
        await sendAnalysisMessage(api, operationId, trimmed);
        if (generation !== runGeneration || !state.busy || !state.started) return;
        armWatchdog();
      } catch (error) {
        if (disposed || generation !== runGeneration) return;
        if (error instanceof AnalysisApiError && isLostSessionCode(error.code)) endLostSession();
        else dispatch({ type: "error", message: failureMessage(error), now: Date.now() });
      }
    },
    stop: async () => {
      if (resetFlight) {
        await resetFlight.catch(() => {});
        return;
      }
      if (stopFlight) return stopFlight;
      if (disposed || !state.started) return;
      invalidateRun();
      dispatch({ type: "stopped", now: Date.now() });
      const flight = stopAnalysis(api, operationId).catch((error: unknown) => {
        dispatch({ type: "stop-failed", message: failureMessage(error), now: Date.now() });
      });
      stopFlight = flight;
      await flight;
      if (stopFlight === flight) stopFlight = null;
    },
    reset: async () => {
      if (resetFlight) return resetFlight;
      if (disposed) return;
      const shouldStopServer = state.started || state.phase !== "idle" || state.entries.length > 0 || state.artifacts.length > 0;
      invalidateRun();
      const flight = (async () => {
        if (stopFlight) await stopFlight;
        if (startFlight) await startFlight.catch(() => {});
        if (shouldStopServer) await stopAnalysis(api, operationId);
        await clearAnalysisArtifacts(api, operationId).catch(() => {});
        dispatch({ type: "reset" });
        // reset이 started를 푼 직후가 목록을 다시 읽을 수 있게 되는 첫 시점이다.
        refreshCatalogNow();
      })().catch((error: unknown) => {
        dispatch({ type: "error", message: `Reset failed: ${failureMessage(error)}`, now: Date.now() });
        throw error;
      });
      resetFlight = flight;
      try {
        await flight;
      } finally {
        if (resetFlight === flight) resetFlight = null;
      }
    },
    refreshCatalog: refreshCatalogNow,
    dispose,
    updateContext: (_settings, nextLanguage) => {
      language = nextLanguage;
    },
  };

  // 최초 하이드레이션도 카탈로그 읽기다 — 같은 catalogFlight에 실어야 첫 마운트의 refreshCatalog가
  // 두 번째 요청을 띄우지 않는다. 둘이 겹치면 먼저 도착한 갱신이 목록을 열어 주고, 그 사이 사용자가
  // 고른 모델을 뒤늦게 도착한 하이드레이션이 저장본으로 덮어쓴다.
  const previousDisposal = disposalFlights.get(operationId);
  catalogFlight = (previousDisposal ?? Promise.resolve())
    .then(() => fetchAnalysisCatalog(api))
    .then((catalog) => { dispatch({ type: "catalog", catalog }); })
    .catch((error: unknown) => dispatch({ type: "error", message: failureMessage(error), now: Date.now() }))
    .finally(() => { catalogFlight = null; });
  void catalogFlight;
  // 서버에 이미 살아 있는 분석가(에이전트가 시작했거나 리로드 전의 것)를 이어받는다. 실패는 조용히 지나간다.
  void (previousDisposal ?? Promise.resolve()).then(() => adopt());

  return store;
}



function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Analysis is unavailable.";
}

function isLostSessionCode(code: string): boolean {
  return code === "analysis_exited" || code === "analysis_session_not_found";
}
