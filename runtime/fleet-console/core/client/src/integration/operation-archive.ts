// 보관함의 클라이언트 상태 — 사이드바의 「보관함 N」, 보관함 시트의 목록, 시트가 열려 있는지.
//
// 보관된 Operation은 일반 Operation 목록에 없다(Core가 별도 저장소에 둔다). 그래서 이 모듈은 일반 스토어에
// 보관 노드를 섞지 않고 자기 스냅숏만 든다. 수와 revision은 SSE(operation:archive-changed)가 알려 주고,
// 목록 본문은 시트가 열려 있을 때만 다시 읽는다.

import { useSyncExternalStore } from "react";

import {
  OPERATION_ARCHIVE_CHANGED_EVENT,
  OPERATION_CLUSTER_CHANGED_EVENT,
  fetchOperationArchive,
  type OperationArchiveSnapshot,
} from "@fleet-console/sdk/operations/browser";

interface ArchiveState {
  readonly total: number;
  readonly revision: number;
  /** 마지막으로 읽은 목록. 시트를 한 번도 열지 않았으면 null. */
  readonly snapshot: OperationArchiveSnapshot | null;
  readonly loading: boolean;
  readonly error: boolean;
  readonly sheetOpen: boolean;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let state: ArchiveState = { total: 0, revision: -1, snapshot: null, loading: false, error: false, sheetOpen: false };
let inflight: Promise<void> | null = null;
let refetchAfterInflight = false;

function setState(next: Partial<ArchiveState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function subscribeOperationArchive(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getOperationArchiveState(): ArchiveState {
  return state;
}

export function useOperationArchive(): ArchiveState {
  return useSyncExternalStore(subscribeOperationArchive, getOperationArchiveState, getOperationArchiveState);
}

/** 보관 목록을 다시 읽는다. 겹친 요청은 하나로 모으고, 그 사이 바뀐 것이 있으면 한 번 더 읽는다. */
export function refreshOperationArchive(): Promise<void> {
  if (inflight) {
    refetchAfterInflight = true;
    return inflight;
  }
  setState({ loading: true });
  inflight = fetchOperationArchive()
    .then((snapshot) => { setState({ snapshot, total: snapshot.total, revision: snapshot.revision, loading: false, error: false }); })
    .catch(() => { setState({ loading: false, error: true }); })
    .finally(() => {
      inflight = null;
      if (refetchAfterInflight) {
        refetchAfterInflight = false;
        void refreshOperationArchive();
      }
    });
  return inflight;
}

export function openArchiveSheet(): void {
  if (!state.sheetOpen) setState({ sheetOpen: true });
  void refreshOperationArchive();
}

export function closeArchiveSheet(): void {
  if (state.sheetOpen) setState({ sheetOpen: false });
}

function readArchiveChanged(payload: unknown): { readonly revision: number; readonly total: number } | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  return typeof record.revision === "number" && typeof record.total === "number" ? { revision: record.revision, total: record.total } : null;
}

/**
 * 앱이 한 번 부른다. 수는 사건으로 바로 따라가고, 목록은 시트가 열려 있거나 이미 읽어 둔 적이 있을 때만 다시 읽는다 —
 * 닫힌 시트를 위해 보관분 전체를 매번 당겨 오지 않는다. 연결 직후의 수는 한 번 읽어 채운다.
 */
export function installOperationArchive(subscribeConsoleChannel: (channel: string, listener: (payload: unknown) => void) => () => void): () => void {
  const onChanged = (payload: unknown) => {
    const changed = readArchiveChanged(payload);
    if (!changed) return;
    if (changed.revision === state.revision && changed.total === state.total) return;
    setState({ total: changed.total, revision: changed.revision });
    if (state.sheetOpen || state.snapshot !== null) void refreshOperationArchive();
  };
  const offChanged = subscribeConsoleChannel(OPERATION_ARCHIVE_CHANGED_EVENT, onChanged);
  // 다른 창의 복원·보관도 보관 목록을 바꾼다 — 수 사건이 늦거나 빠져도 열린 시트는 다시 읽는다.
  const offCluster = subscribeConsoleChannel(OPERATION_CLUSTER_CHANGED_EVENT, () => {
    if (state.sheetOpen) void refreshOperationArchive();
  });
  void refreshOperationArchive();
  return () => { offChanged(); offCluster(); };
}
