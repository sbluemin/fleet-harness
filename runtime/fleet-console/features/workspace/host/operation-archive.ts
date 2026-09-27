import crypto from "node:crypto";
import type { OperationAccessIntent, OperationAccessResult, OperationArchiveCapability, OperationArchiveReceipt, OperationDescription, OperationPurgeConfirmation } from "@fleet-console/sdk/operations";
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
}

/** 보관 단위는 최상위 Operation이다. 자식은 부모의 childSessions 안에서만 이동한다. */
export function createOperationArchiveCoordinator(deps: OperationArchiveDeps) {
  const now = deps.now ?? Date.now;
  let serial: Promise<unknown> = Promise.resolve();
  const locked = new Set<string>();
  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const task = serial.then(run, run);
    serial = task.catch(() => undefined);
    return task;
  }
  function all(): readonly OperationNode[] { return [...deps.operations.list(), ...deps.storage.entries().map((entry) => entry.operation)]; }
  function find(id: string): OperationNode | undefined {
    return all().find((operation) => operation.id === id || operation.childSessions?.some((child) => child.id === id));
  }
  function requireNode(id: string): OperationNode {
    deps.storage.assertReady();
    if (deps.pendingDeletion(id)) throw new OperationArchiveError(409, "pending_deletion");
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
      .map((entry) => describe(entry.operation.id)!);
    return { revision: deps.storage.revision(), total: entries.length, entries };
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
    return { archiveId: entry.archiveId, targetId: id, rootOperationId: id, operationIds: [id], archivedAt: entry.archivedAt, revision: deps.storage.revision() };
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
  async function accessNow(id: string, intent: OperationAccessIntent): Promise<OperationAccessResult> {
    const root = requireNode(id);
    if (!deps.theaterExists(root.theaterId)) throw new OperationArchiveError(409, "restore_parent_missing");
    const archived = deps.storage.entries().some((entry) => entry.operation.id === root.id);
    if (archived) {
      const groups = new Set(deps.operations.listGroups(root.theaterId).map((group) => group.id));
      const restored: OperationNode = {
        ...root,
        ...(root.groupId && !groups.has(root.groupId) ? { groupId: null } : {}),
        payload: { ...root.payload, restoredDormant: true },
        ...(root.childSessions ? { childSessions: root.childSessions.map((child) => ({ ...child, payload: { ...child.payload, restoredDormant: true } })) } : {}),
      };
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
  function previewPurge(id: string): OperationPurgeConfirmation {
    requireRoot(id);
    if (!deps.storage.entries().some((entry) => entry.operation.id === id)) throw new OperationArchiveError(409, "operation_not_archived");
    return { targetId: id, operationIds: [id], revision: deps.storage.revision() };
  }
  const purge = (confirmation: OperationPurgeConfirmation) => enqueue(async () => {
    const current = previewPurge(confirmation.targetId);
    if (confirmation.revision !== current.revision || JSON.stringify([...confirmation.operationIds].sort()) !== JSON.stringify(current.operationIds)) throw new OperationArchiveError(409, "archive_revision_conflict");
    const entry = deps.storage.entries().find((entry) => entry.operation.id === current.targetId)!;
    commit(deps.operations.list(), deps.storage.entries().filter((candidate) => candidate !== entry), [archiveEvent("operation:purged", entry.operation)]);
    return { operationIds: current.operationIds, revision: deps.storage.revision() };
  });
  const capability: OperationArchiveCapability = { describe, listArchived, archive, access, restore, undoArchive, previewPurge, purge };
  return {
    ...capability, flushEvents,
    isTransitioning: (id: string) => locked.has(id),
    assertMutable: (id: string) => { deps.storage.assertReady(); if (locked.has(id)) throw new OperationArchiveError(409, "operation_busy"); },
  };
}
export type OperationArchiveCoordinator = ReturnType<typeof createOperationArchiveCoordinator>;
