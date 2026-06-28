import { useSyncExternalStore } from "react";

import { fetchApiCatalog } from "./backend-api-catalog-api.js";
import type { ApiCatalogEntry } from "./types.js";

interface ApiCatalogStoreState {
  readonly loading: boolean;
  readonly state: readonly ApiCatalogEntry[] | null;
  readonly error: string | null;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let snapshot: ApiCatalogStoreState = {
  loading: false,
  state: null,
  error: null,
};

export function useApiCatalogStore(): ApiCatalogStoreState {
  return useSyncExternalStore(subscribe, getApiCatalogStoreState, getApiCatalogStoreState);
}

export function getApiCatalogStoreState(): ApiCatalogStoreState {
  return snapshot;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function loadApiCatalog(signal?: AbortSignal): Promise<void> {
  setSnapshot({ loading: true, error: null });
  try {
    const state = await fetchApiCatalog(signal);
    setSnapshot({ loading: false, state, error: null });
  } catch (error) {
    if (signal?.aborted) return;
    setSnapshot({ loading: false, error: toErrorMessage(error) });
  }
}

function setSnapshot(patch: Partial<ApiCatalogStoreState>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
