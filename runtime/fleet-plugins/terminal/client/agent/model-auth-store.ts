import { React } from "@fleet-console/sdk/plugin/browser";

import { fetchAgentState } from "./api.js";
import { fetchModelAuthState, signInModelProvider, signOutModelProvider, type ModelAuthState } from "./model-auth-api.js";
import { hydrateAgentClis } from "./store.js";

interface ModelAuthStoreState {
  readonly loading: boolean;
  readonly state: ModelAuthState | null;
  readonly busyProvider: string | null;
  readonly error: string | null;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let snapshot: ModelAuthStoreState = {
  loading: false,
  state: null,
  busyProvider: null,
  error: null,
};
let requestGeneration = 0;

export function useModelAuthStore(): ModelAuthStoreState {
  return React.useSyncExternalStore(subscribe, getModelAuthStoreState, getModelAuthStoreState);
}

export function getModelAuthStoreState(): ModelAuthStoreState {
  return snapshot;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function loadModelAuth(signal?: AbortSignal): Promise<void> {
  const generation = ++requestGeneration;
  setSnapshot({ loading: true, error: null });
  try {
    const state = await fetchModelAuthState(signal);
    if (generation !== requestGeneration) return;
    setSnapshot({ loading: false, state, error: null });
  } catch (error) {
    if (signal?.aborted || generation !== requestGeneration) return;
    setSnapshot({ loading: false, error: toErrorMessage(error) });
  }
}

export async function signInModel(provider: string, apiKey: string): Promise<boolean> {
  const generation = ++requestGeneration;
  setSnapshot({ busyProvider: provider, error: null });
  try {
    const result = await signInModelProvider(provider, apiKey);
    if (generation !== requestGeneration) return true;
    setSnapshot({ state: result.state, busyProvider: null, error: null });
    await refreshLaunchMetadata();
    return true;
  } catch (error) {
    if (generation !== requestGeneration) return false;
    setSnapshot({ busyProvider: null, error: toErrorMessage(error) });
    return false;
  }
}

export async function signOutModel(provider: string): Promise<boolean> {
  const generation = ++requestGeneration;
  setSnapshot({ busyProvider: provider, error: null });
  try {
    const result = await signOutModelProvider(provider);
    if (generation !== requestGeneration) return true;
    setSnapshot({ state: result.state, busyProvider: null, error: null });
    await refreshLaunchMetadata();
    return true;
  } catch (error) {
    if (generation !== requestGeneration) return false;
    setSnapshot({ busyProvider: null, error: toErrorMessage(error) });
    return false;
  }
}

async function refreshLaunchMetadata(): Promise<void> {
  try {
    hydrateAgentClis(await fetchAgentState());
  } catch {
    // A later bootstrap refreshes metadata if this best-effort request fails.
  }
}

function setSnapshot(patch: Partial<ModelAuthStoreState>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
