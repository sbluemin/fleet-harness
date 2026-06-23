import { useSyncExternalStore } from "react";

import {
  deleteCarrierTaskForceBackend,
  fetchCarrierSettingsOptions,
  fetchCarrierSettingsState,
  setCarrierTaskForceBackend,
  updateCarrierAgentMode,
  updateCarrierCli,
  updateCarrierDisplayName,
  updateCarrierModel,
} from "./carrier-settings-api.js";
import type {
  CarrierSettingsAgentMode,
  CarrierSettingsCarrier,
  CarrierSettingsOptions,
  CarrierSettingsState,
} from "./types.js";

interface CarrierSettingsDraft {
  readonly cliType: string;
  readonly model: string;
  readonly effort: string;
  readonly displayName: string;
  readonly agentMode: CarrierSettingsAgentMode;
  readonly taskforce: Readonly<Record<string, { readonly model: string; readonly effort: string }>>;
}

export interface CarrierSettingsTaskForceSaveInput {
  readonly cliType: string;
  readonly model: string;
  readonly effort?: string;
}

interface CarrierSettingsStoreState {
  readonly loading: boolean;
  readonly state: CarrierSettingsState | null;
  readonly options: CarrierSettingsOptions | null;
  readonly activeCarrierId: string | null;
  readonly draft: CarrierSettingsDraft;
  readonly savingActionId: string | null;
  readonly error: string | null;
}

type Listener = () => void;

const EMPTY_DRAFT: CarrierSettingsDraft = {
  cliType: "",
  model: "",
  effort: "",
  displayName: "",
  agentMode: "cli",
  taskforce: {},
};

const listeners = new Set<Listener>();
let snapshot: CarrierSettingsStoreState = {
  loading: false,
  state: null,
  options: null,
  activeCarrierId: null,
  draft: EMPTY_DRAFT,
  savingActionId: null,
  error: null,
};

export function useCarrierSettingsStore(): CarrierSettingsStoreState {
  return useSyncExternalStore(subscribe, getCarrierSettingsStoreState, getCarrierSettingsStoreState);
}

