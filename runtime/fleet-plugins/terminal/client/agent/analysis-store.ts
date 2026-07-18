import { React } from "@fleet-console/sdk/plugin/browser";
import type { ClientApiCapability, OperationRenderContext } from "@fleet-console/sdk/plugin";

import { AnalysisApiError, fetchAnalysisCatalog, sendAnalysisMessage, startAnalysis, stopAnalysis, subscribeAnalysis } from "./analysis-api.js";
import { analysisReducer, initialAnalysisState, type AnalysisAction, type AnalysisState } from "./analysis-state.js";

export interface AnalysisStore {
  readonly getSnapshot: () => AnalysisState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispatch: (action: AnalysisAction) => void;
  readonly send: (text: string) => Promise<void>;
  readonly retain: () => () => void;
  readonly dispose: () => void;
}

interface AnalysisStoreBinding {
  readonly state: AnalysisState;
  readonly dispatch: (action: AnalysisAction) => void;
  readonly send: (text: string) => Promise<void>;
}

const stores = new Map<string, AnalysisStore>();

export function useAnalysisStore(context: OperationRenderContext): AnalysisStoreBinding {
  const store = getAnalysisStore(context.operationId, context.api);
  React.useEffect(() => store.retain(), [store]);
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { state, dispatch: store.dispatch, send: store.send };
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
  let retainCount = 0;
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
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
      dispatch({ type: "error", message: "Analysis response timed out." });
    }, RESPONSE_TIMEOUT_MS);
  };

  // 서버의 connected 첫 프레임을 기다려 초기 chunk 유실 레이스를 닫는다(폴백 상한 포함).
  const openStream = async () => {
    if (unsubscribe) return;
    let resolveConnected: (() => void) | null = null;
    const connected = new Promise<void>((resolve) => { resolveConnected = resolve; });
    unsubscribe = subscribeAnalysis(api, operationId, (event) => {
      if (event.type === "connected") {
        resolveConnected?.();
        resolveConnected = null;
        return;
      }
      if (event.type === "complete" || event.type === "error") disarmWatchdog();
      dispatch({ type: "event", event });
    });
    await Promise.race([connected, new Promise<void>((resolve) => setTimeout(resolve, CONNECT_WAIT_MS))]);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stores.delete(operationId);
    disarmWatchdog();
    unsubscribe?.();
    unsubscribe = null;
    listeners.clear();
    if (state.started) void stopAnalysis(api, operationId).catch(() => {});
  };

  const store: AnalysisStore = {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch,
    send: async (text) => {
      const trimmed = text.trim();
      if (!trimmed || state.busy || disposed) return;
      const starting = !state.started;
      const selection = { cliId: state.cliId, model: state.model, effort: state.effort };
      dispatch({ type: "sending", started: starting, text: trimmed });
      if (starting) {
        try {
          await startAnalysis(api, operationId, selection);
        } catch (error) {
          // 리로드 등으로 서버 세션이 이미 살아 있으면 그 세션을 이어받는다.
          const exists = error instanceof AnalysisApiError && error.code === "analysis_session_exists";
          if (!exists) {
            dispatch({ type: "start-failed", message: failureMessage(error) });
            return;
          }
        }
        if (disposed) return;
        await openStream();
      }
      try {
        await sendAnalysisMessage(api, operationId, trimmed);
        armWatchdog();
      } catch (error) {
        dispatch({ type: "error", message: failureMessage(error) });
      }
    },
    retain: () => {
      if (disposed) return () => {};
      retainCount += 1;
      let retained = true;
      return () => {
        if (!retained) return;
        retained = false;
        retainCount = Math.max(0, retainCount - 1);
        // companion 패널이 닫혀도(EXIT) 대화·아티팩트·서버 세션은 보존한다 —
        // 정리는 Operation 종료 경로의 disposeAnalysisStore만 소유한다.
      };
    },
    dispose,
  };

  void fetchAnalysisCatalog(api)
    .then((catalog) => dispatch({ type: "catalog", catalog }))
    .catch((error: unknown) => dispatch({ type: "error", message: failureMessage(error) }));

  return store;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Analysis is unavailable.";
}
