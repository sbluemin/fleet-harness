import crypto from "node:crypto";
import { OPERATION_PURGE_GRACE_MS, type OperationAccessIntent, type OperationAccessResult, type OperationArchiveCapability, type OperationArchiveReceipt, type OperationDescription, type OperationPendingPurge, type OperationPurgeConfirmation } from "@fleet-console/sdk/operations";
import type { OperationNode, OperationStore } from "../../execution/host/operations/operations-domain.js";
import type { DurableConsoleState } from "./durable-state.js";
import { archiveEvent, archiveSessionNodes, OperationArchiveError, type ArchivedOperation, type ArchiveLifecycleEvent, type OperationArchiveStorage } from "./operation-archive-storage.js";

interface OperationArchiveDeps {
  readonly operations: OperationStore;
  readonly storage: OperationArchiveStorage;
  readonly snapshot: () => DurableConsoleState;
  readonly theaterExists: (id: string) => boolean;
  readonly pendingDeletion: (id: string) => boolean;
  readonly stop: (operation: OperationNode) => Promise<void>;
  readonly use: (id: string, intent: OperationAccessIntent) => Promise<void>;
  readonly publish: (event: ArchiveLifecycleEvent) => void;
  readonly publishChanged: () => void;
  readonly now?: () => number;
  readonly setTimer?: typeof setTimeout;
  readonly clearTimer?: typeof clearTimeout;
}

