import { useSyncExternalStore } from "react";

import { fetchAgentCliState } from "./agent-cli-api.js";
import type { AgentCliState } from "./types.js";

interface AgentCliStoreState {
  readonly loading: boolean;
  readonly state: AgentCliState | null;
  readonly error: string | null;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let snapshot: AgentCliStoreState = {
  loading: false,
  state: null,
  error: null,
};

export function useAgentCliStore(): AgentCliStoreState {
  return useSyncExternalStore(subscribe, getAgentCliStoreState, getAgentCliStoreState);
}

export function getAgentCliStoreState(): AgentCliStoreState {
  return snapshot;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function loadAgentCliState(signal?: AbortSignal): Promise<void> {
  setSnapshot({ loading: true, error: null });
  try {
    const state = await fetchAgentCliState(signal);
    setSnapshot({ loading: false, state, error: null });
  } catch (error) {
    if (signal?.aborted) return;
    setSnapshot({ loading: false, error: toErrorMessage(error) });
  }
}

function setSnapshot(patch: Partial<AgentCliStoreState>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
