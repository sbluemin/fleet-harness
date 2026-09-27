import crypto from "node:crypto";
import type { OperationAccessIntent, OperationAccessResult, OperationArchiveCapability, OperationArchiveReceipt, OperationDescription, OperationPurgeConfirmation } from "@fleet-console/sdk/operations";
import type { OperationNode, OperationStore } from "../../execution/host/operations/operations-domain.js";
import type { DurableConsoleState } from "./durable-state.js";
import { archiveEvent, OperationArchiveError, type ArchivedOperation, type ArchiveLifecycleEvent, type OperationArchiveStorage } from "./operation-archive-storage.js";

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

/** 관계와 이동은 Core 한 곳에서 소유한다. 호출자의 용도는 해석하지 않는다. */
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
  function find(id: string): OperationNode | undefined { return all().find((operation) => operation.id === id); }
  function requireNode(id: string): OperationNode {
    deps.storage.assertReady();
    if (deps.pendingDeletion(id)) throw new OperationArchiveError(409, "pending_deletion");
    const operation = find(id);
    if (!operation) throw new OperationArchiveError(404, "unknown_operation");
    return operation;
  }
  function rootOf(operation: OperationNode): OperationNode {
    const seen = new Set<string>();
    let node = operation;
    while (node.parentOperationId) {
      if (seen.has(node.id)) throw new OperationArchiveError(409, "archive_cluster_conflict");
      seen.add(node.id);
      const parent = find(node.parentOperationId);
      if (!parent || parent.theaterId !== operation.theaterId) throw new OperationArchiveError(409, "restore_parent_missing");
      node = parent;
    }
    return node;
  }
  function descendants(operation: OperationNode): readonly OperationNode[] {
    const found = new Set([operation.id]);
    const nodes = all();
    let previous = -1;
    while (previous !== found.size) {
      previous = found.size;
      for (const node of nodes) if (node.parentOperationId && found.has(node.parentOperationId)) {
        if (node.theaterId !== operation.theaterId) throw new OperationArchiveError(409, "archive_cluster_conflict");
        found.add(node.id);
      }
    }
    return nodes.filter((node) => found.has(node.id));
  }
  function describe(id: string): OperationDescription | null {
    const operation = find(id);
    if (!operation) return null;
    const entry = deps.storage.entries().find((entry) => entry.operation.id === id);
    return { operation, location: entry ? "archived" : "active", rootOperationId: rootOf(operation).id, archivedAt: entry?.archivedAt ?? null };
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
  async function withStopped<T>(nodes: readonly OperationNode[], run: () => T): Promise<T> {
    const ids = nodes.map((node) => node.id);
    for (const id of ids) locked.add(id);
    try {
      for (const node of nodes) if (deps.operations.get(node.id)) await deps.stop(node);
      deps.storage.assertReady();
      return run();
    } finally { for (const id of ids) locked.delete(id); }
  }
  function receipt(id: string, rootId: string, entries: readonly ArchivedOperation[]): OperationArchiveReceipt {
    const target = entries.find((entry) => entry.operation.id === id)!;
    return { archiveId: target.archiveId, targetId: id, rootOperationId: rootId, operationIds: entries.map((entry) => entry.operation.id), archivedAt: target.archivedAt, revision: deps.storage.revision() };
  }
  async function archive(id: string): Promise<OperationArchiveReceipt> {
    return enqueue(async () => {
      const node = requireNode(id);
      const rootId = rootOf(node).id;
      const nodes = descendants(node);
      const ids = new Set(nodes.map((node) => node.id));
      if (nodes.every((node) => !deps.operations.get(node.id))) return receipt(id, rootId, deps.storage.entries().filter((entry) => ids.has(entry.operation.id)));
      return withStopped(nodes, () => {
        const archiveId = crypto.randomUUID();
        const archivedAt = now();
        const fresh = nodes.map((node) => deps.operations.get(node.id) ?? requireNode(node.id));
        const moved = fresh.map((operation) => ({ operation, archiveId, archivedAt }));
        commit(deps.operations.list().filter((node) => !ids.has(node.id)), [...deps.storage.entries().filter((entry) => !ids.has(entry.operation.id)), ...moved], fresh.map((node) => archiveEvent("operation:archived", node)));
        return receipt(id, rootId, moved);
      });
    });
  }
  async function accessNow(id: string, intent: OperationAccessIntent): Promise<OperationAccessResult> {
    const target = requireNode(id);
    const root = rootOf(target);
    if (!deps.theaterExists(root.theaterId)) throw new OperationArchiveError(409, "restore_parent_missing");
    const nodes = descendants(root);
    const ids = new Set(nodes.map((node) => node.id));
    const restoredIds = deps.storage.entries().filter((entry) => ids.has(entry.operation.id)).map((entry) => entry.operation.id);
    if (restoredIds.length) {
      await withStopped(nodes, () => {
        const groups = new Set(deps.operations.listGroups(root.theaterId).map((group) => group.id));
        const restored = nodes.map((node) => {
          const fresh = deps.operations.get(node.id) ?? requireNode(node.id);
          return { ...fresh, ...(fresh.groupId && !groups.has(fresh.groupId) ? { groupId: null } : {}), payload: { ...fresh.payload, restoredDormant: true } };
        });
        commit([...deps.operations.list().filter((node) => !ids.has(node.id)), ...restored], deps.storage.entries().filter((entry) => !ids.has(entry.operation.id)), restored.map((node) => archiveEvent("operation:restored", node)));
      });
    }
    await deps.use(id, intent);
    return { targetId: id, rootOperationId: root.id, restoredIds, operations: nodes.map((node) => deps.operations.get(node.id)!).filter(Boolean) };
  }
  const access = (id: string, intent: OperationAccessIntent = "ensure-active") => enqueue(() => accessNow(id, intent));
  const restore = (id: string) => access(id);
  const undoArchive = (input: Pick<OperationArchiveReceipt, "targetId" | "archiveId">) => enqueue(async () => {
    const entry = deps.storage.entries().find((entry) => entry.operation.id === input.targetId);
    if (!entry || entry.archiveId !== input.archiveId) throw new OperationArchiveError(409, "archive_undo_conflict");
    return accessNow(input.targetId, "ensure-active");
  });
  function previewPurge(id: string): OperationPurgeConfirmation {
    const target = requireNode(id);
    const nodes = descendants(target);
    if (nodes.some((node) => deps.operations.get(node.id))) throw new OperationArchiveError(409, "operation_not_archived");
    return { targetId: id, operationIds: nodes.map((node) => node.id).sort(), revision: deps.storage.revision() };
  }
  const purge = (confirmation: OperationPurgeConfirmation) => enqueue(async () => {
    const current = previewPurge(confirmation.targetId);
    if (confirmation.revision !== current.revision || JSON.stringify([...confirmation.operationIds].sort()) !== JSON.stringify(current.operationIds)) throw new OperationArchiveError(409, "archive_revision_conflict");
    const ids = new Set(current.operationIds);
    const removed = deps.storage.entries().filter((entry) => ids.has(entry.operation.id));
    commit(deps.operations.list(), deps.storage.entries().filter((entry) => !ids.has(entry.operation.id)), removed.map((entry) => archiveEvent("operation:purged", entry.operation)));
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
