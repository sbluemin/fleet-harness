import { useSyncExternalStore } from "react";

import { fetchGlobalSettingsState, updateGlobalSettings } from "./global-settings-api.js";
import type { GlobalSettingsState } from "./types.js";

export type GlobalSettingsField = keyof GlobalSettingsState;

interface GlobalSettingsStoreState {
  readonly loadStatus: "pending" | "ready" | "failed";
  readonly loading: boolean;
  readonly state: GlobalSettingsState | null;
  /** 지금 저장 중인 필드 중 하나. 아무것도 저장 중이 아니면 null. */
  readonly savingField: GlobalSettingsField | null;
  readonly error: string | null;
  /** 마지막 저장이 실패한 필드. 화면이 어느 설정이 되돌아갔는지 말할 수 있게 한다. */
  readonly failedField: GlobalSettingsField | null;
}

type Listener = () => void;

const listeners = new Set<Listener>();
/**
 * 저장이 진행 중인 필드들. 예전에는 이 자리가 단일 값이어서 어떤 필드든 저장 중이면 무관한
 * 필드의 저장까지 거부됐고, 거부된 쪽은 아무 말 없이 사라졌다 — 연달아 저장되는 설정 중
 * 뒤엣것이 조용히 유실되는 경로다.
 */
const savingFields = new Set<GlobalSettingsField>();
let snapshot: GlobalSettingsStoreState = {
  loadStatus: "pending",
  loading: false,
  state: null,
  savingField: null,
  error: null,
  failedField: null,
};

export function useGlobalSettingsStore(): GlobalSettingsStoreState {
  return useSyncExternalStore(subscribe, getGlobalSettingsStoreState, getGlobalSettingsStoreState);
}

export function getGlobalSettingsStoreState(): GlobalSettingsStoreState {
  return snapshot;
}

export function hydrateGlobalSettings(state: GlobalSettingsState): void {
  setSnapshot({ loadStatus: "ready", loading: false, state, error: null });
}

export function failGlobalSettingsLoad(error: unknown): void {
  // 마지막으로 성공한 상태는 지우지 않는다. 일시적인 읽기 실패가 콘솔을 설정 없는 상태로
  // 떨어뜨리면 사용자에게 남는 선택지는 리로드뿐이다.
  setSnapshot({ loadStatus: "failed", loading: false, error: toErrorMessage(error) });
}

/** 이 필드가 지금 저장 중인지. 무관한 필드의 저장을 기다리지 않으려는 호출자를 위한 것이다. */
export function isSavingGlobalSettingsField(field: GlobalSettingsField): boolean {
  return savingFields.has(field);
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
    setSnapshot({ loadStatus: "ready", loading: false, state, error: null });
  } catch (error) {
    if (signal?.aborted) return;
    setSnapshot({ loadStatus: "failed", loading: false, error: toErrorMessage(error) });
  }
}

export async function setGlobalSettingsField<Field extends GlobalSettingsField>(field: Field, value: GlobalSettingsState[Field]): Promise<boolean> {
  // 같은 필드에 대한 겹친 저장만 막는다. 다른 필드는 서로를 기다릴 이유가 없고, 기다리게 하면
  // 그 사이 눌린 설정이 아무 말 없이 버려진다.
  if (savingFields.has(field)) return false;
  const previousValue = snapshot.state ? snapshot.state[field] : undefined;
  const optimisticState = snapshot.state ? { ...snapshot.state, [field]: value } as GlobalSettingsState : null;
  savingFields.add(field);
  setSnapshot({ state: optimisticState, savingField: field, error: null, failedField: null });
  try {
    const result = await updateGlobalSettings({ [field]: value });
    savingFields.delete(field);
    // 서버 응답을 통째로 덮으면 그 사이 낙관적으로 반영된 다른 필드가 되감긴다. 이 요청이
    // 실제로 바꾼 필드만 서버 값으로 확정하고 나머지는 현재 스냅샷을 남긴다.
    const merged = snapshot.state
      ? { ...snapshot.state, [field]: result.state[field] } as GlobalSettingsState
      : result.state;
    setSnapshot({ state: merged, savingField: anySavingField(), error: null });
    return true;
  } catch (error) {
    savingFields.delete(field);
    // 이 필드만 되돌린다. 스냅샷 전체를 되돌리면 그동안 성공한 다른 필드의 저장까지 사라진다.
    const reverted = snapshot.state && previousValue !== undefined
      ? { ...snapshot.state, [field]: previousValue } as GlobalSettingsState
      : snapshot.state;
    setSnapshot({ state: reverted, savingField: anySavingField(), error: toErrorMessage(error), failedField: field });
    return false;
  }
}

function anySavingField(): GlobalSettingsField | null {
  for (const field of savingFields) return field;
  return null;
}

function setSnapshot(patch: Partial<GlobalSettingsStoreState>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
