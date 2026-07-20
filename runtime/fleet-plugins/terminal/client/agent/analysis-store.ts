import { React } from "@fleet-console/sdk/plugin/browser";
import type { ClientApiCapability, OperationRenderContext } from "@fleet-console/sdk/plugin";

import { AnalysisApiError, clearAnalysisArtifacts, fetchAnalysisCatalog, sendAnalysisMessage, startAnalysis, stopAnalysis, subscribeAnalysis } from "./analysis-api.js";
import { analysisReducer, initialAnalysisState, type AnalysisAction, type AnalysisState } from "./analysis-state.js";

export interface AnalysisStore {
  readonly getSnapshot: () => AnalysisState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispatch: (action: AnalysisAction) => void;
  readonly send: (text: string) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly reset: () => Promise<void>;
  readonly dispose: () => void;
}

interface AnalysisStoreBinding {
  readonly state: AnalysisState;
  readonly dispatch: (action: AnalysisAction) => void;
  readonly send: (text: string) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly reset: () => Promise<void>;
}

const stores = new Map<string, AnalysisStore>();
const disposalFlights = new Map<string, Promise<void>>();

export function useAnalysisStore(context: OperationRenderContext): AnalysisStoreBinding {
  const store = getAnalysisStore(context.operationId, context.api);
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { state, dispatch: store.dispatch, send: store.send, stop: store.stop, reset: store.reset };
}

export function getAnalysisStore(operationId: string, api: ClientApiCapability): AnalysisStore {
  const existing = stores.get(operationId);
  if (existing) return existing;
  const store = createAnalysisStore(operationId, api);
  stores.set(operationId, store);
  return store;
}

export function disposeAnalysisStore(operationId: string): void {
  stores.get(operationId)?.dispose();
}

const CONNECT_WAIT_MS = 2_000;
const RESPONSE_TIMEOUT_MS = 120_000;

function createAnalysisStore(operationId: string, api: ClientApiCapability): AnalysisStore {
  let state = initialAnalysisState;
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
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
  // SSE가 끊겨 complete/error를 영영 못 받으면 busy가 고착되므로 상한을 둔다.
  const armWatchdog = () => {
    disarmWatchdog();
    watchdog = setTimeout(() => {
      watchdog = null;
      dispatch({ type: "error", message: "Analysis response timed out.", now: Date.now() });
    }, RESPONSE_TIMEOUT_MS);
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
      dispatch({ type: "event", event, now: Date.now() });
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

  const store: AnalysisStore = {
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
      const selection = { cliId: state.cliId, model: state.model, effort: state.effort };
      dispatch({ type: "sending", started: starting, text: trimmed, now: Date.now() });
      if (starting) {
        const controller = new AbortController();
        const flight = startAnalysis(api, operationId, selection, controller.signal);
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
    dispose,
  };

  void fetchAnalysisCatalog(api)
    .then((catalog) => dispatch({ type: "catalog", catalog }))
    .catch((error: unknown) => dispatch({ type: "error", message: failureMessage(error), now: Date.now() }));

  return store;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Analysis is unavailable.";
}

function isLostSessionCode(code: string): boolean {
  return code === "analysis_exited" || code === "analysis_session_not_found";
}
