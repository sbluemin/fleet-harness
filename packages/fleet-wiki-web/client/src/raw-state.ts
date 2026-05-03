import { fetchRaw } from "./api";

export interface RawSourceState {
  ref: string | null;
  content: string | null;
  loading: boolean;
  error: string | null;
}

type RawListener = (state: RawSourceState) => void;

const listeners = new Set<RawListener>();
const state: RawSourceState = {
  ref: null,
  content: null,
  loading: false,
  error: null,
};

export function getRawState(): RawSourceState {
  return state;
}

export function subscribeRawState(listener: RawListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function loadRawSource(ref: string): Promise<void> {
  if (state.ref === ref && state.content !== null && !state.error) return;
  setState({ ref, content: null, loading: true, error: null });
  try {
    const content = await fetchRaw(ref);
    if (state.ref !== ref) return;
    setState({ content, loading: false });
  } catch (error) {
    if (state.ref !== ref) return;
    setState({ loading: false, error: errorMessage(error) });
  }
}

export function clearRawState(): void {
  setState({ ref: null, content: null, loading: false, error: null });
}

function setState(next: Partial<RawSourceState>): void {
  Object.assign(state, next);
  for (const listener of listeners) listener(state);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
