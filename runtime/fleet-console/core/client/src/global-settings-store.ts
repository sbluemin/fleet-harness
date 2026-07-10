import { useSyncExternalStore } from "react";

import { fetchGlobalSettingsState, updateGlobalSettings } from "./global-settings-api.js";
import type { GlobalSettingsState } from "./types.js";

export type GlobalSettingsField = keyof GlobalSettingsState;

interface GlobalSettingsStoreState {
  readonly loading: boolean;
  readonly state: GlobalSettingsState | null;
  readonly savingField: GlobalSettingsField | null;
  readonly error: string | null;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let snapshot: GlobalSettingsStoreState = {
  loading: false,
  state: null,
  savingField: null,
  error: null,
};

export function useGlobalSettingsStore(): GlobalSettingsStoreState {
  return useSyncExternalStore(subscribe, getGlobalSettingsStoreState, getGlobalSettingsStoreState);
}

export function getGlobalSettingsStoreState(): GlobalSettingsStoreState {
  return snapshot;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function loadGlobalSettings(signal?: AbortSignal): Promise<void> {
  setSnapshot({ loading: true, error: null });
  try {
    const state = await fetchGlobalSettingsState(signal);
    setSnapshot({ loading: false, state, error: null });
  } catch (error) {
    if (signal?.aborted) return;
    setSnapshot({ loading: false, error: toErrorMessage(error) });
  }
}

export async function setGlobalSettingsField<Field extends GlobalSettingsField>(field: Field, value: GlobalSettingsState[Field]): Promise<boolean> {
  if (snapshot.savingField !== null) return false;
  const previousState = snapshot.state;
  const optimisticState = previousState ? { ...previousState, [field]: value } as GlobalSettingsState : null;
  setSnapshot({ state: optimisticState, savingField: field, error: null });
  try {
    const result = await updateGlobalSettings({ [field]: value });
    setSnapshot({ state: result.state, savingField: null, error: null });
    return true;
  } catch (error) {
    setSnapshot({ state: previousState, savingField: null, error: toErrorMessage(error) });
    return false;
  }
}

function setSnapshot(patch: Partial<GlobalSettingsStoreState>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
