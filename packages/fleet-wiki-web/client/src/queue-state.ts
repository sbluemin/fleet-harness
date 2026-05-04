import { approveQueuePatch, fetchPatchDetail, fetchQueueList, rejectQueuePatch } from "./api";
import type { PatchDetailResponse, QueueListItem } from "./api";
import { navigate, queuePath } from "./router";
import { setPendingPatchCount } from "./state";
import { t } from "./i18n/t";

export interface QueueState {
  tab: "pending" | "archived";
  items: QueueListItem[];
  pendingCount: number;
  archivedCount: number;
  current: PatchDetailResponse | null;
  loading: boolean;
  error: string | null;
  actionPending: boolean;
  actionError: string | null;
}

type QueueStateListener = (state: QueueState) => void;

const listeners = new Set<QueueStateListener>();
const state: QueueState = {
  tab: "pending",
  items: [],
  pendingCount: 0,
  archivedCount: 0,
  current: null,
  loading: false,
  error: null,
  actionPending: false,
  actionError: null,
};

export function getQueueState(): QueueState {
  return state;
}

export function subscribeQueueState(listener: QueueStateListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function loadQueueList(tab: "pending" | "archived"): Promise<void> {
  setQueueState({ tab, loading: true, error: null, current: null });
  try {
    const data = await fetchQueueList(tab);
    setQueueState({
      items: data.items,
      pendingCount: data.pendingCount,
      archivedCount: data.archivedCount,
      loading: false,
    });
    setPendingPatchCount(data.pendingCount);
  } catch (error) {
    setQueueState({ loading: false, error: errorMessage(error) });
  }
}

export async function loadPatchDetail(patchId: string): Promise<void> {
  setQueueState({ loading: true, error: null, current: null });
  try {
    const data = await fetchPatchDetail(patchId);
    setQueueState({ current: data, loading: false });
  } catch (error) {
    setQueueState({ loading: false, error: errorMessage(error) });
  }
}

export function clearQueueState(): void {
  setQueueState({ items: [], current: null, error: null, loading: false, actionPending: false, actionError: null });
}

export async function approveCurrentPatch(): Promise<void> {
  if (state.actionPending) return;
  const patchId = state.current?.meta.id;
  if (!patchId) return;
  setQueueState({ actionPending: true, actionError: null });
  try {
    await approveQueuePatch(patchId);
    const data = await fetchQueueList("pending");
    setQueueState({ actionPending: false, pendingCount: data.pendingCount, archivedCount: data.archivedCount });
    setPendingPatchCount(data.pendingCount);
    navigate(queuePath("archived"));
  } catch (error) {
    setQueueState({ actionPending: false, actionError: errorMessage(error) });
  }
}

export async function rejectCurrentPatch(reason: string): Promise<void> {
  if (state.actionPending) return;
  const patchId = state.current?.meta.id;
  if (!patchId) return;
  const trimmed = reason.trim();
  if (!trimmed || trimmed.length > 256) {
    setQueueState({ actionError: trimmed ? t("queue.rejectErrorLength") : t("queue.rejectErrorRequired") });
    return;
  }
  setQueueState({ actionPending: true, actionError: null });
  try {
    await rejectQueuePatch(patchId, trimmed);
    const data = await fetchQueueList("pending");
    setQueueState({ actionPending: false, pendingCount: data.pendingCount, archivedCount: data.archivedCount });
    setPendingPatchCount(data.pendingCount);
    navigate(queuePath("archived"));
  } catch (error) {
    setQueueState({ actionPending: false, actionError: errorMessage(error) });
  }
}

function setQueueState(next: Partial<QueueState>): void {
  Object.assign(state, next);
  for (const listener of listeners) listener(state);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
