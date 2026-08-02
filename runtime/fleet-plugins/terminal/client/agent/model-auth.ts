export interface ModelAuthProviderState {
  readonly provider: string;
  readonly displayName: string;
  readonly signedIn: boolean;
}

export interface ModelAuthState {
  readonly providers: readonly ModelAuthProviderState[];
}

export interface ModelAuthMutationResult {
  readonly state: ModelAuthState;
}

export class TerminalModelAuthApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TerminalModelAuthApiError";
    this.status = status;
  }
}

export async function fetchModelAuthState(signal?: AbortSignal): Promise<ModelAuthState> {
  const response = await fetch("/plugins/terminal/model-auth/state", { signal });
  await assertOk(response);
  return assertModelAuthState(await response.json(), response.status);
}

export async function signInModelProvider(provider: string, apiKey: string, signal?: AbortSignal): Promise<ModelAuthMutationResult> {
  const response = await fetch(`/plugins/terminal/model-auth/providers/${encodeURIComponent(provider)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
    signal,
  });
  await assertOk(response);
  return assertMutationResult(await response.json(), response.status);
}

export async function signOutModelProvider(provider: string, signal?: AbortSignal): Promise<ModelAuthMutationResult> {
  const response = await fetch(`/plugins/terminal/model-auth/providers/${encodeURIComponent(provider)}`, {
    method: "DELETE",
    signal,
  });
  await assertOk(response);
  return assertMutationResult(await response.json(), response.status);
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  let message = response.statusText || `HTTP ${response.status}`;
  try {
    const payload = await response.json() as { readonly error?: unknown };
    if (typeof payload.error === "string") message = payload.error;
  } catch {
    // Non-JSON failures keep the HTTP status text.
  }
  throw new TerminalModelAuthApiError(response.status, message);
}

function assertMutationResult(value: unknown, status: number): ModelAuthMutationResult {
  const payload = value as { readonly state?: unknown };
  if (!payload || typeof payload !== "object" || !("state" in payload)) {
    throw new TerminalModelAuthApiError(status, "Invalid model auth mutation response");
  }
  return { state: assertModelAuthState(payload.state, status) };
}

function assertModelAuthState(value: unknown, status: number): ModelAuthState {
  const payload = value as { readonly providers?: unknown };
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.providers)) {
    throw new TerminalModelAuthApiError(status, "Invalid model auth state response");
  }
  return { providers: payload.providers.map((provider) => assertProviderState(provider, status)) };
}

function assertProviderState(value: unknown, status: number): ModelAuthProviderState {
  const payload = value as Partial<ModelAuthProviderState>;
  if (
    typeof payload.provider !== "string"
    || typeof payload.displayName !== "string"
    || typeof payload.signedIn !== "boolean"
  ) {
    throw new TerminalModelAuthApiError(status, "Invalid model auth provider response");
  }
  return {
    provider: payload.provider,
    displayName: payload.displayName,
    signedIn: payload.signedIn,
  };
}

import { React } from "@fleet-console/sdk/plugin/browser";

import { fetchAgentState } from "./api.js";
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
