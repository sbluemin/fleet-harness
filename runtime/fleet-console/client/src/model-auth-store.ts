import { useSyncExternalStore } from "react";

import { fetchModelAuthState, signInModelProvider, signOutModelProvider } from "./model-auth-api.js";
import type { ModelAuthState } from "./types.js";

interface ModelAuthStoreState {
  readonly loading: boolean;
  readonly state: ModelAuthState | null;
  readonly busyCli: string | null;
  readonly error: string | null;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let snapshot: ModelAuthStoreState = {
  loading: false,
  state: null,
  busyCli: null,
  error: null,
};

export function useModelAuthStore(): ModelAuthStoreState {
  return useSyncExternalStore(subscribe, getModelAuthStoreState, getModelAuthStoreState);
}

export function getModelAuthStoreState(): ModelAuthStoreState {
  return snapshot;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function loadModelAuth(signal?: AbortSignal): Promise<void> {
  setSnapshot({ loading: true, error: null });
  try {
    const state = await fetchModelAuthState(signal);
    setSnapshot({ loading: false, state, error: null });
  } catch (error) {
    if (signal?.aborted) return;
    setSnapshot({ loading: false, error: toErrorMessage(error) });
  }
}

export async function signInModel(cli: string, apiKey: string): Promise<boolean> {
  setSnapshot({ busyCli: cli, error: null });
  try {
    const result = await signInModelProvider(cli, apiKey);
    setSnapshot({ state: result.state, busyCli: null, error: null });
    return true;
  } catch (error) {
    setSnapshot({ busyCli: null, error: toErrorMessage(error) });
    return false;
  }
}

export async function signOutModel(cli: string): Promise<boolean> {
  setSnapshot({ busyCli: cli, error: null });
  try {
    const result = await signOutModelProvider(cli);
    setSnapshot({ state: result.state, busyCli: null, error: null });
    return true;
  } catch (error) {
    setSnapshot({ busyCli: null, error: toErrorMessage(error) });
    return false;
  }
}

function setSnapshot(patch: Partial<ModelAuthStoreState>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
