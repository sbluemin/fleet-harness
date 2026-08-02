import { React } from "@fleet-console/sdk/plugin/browser";

import { fetchSystemPromptSettings, saveSystemPromptSettings, type SystemPromptSettingsState, type SystemPromptSettingsUpdate } from "./settings-api.js";

// aiGatewayCatalog는 서버 소유 읽기 전용 투영이라 저장 필드에서 제외한다.
export type SystemPromptSettingsField = "enableMetaphor" | "agentIdleDormantMinutes" | "aiGateway";

interface SystemPromptSettingsStoreState {
  readonly loading: boolean;
  readonly state: SystemPromptSettingsState | null;
  readonly savingField: SystemPromptSettingsField | null;
  readonly error: string | null;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let snapshot: SystemPromptSettingsStoreState = {
  loading: false,
  state: null,
  savingField: null,
  error: null,
};
// 로드 세대값. 저장(낙관적 갱신)이 시작되면 증가시켜, 그 이전에 출발한 in-flight GET 응답을 폐기한다.
let loadGeneration = 0;

export function useSystemPromptSettingsStore(): SystemPromptSettingsStoreState {
  return React.useSyncExternalStore(subscribe, getSystemPromptSettingsStoreState, getSystemPromptSettingsStoreState);
}

export function getSystemPromptSettingsStoreState(): SystemPromptSettingsStoreState {
  return snapshot;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function loadSystemPromptSettings(signal?: AbortSignal): Promise<void> {
  const generation = ++loadGeneration;
  setSnapshot({ loading: true, error: null });
  try {
    const state = await fetchSystemPromptSettings(signal);
    // 저장이 끼어들어 세대가 바뀌었으면 stale 응답이므로 저장 결과를 덮지 않는다.
    if (generation !== loadGeneration) return;
    setSnapshot({ loading: false, state, error: null });
  } catch (error) {
    if (signal?.aborted || generation !== loadGeneration) return;
    setSnapshot({ loading: false, error: toErrorMessage(error) });
  }
}

export async function setSystemPromptSettingsField<Field extends SystemPromptSettingsField>(
  field: Field,
  value: SystemPromptSettingsState[Field],
): Promise<boolean> {
  const current = snapshot.state;
  if (!current) return false;
  // 진행 중인 로드 응답이 이 저장 결과를 덮지 않도록 세대값을 올린다.
  loadGeneration += 1;
  const optimistic = { ...current, [field]: value };
  const update = toSettingsUpdate(field, optimistic);
  setSnapshot({ state: optimistic, savingField: field, error: null });
  try {
    const state = await saveSystemPromptSettings(update);
    setSnapshot({ state, savingField: null, error: null });
    return true;
  } catch (error) {
    setSnapshot({ state: current, savingField: null, error: toErrorMessage(error) });
    return false;
  }
}

function toSettingsUpdate(field: SystemPromptSettingsField, state: SystemPromptSettingsState): SystemPromptSettingsUpdate {
  if (field === "enableMetaphor") return { enableMetaphor: state.enableMetaphor };
  if (field === "aiGateway") return { aiGateway: state.aiGateway };
  return { agentIdleDormantMinutes: state.agentIdleDormantMinutes };
}

function setSnapshot(patch: Partial<SystemPromptSettingsStoreState>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