/** 보관 단위는 최상위 Operation이다. 자식은 부모의 childSessions 안에서만 이동한다. */
export function createOperationArchiveCoordinator(deps: OperationArchiveDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  let serial: Promise<unknown> = Promise.resolve();
  const locked = new Set<string>();
  // 유예를 durable tombstone으로 옮기지 않는다. 종료·크래시 중 시간이 지나도 원본과 데이터는 온전히 남는다.
  const pending = new Map<string, { readonly receipt: OperationPendingPurge; readonly entries: readonly ArchivedOperation[] }>();
  let volatileRevision = 0;
  // 브라우저 revision은 불투명한 비교 토큰이다. 메모리 보류가 사라진 재기동에서 옛 preview를 재사용하지 못하게 한다.
  const epoch = crypto.randomInt(1, 2 ** 48);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const revision = () => epoch + deps.storage.revision() + volatileRevision;
  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const task = serial.then(run, run);
    serial = task.catch(() => undefined);
    return task;
  }
  function all(): readonly OperationNode[] { return [...deps.operations.list(), ...deps.storage.entries().map((entry) => entry.operation)]; }
  function find(id: string): OperationNode | undefined {
    return all().find((operation) => operation.id === id || operation.childSessions?.some((child) => child.id === id));
  }
  function pendingFor(id: string): boolean {
    return [...pending.values()].some((batch) => batch.entries.some((entry) => entry.operation.id === id || entry.operation.childSessions?.some((child) => child.id === id)));
  }
  function requireNode(id: string): OperationNode {
    deps.storage.assertReady();
    if (disposed) throw new OperationArchiveError(503, "archive_recovery_required");
    if (deps.pendingDeletion(id) || pendingFor(id)) throw new OperationArchiveError(409, "pending_deletion");
    const operation = find(id);
    if (!operation) throw new OperationArchiveError(404, "unknown_operation");
    return operation;
  }
  function requireRoot(id: string): OperationNode {
    const operation = requireNode(id);
    if (operation.id !== id) throw new OperationArchiveError(409, "child_session_not_closable");
    return operation;
  }
  function describe(id: string): OperationDescription | null {
    const operation = find(id);
    if (!operation) return null;
    const entry = deps.storage.entries().find((entry) => entry.operation.id === operation.id);
    return { operation, location: entry ? "archived" : "active", rootOperationId: operation.id, archivedAt: entry?.archivedAt ?? null };
  }
  function listArchived(theaterId?: string) {
    const entries = deps.storage.entries().filter((entry) => !theaterId || entry.operation.theaterId === theaterId)
      .sort((a, b) => b.archivedAt - a.archivedAt || a.operation.id.localeCompare(b.operation.id))
      .map((entry): OperationDescription => ({ operation: entry.operation, location: "archived", rootOperationId: entry.operation.id, archivedAt: entry.archivedAt }));
    const ids = new Set(entries.map((entry) => entry.operation.id));
    return { revision: revision(), total: entries.length, entries, pendingPurges: [...pending.values()].filter((batch) => batch.receipt.operationIds.some((id) => ids.has(id))).map((batch) => batch.receipt) };
  }
  function flushEvents(): void {
    for (const event of deps.storage.events()) {
      deps.publish(event);
      deps.storage.acknowledgeEvents([event.eventId]);
    }
  }
  function commit(operations: readonly OperationNode[], entries: readonly ArchivedOperation[], events: readonly ArchiveLifecycleEvent[]): void {
    // 디스크 확정 전 active Map을 바꾸지 않는다. 실패한 prepare는 다음 기동이 복구한다.
    deps.storage.save({ ...deps.snapshot(), operations }, entries, events);
    deps.operations.replace(operations);
    flushEvents();
    deps.publishChanged();
  }
  async function withStopped<T>(root: OperationNode, run: () => T): Promise<T> {
    const nodes = archiveSessionNodes(root);
    for (const node of nodes) locked.add(node.id);
    try {
      for (const node of nodes) if (deps.operations.get(node.id)) await deps.stop(node);
      deps.storage.assertReady();
      return run();
    } finally { for (const node of nodes) locked.delete(node.id); }
  }
  function receipt(entry: ArchivedOperation): OperationArchiveReceipt {
    const id = entry.operation.id;
    return { archiveId: entry.archiveId, targetId: id, rootOperationId: id, operationIds: [id], archivedAt: entry.archivedAt, revision: revision() };
  }
  const archive = (id: string): Promise<OperationArchiveReceipt> => enqueue(async () => {
    const root = requireRoot(id);
    const existing = deps.storage.entries().find((entry) => entry.operation.id === id);
    if (existing) return receipt(existing);
    return withStopped(root, () => {
      const operation = deps.operations.get(id)!;
      const moved = { operation, archiveId: crypto.randomUUID(), archivedAt: now() };
      commit(deps.operations.list().filter((node) => node.id !== id), [...deps.storage.entries(), moved], [archiveEvent("operation:archived", operation)]);
      return receipt(moved);
    });
  });
  function dormant(root: OperationNode): OperationNode {
    if (!deps.theaterExists(root.theaterId)) throw new OperationArchiveError(409, "restore_parent_missing");
    const groups = new Set(deps.operations.listGroups(root.theaterId).map((group) => group.id));
    return {
      ...root,
      ...(root.groupId && !groups.has(root.groupId) ? { groupId: null } : {}),
      payload: { ...root.payload, restoredDormant: true },
      ...(root.childSessions ? { childSessions: root.childSessions.map((child) => ({ ...child, payload: { ...child.payload, restoredDormant: true } })) } : {}),
    };
  }
  async function accessNow(id: string, intent: OperationAccessIntent): Promise<OperationAccessResult> {
    const root = requireNode(id);
    if (!deps.theaterExists(root.theaterId)) throw new OperationArchiveError(409, "restore_parent_missing");
    const archived = deps.storage.entries().some((entry) => entry.operation.id === root.id);
    if (archived) {
      const restored = dormant(root);
      commit([...deps.operations.list(), restored], deps.storage.entries().filter((entry) => entry.operation.id !== root.id), [archiveEvent("operation:restored", restored)]);
    }
    // 명시적 자식 사용도 부모를 통째로 복원한 뒤 원래 세션 ID로 보낸다.
    await deps.use(id, intent);
    return { targetId: id, rootOperationId: root.id, restoredIds: archived ? [root.id] : [], operations: [deps.operations.get(root.id)!] };
  }
  const access = (id: string, intent: OperationAccessIntent = "ensure-active") => enqueue(() => accessNow(id, intent));
  const restore = (id: string) => access(id);
  const undoArchive = (input: Pick<OperationArchiveReceipt, "targetId" | "archiveId">) => enqueue(async () => {
    const entry = deps.storage.entries().find((entry) => entry.operation.id === input.targetId);
    if (!entry || entry.archiveId !== input.archiveId) throw new OperationArchiveError(409, "archive_undo_conflict");
    return accessNow(input.targetId, "ensure-active");
  });
  function previewBatch(ids: readonly string[]): OperationPurgeConfirmation {
    if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== "string" || !id || id.length > 128)) throw new OperationArchiveError(400, "invalid_archive_request");
    deps.storage.assertReady();
    if (disposed) throw new OperationArchiveError(503, "archive_recovery_required");
    const archived = new Set(deps.storage.entries().map((entry) => entry.operation.id));
    for (const id of ids) {
      if (deps.pendingDeletion(id) || pendingFor(id)) throw new OperationArchiveError(409, "pending_deletion");
      if (!archived.has(id)) {
        requireRoot(id); // 미지의 ID·자식 세션 거절은 기존 단건 경계와 같다.
        throw new OperationArchiveError(409, "operation_not_archived");
      }
    }
    return { targetId: ids[0]!, operationIds: [...ids].sort(), revision: revision() };
  }
  const previewPurge = (id: string) => previewBatch([id]);
  function confirmedEntries(confirmation: OperationPurgeConfirmation): readonly ArchivedOperation[] {
    // revision 확인과 대상 집합 검증은 단건·일괄 모두 같은 경계에서 끝낸다.
    if (confirmation.revision !== revision() || !confirmation.operationIds.includes(confirmation.targetId)) throw new OperationArchiveError(409, "archive_revision_conflict");
    const current = previewBatch(confirmation.operationIds);
    if (JSON.stringify([...confirmation.operationIds].sort()) !== JSON.stringify(current.operationIds)) throw new OperationArchiveError(409, "archive_revision_conflict");
    const entries = new Map(deps.storage.entries().map((entry) => [entry.operation.id, entry]));
    return current.operationIds.map((id) => entries.get(id)!);
  }
  const restoreBatch = (confirmation: OperationPurgeConfirmation) => enqueue(async () => {
    const entries = confirmedEntries(confirmation);
    // 모든 부모와 그룹을 먼저 검증한 뒤 한 번만 확정한다. 부분 복원은 없다.
    const restored = entries.map((entry) => dormant(entry.operation));
    const ids = new Set(confirmation.operationIds);
    commit([...deps.operations.list(), ...restored], deps.storage.entries().filter((entry) => !ids.has(entry.operation.id)), restored.map((node) => archiveEvent("operation:restored", node)));
    return { operations: restored, revision: revision() };
  });
  function schedule(): void {
    if (timer) clearTimer(timer);
    timer = null;
    if (disposed || !pending.size) return;
    const at = Math.min(...[...pending.values()].map((batch) => batch.receipt.purgeAt));
    timer = setTimer(() => { timer = null; void sweepExpired().catch(() => { /* 실패한 저장은 원본을 보존하고 다음 기동 복구 경계가 맡는다. */ }); }, Math.max(0, at - now()));
    timer.unref?.();
  }
  const sweepExpired = () => enqueue(async () => {
    if (disposed) return;
    for (const [purgeId, batch] of pending) {
      if (batch.receipt.purgeAt > now()) continue;
      // 다른 파괴적 경로가 하나라도 옮겼으면 전체 보류를 취소한다. 새로 보관된 같은 ID를 지우지 않는다.
      const intact = batch.entries.every((original) => deps.storage.entries().some((entry) => entry.archiveId === original.archiveId && entry.operation.id === original.operation.id));
      pending.delete(purgeId);
      volatileRevision += 1;
      if (intact) {
        const ids = new Set(batch.receipt.operationIds);
        commit(deps.operations.list(), deps.storage.entries().filter((entry) => !ids.has(entry.operation.id)), batch.entries.map((entry) => archiveEvent("operation:purged", entry.operation)));
      } else deps.publishChanged();
    }
    schedule();
  });
  const purge = (confirmation: OperationPurgeConfirmation) => enqueue(async () => {
    const entries = confirmedEntries(confirmation);
    const receipt: OperationPendingPurge = Object.freeze({ purgeId: crypto.randomUUID(), operationIds: Object.freeze(entries.map((entry) => entry.operation.id)), purgeAt: now() + OPERATION_PURGE_GRACE_MS });
    pending.set(receipt.purgeId, { receipt, entries });
    volatileRevision += 1;
    schedule();
    deps.publishChanged();
    return { ...receipt, revision: revision() };
  });
  const undoPurge = (purgeId: string) => enqueue(async () => {
    const batch = pending.get(purgeId);
    if (!batch || now() >= batch.receipt.purgeAt) throw new OperationArchiveError(409, "archive_undo_conflict");
    pending.delete(purgeId);
    volatileRevision += 1;
    schedule();
    deps.publishChanged();
    return { operationIds: batch.receipt.operationIds, revision: revision() };
  });
  const capability: OperationArchiveCapability = { describe, listArchived, archive, access, restore, undoArchive, previewPurge, purge };
  return {
    ...capability, purge, previewBatch, restoreBatch, undoPurge, sweepExpired, revision, flushEvents,
    dispose: () => { disposed = true; if (timer) clearTimer(timer); timer = null; pending.clear(); },
    isTransitioning: (id: string) => locked.has(id) || pendingFor(id),
    assertMutable: (id: string) => { deps.storage.assertReady(); if (locked.has(id) || pendingFor(id)) throw new OperationArchiveError(409, "operation_busy"); },
  };
}
export type OperationArchiveCoordinator = ReturnType<typeof createOperationArchiveCoordinator>;
