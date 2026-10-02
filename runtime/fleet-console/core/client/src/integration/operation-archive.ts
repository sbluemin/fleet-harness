// 보관함의 클라이언트 상태 — 사이드바의 「보관함 N」, 보관함 시트의 목록, 시트가 열려 있는지.
//
// 보관된 Operation은 일반 Operation 목록에 없다(Core가 별도 저장소에 둔다). 그래서 이 모듈은 일반 스토어에
// 보관 노드를 섞지 않고 자기 스냅숏만 든다. 수와 revision은 SSE(operation:archive-changed)가 알려 주고,
// 목록 본문은 시트가 열려 있을 때만 다시 읽는다.

import { useSyncExternalStore } from "react";
import { ensureDefaultGeometry, loadForTheater, restoreOperation as restoreCanvasOperation } from "../../../../features/workspace/client/canvas/canvas-store.js";
import { getState, setActiveOperation, setActiveTheater } from "./store.js";

import {
  OPERATION_ARCHIVE_CHANGED_EVENT,
  OPERATION_CLUSTER_CHANGED_EVENT,
  fetchOperationArchive,
  type OperationArchiveSnapshot,
} from "@fleet-console/sdk/operations/browser";

interface ArchiveState {
  readonly total: number;
  readonly totalsByTheater: Readonly<Record<string, number>>;
  readonly revision: number;
  /** 마지막으로 읽은 목록. 시트를 한 번도 열지 않았으면 null. */
  readonly snapshot: OperationArchiveSnapshot | null;
  readonly loading: boolean;
  readonly error: boolean;
  readonly sheetOpen: boolean;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let state: ArchiveState = { total: 0, totalsByTheater: {}, revision: -1, snapshot: null, loading: false, error: false, sheetOpen: false };
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
  inflight = (async () => {
    do {
      refetchAfterInflight = false;
      try {
        const snapshot = await fetchOperationArchive();
        const totalsByTheater: Record<string, number> = {};
        for (const entry of snapshot.entries) totalsByTheater[entry.operation.theaterId] = (totalsByTheater[entry.operation.theaterId] ?? 0) + 1;
        setState({ snapshot, total: snapshot.total, totalsByTheater, revision: snapshot.revision, loading: false, error: false });
      } catch { setState({ loading: false, error: true }); }
    } while (refetchAfterInflight);
  })().finally(() => {
    inflight = null;
    // 마지막 응답과 finally 사이에 온 갱신도 기다린다. 삭제·복원 뒤 초점은 최신 목록에만 넘긴다.
    if (refetchAfterInflight) { refetchAfterInflight = false; return refreshOperationArchive(); }
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

/** 명시적 열기는 패널만 꺼낸다. 일반 focusOperation의 자동 Resume 제스처를 만들지 않는다. */
export function openRestoredOperation(id: string): boolean {
  const node = getState().operations.find((operation) => operation.id === id);
  if (!node) return false;
  if (getState().activeTheaterId !== node.theaterId) setActiveTheater(node.theaterId);
  loadForTheater(node.theaterId);
  ensureDefaultGeometry(node.id, node.geometry);
  restoreCanvasOperation(node.id);
  setActiveOperation(node.id);
  return true;
}

function readArchiveChanged(payload: unknown): { readonly revision: number; readonly total: number; readonly totalsByTheater?: Readonly<Record<string, number>> } | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.revision !== "number" || typeof record.total !== "number") return null;
  const totals = record.totalsByTheater;
  const validTotals = totals && typeof totals === "object" && !Array.isArray(totals) && Object.values(totals).every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  return { revision: record.revision, total: record.total, ...(validTotals ? { totalsByTheater: totals as Record<string, number> } : {}) };
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
    setState({ total: changed.total, revision: changed.revision, ...(changed.totalsByTheater ? { totalsByTheater: changed.totalsByTheater } : {}) });
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
