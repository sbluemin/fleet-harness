import { React } from "@fleet-console/sdk/plugin/browser";
import type { ClientApiCapability, OperationRenderContext } from "@fleet-console/sdk/plugin";

import { fetchAnalysisCatalog, sendAnalysisMessage, startAnalysis, stopAnalysis, subscribeAnalysis } from "./analysis-api.js";
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

function createAnalysisStore(operationId: string, api: ClientApiCapability): AnalysisStore {
  let state = initialAnalysisState;
  let retainCount = 0;
  let cleanupPending = false;
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const dispatch = (action: AnalysisAction) => {
    if (disposed) return;
    const next = analysisReducer(state, action);
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stores.delete(operationId);
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
      try {
        if (starting) {
          await startAnalysis(api, operationId, selection);
          if (disposed) return;
          unsubscribe = subscribeAnalysis(api, operationId, (event) => dispatch({ type: "event", event }));
        }
        await sendAnalysisMessage(api, operationId, trimmed);
      } catch (error) {
        dispatch({ type: "error", message: error instanceof Error ? error.message : "Analysis is unavailable." });
      }
    },
    retain: () => {
      if (disposed) return () => {};
      retainCount += 1;
      cleanupPending = false;
      let retained = true;
      return () => {
        if (!retained || disposed) return;
        retained = false;
        retainCount = Math.max(0, retainCount - 1);
        if (retainCount > 0 || cleanupPending) return;
        cleanupPending = true;
        queueMicrotask(() => {
          if (!cleanupPending || retainCount > 0 || disposed) return;
          dispose();
        });
      };
    },
    dispose,
  };

  void fetchAnalysisCatalog(api)
    .then((catalog) => dispatch({ type: "catalog", catalog }))
    .catch((error: unknown) => dispatch({ type: "error", message: error instanceof Error ? error.message : "Analysis is unavailable." }));

  return store;
}
