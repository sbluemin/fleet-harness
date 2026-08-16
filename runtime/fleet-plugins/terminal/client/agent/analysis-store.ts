import { React } from "@fleet-console/sdk/plugin/browser";
import type { ClientApiCapability, ClientSettingsCapability, OperationRenderContext } from "@fleet-console/sdk/plugin";

import { AnalysisApiError, clearAnalysisArtifacts, fetchAnalysisCatalog, sendAnalysisMessage, startAnalysis, stopAnalysis, subscribeAnalysis } from "./analysis-api.js";
import { analysisReducer, initialAnalysisState, type AnalysisAction, type AnalysisState } from "./analysis-state.js";
import type { AnalysisSelection } from "./analysis-types.js";
import { mergeTerminalSettingsRecord } from "../shared/terminal-preferences.js";

export interface AnalysisStore {
  readonly getSnapshot: () => AnalysisState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispatch: (action: AnalysisAction) => void;
  readonly send: (text: string) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly reset: () => Promise<void>;
  readonly refreshCatalog: () => void;
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
}

const stores = new Map<string, AnalysisStore>();
const disposalFlights = new Map<string, Promise<void>>();

export function useAnalysisStore(context: OperationRenderContext): AnalysisStoreBinding {
  const store = getAnalysisStore(context.operationId, context.api, context.settings, context.language);
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { state, dispatch: store.dispatch, send: store.send, stop: store.stop, reset: store.reset, refreshCatalog: store.refreshCatalog };
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
const RESPONSE_TIMEOUT_MS = 120_000;

function createAnalysisStore(operationId: string, api: ClientApiCapability, initialSettings?: ClientSettingsCapability, initialLanguage?: "en" | "ko"): AnalysisStore {
  let state = initialAnalysisState;
  let settingsCapability = initialSettings;
  let language = initialLanguage;
  let persistedSelection: AnalysisSelection | null = null;
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let catalogFlight: Promise<void> | null = null;
  let startFlight: Promise<void> | null = null;
  let startController: AbortController | null = null;
  let stopFlight: Promise<void> | null = null;
  let resetFlight: Promise<void> | null = null;
  let selectionWriteFlight: Promise<void> = Promise.resolve();
  let selectionWriteEpoch = 0;
  let selectionSavedTimer: ReturnType<typeof setTimeout> | null = null;
  let streamGeneration = 0;
  let runGeneration = 0;
  const listeners = new Set<() => void>();

  const dispatch = (action: AnalysisAction) => {
    if (disposed) return;
    const savesSelection = action.type === "select-cli" || action.type === "select-model" || action.type === "select-effort";
    if (savesSelection && state.selectionLocked) return;
    const next = analysisReducer(state, action);
    if (next === state) return;
    if (savesSelection && selectionSavedTimer !== null) {
      clearTimeout(selectionSavedTimer);
      selectionSavedTimer = null;
    }
    state = savesSelection && next.selectionSaved ? { ...next, selectionSaved: false } : next;
    for (const listener of listeners) listener();
    if (savesSelection) queueSelectionSave({ cliId: state.cliId, model: state.model, effort: state.effort });
  };

  const queueSelectionSave = (selection: AnalysisSelection) => {
    const settings = settingsCapability;
    if (!settings) return;
    const epoch = ++selectionWriteEpoch;
    selectionWriteFlight = selectionWriteFlight.then(async () => {
      try {
        await mergeTerminalSettingsRecord(settings, {
          analyst: { selection },
        });
        persistedSelection = selection;
        if (disposed || epoch !== selectionWriteEpoch) return;
        dispatch({ type: "selection-saved" });
        selectionSavedTimer = setTimeout(() => {
          selectionSavedTimer = null;
          dispatch({ type: "selection-saved-clear" });
        }, 1_500);
      } catch {
        // best-effort — the current in-memory selection remains usable.
      }
    });
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
    const pendingSelectionWrite = selectionWriteFlight;
    const pendingStartController = startController;
    disposed = true;
    stores.delete(operationId);
    invalidateRun();
    if (selectionSavedTimer !== null) clearTimeout(selectionSavedTimer);
    listeners.clear();
    pendingStartController?.abort();
    const flight = (async () => {
      if (previousDisposal) await previousDisposal;
      if (pendingStart) await pendingStart.catch(() => {});
      if (pendingReset) await pendingReset.catch(() => {});
      if (pendingStop) await pendingStop.catch(() => {});
      await pendingSelectionWrite;
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
      // Output language belongs to the server session created by this start. Later global
      // language changes update panel copy live, but apply to output only after reset/restart.
      const selection = { cliId: state.cliId, model: state.model, effort: state.effort, ...(language ? { language } : {}) };
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
      dispatch({ type: "selection-lock", locked: true });
      const shouldStopServer = state.started || state.phase !== "idle" || state.entries.length > 0 || state.artifacts.length > 0;
      invalidateRun();
      const flight = (async () => {
        if (stopFlight) await stopFlight;
        if (startFlight) await startFlight.catch(() => {});
        await selectionWriteFlight;
        if (shouldStopServer) await stopAnalysis(api, operationId);
        await clearAnalysisArtifacts(api, operationId).catch(() => {});
        dispatch({ type: "reset", selection: persistedSelection });
      })().catch((error: unknown) => {
        dispatch({ type: "error", message: `Reset failed: ${failureMessage(error)}`, now: Date.now() });
        throw error;
      });
      resetFlight = flight;
      try {
        await flight;
      } finally {
        if (resetFlight === flight) resetFlight = null;
        dispatch({ type: "selection-lock", locked: false });
      }
    },
    // 카탈로그는 AI Gateway 선별에서 나오고 그 선별은 Console 설정에서 바뀐다 — 설정을 다녀오는 동안
    // 이 store는 살아 있으므로(Operation 단위 수명), 다시 열 때 읽지 않으면 방금 추가한 모델이
    // 목록에 영원히 없다. 선택이 잠긴 뒤(started)에는 읽지 않는다 — 진행 중 세션의 표시 선택을
    // 뒤에서 갈아끼우게 된다. 현재 선택을 그대로 넘겨 아직 고를 수 있는 값이면 사용자의 선택이 산다.
    refreshCatalog: () => {
      if (state.started || catalogFlight) return;
      catalogFlight = fetchAnalysisCatalog(api)
        .then((catalog) => {
          if (disposed || state.started) return;
          dispatch({ type: "catalog", catalog, selection: { cliId: state.cliId, model: state.model, effort: state.effort } });
        })
        // 목록 갱신 실패는 조용히 지나간다 — 이미 들고 있는 카탈로그로 계속 쓸 수 있고,
        // 여기서 오류 문구를 띄우면 아직 아무것도 요청하지 않은 화면이 실패한 것처럼 읽힌다.
        .catch(() => undefined)
        .finally(() => { catalogFlight = null; });
    },
    dispose,
    updateContext: (settings, nextLanguage) => {
      if (settings) settingsCapability = settings;
      language = nextLanguage;
    },
  };

  const previousDisposal = disposalFlights.get(operationId);
  void (previousDisposal ?? Promise.resolve())
    .then(() => Promise.all([fetchAnalysisCatalog(api), readPersistedSelection(settingsCapability)]))
    .then(([catalog, selection]) => {
      persistedSelection = selection;
      dispatch({ type: "catalog", catalog, selection });
    })
    .catch((error: unknown) => dispatch({ type: "error", message: failureMessage(error), now: Date.now() }));

  return store;
}

async function readPersistedSelection(settings: ClientSettingsCapability | undefined): Promise<AnalysisSelection | null> {
  if (!settings) return null;
  try {
    const current = await settings.read("terminal");
    if (!current) return null;
    const analyst = record(current["analyst"]);
    const selection = record(analyst["selection"]);
    if (typeof selection["cliId"] !== "string"
      || typeof selection["model"] !== "string"
      || typeof selection["effort"] !== "string") return null;
    const persisted = {
      cliId: selection["cliId"],
      model: selection["model"] === "fable" ? "fable[1m]" : selection["model"],
      effort: selection["effort"],
    };
    // 이전 Fable id는 새 카탈로그와 맞춘 뒤 한 번 저장한다. 저장 실패가 현재 복원을 막지는 않는다.
    if (persisted.model !== selection["model"]) {
      await mergeTerminalSettingsRecord(settings, { analyst: { selection: persisted } }).catch(() => {});
    }
    return persisted;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Analysis is unavailable.";
}

function isLostSessionCode(code: string): boolean {
  return code === "analysis_exited" || code === "analysis_session_not_found";
}
