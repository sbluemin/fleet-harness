import { useSyncExternalStore } from "react";

import { fetchTheaterBootstrap } from "./api.js";
import { fetchModelAuthState, signInModelProvider, signOutModelProvider } from "./model-auth-api.js";
import { hydrateTheaterBootstrap } from "./store.js";
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
    await refreshLaunchMetadata();
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
    await refreshLaunchMetadata();
    return true;
  } catch (error) {
    setSnapshot({ busyCli: null, error: toErrorMessage(error) });
    return false;
  }
}

// 로그인/로그아웃으로 signedIn이 바뀌면 launch 메뉴의 게이트가 즉시 반영되도록 theater bootstrap을 다시
// 적재해 state.agentClis를 갱신한다(agentClis는 부트스트랩에서만 채워지므로 갱신하지 않으면 stale해진다).
// 갱신 실패는 무시한다 — 기존 값이 유지되고 다음 부트스트랩에서 다시 동기화된다.
async function refreshLaunchMetadata(): Promise<void> {
  try {
    hydrateTheaterBootstrap(await fetchTheaterBootstrap());
  } catch {
    // no-op
  }
}

function setSnapshot(patch: Partial<ModelAuthStoreState>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