export function getCarrierSettingsStoreState(): CarrierSettingsStoreState {
  return snapshot;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function loadCarrierSettings(signal?: AbortSignal): Promise<void> {
  setSnapshot({ loading: true, error: null });
  try {
    const [state, options] = await Promise.all([
      fetchCarrierSettingsState(signal),
      fetchCarrierSettingsOptions(signal),
    ]);
    hydrateCarrierSettings(state, options);
  } catch (error) {
    if (signal?.aborted) return;
    setSnapshot({ loading: false, error: toErrorMessage(error) });
  }
}

export function selectCarrierSettingsCarrier(carrierId: string): void {
  const carrier = snapshot.state?.carriers.find((item) => item.carrierId === carrierId);
  setSnapshot({
    activeCarrierId: carrierId,
    draft: carrier ? buildDraft(carrier, snapshot.options) : snapshot.draft,
    error: null,
  });
}

export function updateCarrierSettingsDraft(patch: Partial<CarrierSettingsDraft>): void {
  setSnapshot({ draft: { ...snapshot.draft, ...patch }, error: null });
}

export function updateCarrierSettingsTaskForceDraft(cliType: string, patch: { readonly model?: string; readonly effort?: string }): void {
  const current = snapshot.draft.taskforce[cliType] ?? { model: "", effort: "" };
  setSnapshot({
    draft: {
      ...snapshot.draft,
      taskforce: {
        ...snapshot.draft.taskforce,
        [cliType]: { ...current, ...patch },
      },
    },
    error: null,
  });
}

export function resetCarrierSettingsDraft(): void {
  const carrier = getActiveCarrier();
  if (!carrier) return;
  setSnapshot({ draft: buildDraft(carrier, snapshot.options), error: null });
}

export async function saveCarrierAll(desiredTaskForce: readonly CarrierSettingsTaskForceSaveInput[]): Promise<boolean> {
  const carrier = getActiveCarrier();
  if (!carrier) return false;
  return runMutation("save-all", async () => {
    const draft = snapshot.draft;
    let latestState: CarrierSettingsState | null = null;
    if (draft.displayName !== carrier.displayName) {
      latestState = (await updateCarrierDisplayName(carrier.carrierId, draft.displayName)).state;
    }
    const cliChanged = draft.cliType !== carrier.cliType;
    if (cliChanged) {
      latestState = (await updateCarrierCli(carrier.carrierId, draft.cliType)).state;
    }
    // CLI 변경 시 updateCarrierCli가 대상 CLI에 저장돼 있던 이전 선택을 복원할 수 있다.
    // 변경 전(구 CLI) carrier와의 모델 비교만으로 PUT을 건너뛰면, 신 CLI 기본값이 구 CLI
    // 모델과 우연히 같을 때 복원된 선택이 draft와 다르게 저장된다. CLI가 바뀌었으면 항상
    // draft 모델을 명시 전송해 사용자가 본 draft 선택이 우선되게 한다.
    if (cliChanged || draft.model !== carrier.model || (draft.effort || "") !== (carrier.effort || "")) {
      latestState = (await updateCarrierModel(carrier.carrierId, selectionFromDraft(draft))).state;
    }
    if (draft.agentMode === "subagent") {
      // 이미 subagent여도 서버에 TF 백엔드가 남아 있으면(불일치 데이터) SA-enable PUT을 보내
      // 서버가 TF를 원자적으로 정리하게 한다. carrier.agentMode만 보고 스킵하면 stale TF가 남는다.
      if (carrier.agentMode !== "subagent" || carrier.taskForceBackendCount > 0) {
        latestState = (await updateCarrierAgentMode(carrier.carrierId, "subagent")).state;
      }
    } else {
      if (carrier.agentMode !== "cli") {
        latestState = (await updateCarrierAgentMode(carrier.carrierId, "cli")).state;
      }
      latestState = await saveTaskForceForCarrier(carrier, desiredTaskForce, latestState);
    }
    return { state: latestState ?? await fetchCarrierSettingsState() };
  });
}

function hydrateCarrierSettings(state: CarrierSettingsState, options: CarrierSettingsOptions): void {
  const activeCarrierId = resolveActiveCarrierId(state, snapshot.activeCarrierId);
  const carrier = state.carriers.find((item) => item.carrierId === activeCarrierId) ?? null;
  setSnapshot({
    loading: false,
    state,
    options,
    activeCarrierId,
    draft: carrier ? buildDraft(carrier, options) : snapshot.draft,
    error: null,
  });
}

async function runMutation(actionId: string, operation: () => Promise<{ readonly state: CarrierSettingsState }>): Promise<boolean> {
  setSnapshot({ savingActionId: actionId, error: null });
  try {
    const result = await operation();
    hydrateCarrierSettings(result.state, snapshot.options ?? { cliTypes: [], taskForceConstraints: { minBackends: 2 } });
    setSnapshot({ savingActionId: null });
    return true;
  } catch (error) {
    setSnapshot({ savingActionId: null, error: toErrorMessage(error) });
    return false;
  }
}

function buildDraft(carrier: CarrierSettingsCarrier, options: CarrierSettingsOptions | null): CarrierSettingsDraft {
  const taskforce = Object.fromEntries(
    (options?.cliTypes ?? []).map((cli) => {
      const backend = carrier.taskforce.backends.find((item) => item.cliType === cli.id);
      return [cli.id, {
        model: backend?.model ?? cli.defaultModel,
        effort: backend?.effort ?? defaultEffortForModel(cli.id, backend?.model ?? cli.defaultModel, options) ?? "",
      }];
    }),
  );
  return {
    cliType: carrier.cliType,
    model: carrier.model,
    effort: carrier.effort ?? "",
    displayName: carrier.displayName,
    agentMode: carrier.agentMode,
    taskforce,
  };
}

function defaultEffortForModel(cliType: string, modelId: string, options: CarrierSettingsOptions | null): string | null {
  const cli = options?.cliTypes.find((item) => item.id === cliType);
  const model = cli?.models.find((item) => item.modelId === modelId);
  return model?.effort?.default ?? null;
}

function selectionFromDraft(draft: CarrierSettingsDraft): { readonly model: string; readonly effort?: string } {
  return {
    model: draft.model,
    ...(draft.effort ? { effort: draft.effort } : {}),
  };
}

function getActiveCarrier(): CarrierSettingsCarrier | null {
  return snapshot.state?.carriers.find((carrier) => carrier.carrierId === snapshot.activeCarrierId) ?? null;
}

async function saveTaskForceForCarrier(
  carrier: CarrierSettingsCarrier,
  desired: readonly CarrierSettingsTaskForceSaveInput[],
  latestState: CarrierSettingsState | null,
): Promise<CarrierSettingsState | null> {
  const desiredCliTypes = new Set(desired.map((backend) => backend.cliType));
  for (const backend of carrier.taskforce.backends) {
    if (!desiredCliTypes.has(backend.cliType)) {
      latestState = (await deleteCarrierTaskForceBackend(carrier.carrierId, backend.cliType)).state;
    }
  }
  for (const backend of desired) {
    const current = carrier.taskforce.backends.find((item) => item.cliType === backend.cliType);
    if (current && current.model === backend.model && (current.effort || "") === (backend.effort || "")) continue;
    latestState = (await setCarrierTaskForceBackend(carrier.carrierId, backend.cliType, {
      model: backend.model,
      ...(backend.effort ? { effort: backend.effort } : {}),
    })).state;
  }
  return latestState;
}

function resolveActiveCarrierId(state: CarrierSettingsState, activeCarrierId: string | null): string | null {
  if (activeCarrierId && state.carriers.some((carrier) => carrier.carrierId === activeCarrierId)) return activeCarrierId;
  return state.carriers[0]?.carrierId ?? null;
}

function setSnapshot(patch: Partial<CarrierSettingsStoreState>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
