import { useSyncExternalStore } from "react";

import {
  deleteCarrierTaskForceBackend,
  fetchCarrierSettingsOptions,
  fetchCarrierSettingsState,
  patchCarrier,
  setCarrierTaskForceBackend,
} from "./api.js";
import type { CarrierSettingsOptions, CarrierSettingsState } from "../../shared/carrier-settings-types.js";

interface ModelSelection {
  readonly model: string;
  readonly effort?: string;
}

export interface CarrierSettingsPatch {
  readonly cli?: string;
  readonly model?: ModelSelection;
  readonly displayName?: string;
}

interface CarrierSettingsStoreState {
  readonly loading: boolean;
  readonly state: CarrierSettingsState | null;
  readonly options: CarrierSettingsOptions | null;
  readonly activeCarrierId: string | null;
  readonly savingActionId: string | null;
  readonly error: string | null;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let snapshot: CarrierSettingsStoreState = {
  loading: false,
  state: null,
  options: null,
  activeCarrierId: null,
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
  setSnapshot({
    activeCarrierId: carrierId,
    error: null,
  });
}

export async function saveCarrierPatch(patch: CarrierSettingsPatch): Promise<boolean> {
  const carrier = getActiveCarrier();
  if (!carrier || snapshot.savingActionId !== null) return false;
  return runMutation("carrier-patch", () => patchCarrier(carrier.carrierId, patch));
}

export async function saveTaskForceBackend(cliType: string, selection: ModelSelection): Promise<boolean> {
  const carrier = getActiveCarrier();
  if (!carrier || snapshot.savingActionId !== null) return false;
  return runMutation(`taskforce-save:${cliType}`, () => setCarrierTaskForceBackend(carrier.carrierId, cliType, selection));
}

export async function removeTaskForceBackend(cliType: string): Promise<boolean> {
  const carrier = getActiveCarrier();
  if (!carrier || snapshot.savingActionId !== null) return false;
  return runMutation(`taskforce-remove:${cliType}`, () => deleteCarrierTaskForceBackend(carrier.carrierId, cliType));
}

export function hydrateCarrierSettings(state: CarrierSettingsState, options: CarrierSettingsOptions): void {
  const activeCarrierId = resolveActiveCarrierId(state, snapshot.activeCarrierId);
  setSnapshot({
    loading: false,
    state,
    options,
    activeCarrierId,
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
    const message = toErrorMessage(error);
    setSnapshot({ error: message });
    await loadCarrierSettings();
    setSnapshot({ savingActionId: null, error: message });
    return false;
  }
}

function getActiveCarrier() {
  return snapshot.state?.carriers.find((carrier) => carrier.carrierId === snapshot.activeCarrierId) ?? null;
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
