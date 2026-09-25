import crypto from "node:crypto";

import type { DurableDeletionTombstone, DurableOperationGroup } from "./durable-state.js";
import type { OperationNode, OperationStore } from "../../execution/host/operations/operations-domain.js";
import { DELETION_GRACE_MS } from "../../execution/host/operations/operations-domain.js";
import type { TheaterRegistration } from "./theaters/theater-domain.js";
import type { TheaterRegistry } from "./theaters/theater-domain.js";

export interface DeferredDeletionReceipt {
  readonly deletionId: string;
  readonly kind: "operation" | "theater";
  readonly targetId: string;
  readonly expiresAt: number;
}

export interface DeferredDeletionResponse {
  readonly ok: true;
  readonly deletion: DeferredDeletionReceipt | null;
}

export interface DeferredRestoreResponse {
  readonly ok: true;
  readonly kind: "operation" | "theater";
  readonly targetId: string;
}

export class DeferredDeletionError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DeferredDeletionError";
    this.status = status;
  }
}

export interface DeferredDeletionCoordinator {
  readonly list: () => readonly DurableDeletionTombstone[];
  readonly load: (tombstones: readonly DurableDeletionTombstone[]) => void;
  readonly deleteOperation: (operationId: string) => DeferredDeletionReceipt | null;
  readonly deleteTheater: (theaterId: string) => DeferredDeletionReceipt | null;
  readonly restore: (deletionId: string) => Promise<DeferredRestoreResponse>;
  readonly sweepExpired: () => void;
  readonly hasPendingOperation: (operationId: string) => boolean;
  readonly hasPendingTheater: (theaterId: string) => boolean;
  readonly dispose: () => void;
}

interface DeferredDeletionCoordinatorDeps {
  readonly operations: OperationStore;
  readonly theaters: TheaterRegistry;
  readonly save: (tombstones: readonly DurableDeletionTombstone[]) => void;
  readonly publish: (channel: string, payload: unknown) => void;
  readonly unregisterTheaterWorkspaces: (theaterId: string) => void;
  readonly validateTheaterRestore: (theater: TheaterRegistration) => Promise<void>;
  readonly registerTheaterWorkspace: (theater: TheaterRegistration) => Promise<void>;
  /**
   * 유예가 끝난 Operation 의 흔적을 지우기 **전에** 부른다 — 멱등 기동 키 원장이 purge 를 선기록한다. 던지면 이번 정리를
   * 미루고 다시 시도한다(tombstone 은 그대로 남아 키가 계속 「삭제 중」으로 읽힌다).
   */
  readonly beforePurge?: (operations: readonly OperationNode[]) => void;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

const OPERATION_DELETED_EVENT_CHANNEL = "operation:deleted";
const OPERATION_RESTORED_EVENT_CHANNEL = "operation:restored";
const OPERATION_PURGED_EVENT_CHANNEL = "operation:purged";
const PURGE_RETRY_MS = 1_000;

export function createDeferredDeletionCoordinator(deps: DeferredDeletionCoordinatorDeps): DeferredDeletionCoordinator {
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? crypto.randomUUID;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  let tombstones: readonly DurableDeletionTombstone[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  // purge 선기록(beforePurge)에 실패한 tombstone 의 다음 시도 시각 — 그 tombstone 만 남겨 미루고, 다른 정리와 생성·삭제는 막지 않는다.
  const purgeRetryAt = new Map<string, number>();

  function list(): readonly DurableDeletionTombstone[] {
    return tombstones;
  }

  function load(nextTombstones: readonly DurableDeletionTombstone[]): void {
    tombstones = [...nextTombstones];
    schedule();
  }

  function deleteOperation(operationId: string): DeferredDeletionReceipt | null {
    sweepExpired();
    const existing = tombstones.find((item) => item.kind === "operation" && item.targetId === operationId);
    if (existing) return toReceipt(existing);
    const operation = deps.operations.get(operationId);
    if (!operation) return null;
    const previousOperations = deps.operations.list();
    const deletedAt = now();
    const tombstone: DurableDeletionTombstone = {
      deletionId: randomId(),
      targetId: operation.id,
      deletedAt,
      expiresAt: deletedAt + DELETION_GRACE_MS,
      kind: "operation",
      operation,
    };
    const nextTombstones = [...tombstones, tombstone];
    deps.operations.delete(operationId);
    try {
      deps.save(nextTombstones);
    } catch (error) {
      deps.operations.replace(previousOperations);
      throw error;
    }
    tombstones = nextTombstones;
    publishOperation(OPERATION_DELETED_EVENT_CHANNEL, operation);
    schedule();
    return toReceipt(tombstone);
  }

  function deleteTheater(theaterId: string): DeferredDeletionReceipt | null {
    sweepExpired();
    const existing = tombstones.find((item) => item.kind === "theater" && item.targetId === theaterId);
    if (existing) return toReceipt(existing);
    const theater = deps.theaters.get(theaterId);
    if (!theater) return null;
    const previousTheaters = deps.theaters.list();
    const previousOperations = deps.operations.list();
    const previousGroups = deps.operations.listAllGroups();
    const deletedOperations = deps.operations.listByTheater(theaterId);
    const deletedGroups = deps.operations.listGroups(theaterId);
    const deletedAt = now();
    const tombstone: DurableDeletionTombstone = {
      deletionId: randomId(),
      targetId: theater.id,
      deletedAt,
      expiresAt: deletedAt + DELETION_GRACE_MS,
      kind: "theater",
      theater,
      operations: deletedOperations,
      groups: deletedGroups,
    };
    const nextTombstones = [...tombstones, tombstone];
    deps.theaters.remove(theaterId);
    deps.operations.deleteByTheater(theaterId);
    try {
      deps.save(nextTombstones);
    } catch (error) {
      deps.theaters.restore(previousTheaters);
      deps.operations.replace(previousOperations);
      deps.operations.replaceGroups(previousGroups);
      throw error;
    }
    tombstones = nextTombstones;
    deps.unregisterTheaterWorkspaces(theaterId);
    for (const operation of deletedOperations) publishOperation(OPERATION_DELETED_EVENT_CHANNEL, operation);
    schedule();
    return toReceipt(tombstone);
  }

  async function restore(deletionId: string): Promise<DeferredRestoreResponse> {
    const restoredAt = now();
    const tombstone = tombstones.find((item) => item.deletionId === deletionId);
    if (!tombstone || tombstone.expiresAt <= restoredAt) {
      if (tombstone) sweepExpired();
      throw new DeferredDeletionError(404, "deletion_not_found");
    }
    if (tombstone.kind === "operation") {
      if (deps.operations.get(tombstone.targetId) || !deps.theaters.get(tombstone.operation.theaterId)) {
        throw new DeferredDeletionError(409, "restore_conflict");
      }
      const previousOperations = deps.operations.list();
      const nextTombstones = tombstones.filter((item) => item.deletionId !== deletionId);
      deps.operations.replace([...previousOperations, tombstone.operation]);
      try {
        deps.save(nextTombstones);
      } catch (error) {
        deps.operations.replace(previousOperations);
        throw error;
      }
      tombstones = nextTombstones;
      publishOperation(OPERATION_RESTORED_EVENT_CHANNEL, tombstone.operation);
      schedule();
      return { ok: true, kind: tombstone.kind, targetId: tombstone.targetId };
    }

    await deps.validateTheaterRestore(tombstone.theater);
    if (deps.theaters.get(tombstone.targetId)
      || tombstone.operations.some((operation) => deps.operations.get(operation.id))
      || hasGroupConflict(tombstone.groups, deps.operations.listAllGroups())) {
      throw new DeferredDeletionError(409, "restore_conflict");
    }
    const previousTheaters = deps.theaters.list();
    const previousOperations = deps.operations.list();
    const previousGroups = deps.operations.listAllGroups();
    const nextTombstones = tombstones.filter((item) => item.deletionId !== deletionId);
    deps.theaters.restore([...previousTheaters, tombstone.theater]);
    deps.operations.replace([...previousOperations, ...tombstone.operations]);
    deps.operations.replaceGroups([...previousGroups, ...tombstone.groups]);
    try {
      deps.save(nextTombstones);
    } catch (error) {
      deps.theaters.restore(previousTheaters);
      deps.operations.replace(previousOperations);
      deps.operations.replaceGroups(previousGroups);
      throw error;
    }
    tombstones = nextTombstones;
    await deps.registerTheaterWorkspace(tombstone.theater);
    for (const operation of tombstone.operations) publishOperation(OPERATION_RESTORED_EVENT_CHANNEL, operation);
    schedule();
    return { ok: true, kind: tombstone.kind, targetId: tombstone.targetId };
  }

  function sweepExpired(): void {
    const cutoff = now();
    const due = tombstones.filter((item) => item.expiresAt <= cutoff && (purgeRetryAt.get(item.deletionId) ?? 0) <= cutoff);
    // 선기록은 tombstone 마다 따로 — 실패한 것은 남아(키가 계속 「삭제 중」으로 읽힌다) 나중에 다시 시도하고, 나머지는 정리한다.
    const expired = due.filter((item) => {
      if (!deps.beforePurge) return true;
      try {
        deps.beforePurge(item.kind === "operation" ? [item.operation] : item.operations);
        purgeRetryAt.delete(item.deletionId);
        return true;
      } catch {
        purgeRetryAt.set(item.deletionId, cutoff + PURGE_RETRY_MS);
        return false;
      }
    });
    for (const deletionId of purgeRetryAt.keys()) if (!tombstones.some((item) => item.deletionId === deletionId)) purgeRetryAt.delete(deletionId);
    if (expired.length === 0) {
      schedule();
      return;
    }
    const expiredIds = new Set(expired.map((item) => item.deletionId));
    const nextTombstones = tombstones.filter((item) => !expiredIds.has(item.deletionId));
    try {
      deps.save(nextTombstones);
    } catch (error) {
      schedule(PURGE_RETRY_MS);
      throw error;
    }
    tombstones = nextTombstones;
    for (const tombstone of expired) {
      if (tombstone.kind === "operation") {
        publishOperation(OPERATION_PURGED_EVENT_CHANNEL, tombstone.operation);
      } else {
        for (const operation of tombstone.operations) publishOperation(OPERATION_PURGED_EVENT_CHANNEL, operation);
      }
    }
    schedule();
  }

  function hasPendingOperation(operationId: string): boolean {
    sweepExpired();
    return tombstones.some((item) => item.kind === "operation"
      ? item.targetId === operationId
      : item.operations.some((operation) => operation.id === operationId));
  }

  function hasPendingTheater(theaterId: string): boolean {
    sweepExpired();
    return tombstones.some((item) => item.kind === "theater" && item.targetId === theaterId);
  }

  function schedule(forcedDelay?: number): void {
    if (timer) clearTimer(timer);
    timer = null;
    if (forcedDelay !== undefined) {
      timer = setTimer(runScheduledSweep, forcedDelay);
      timer.unref?.();
      return;
    }
    const nearest = tombstones.reduce<number | null>((minimum, item) => {
      const at = Math.max(item.expiresAt, purgeRetryAt.get(item.deletionId) ?? 0);
      return minimum === null ? at : Math.min(minimum, at);
    }, null);
    if (nearest === null) return;
    timer = setTimer(runScheduledSweep, Math.max(0, nearest - now()));
    timer.unref?.();
  }

  function runScheduledSweep(): void {
    timer = null;
    try {
      sweepExpired();
    } catch {
      // 저장 실패는 다음 단일 재시도 타이머에서 다시 처리한다.
    }
  }

  function dispose(): void {
    if (timer) clearTimer(timer);
    timer = null;
  }

  function publishOperation(channel: string, operation: OperationNode): void {
    deps.publish(channel, {
      operationId: operation.id,
      pluginId: operation.pluginId,
      type: operation.type,
      ...(channel === OPERATION_RESTORED_EVENT_CHANNEL ? { operation } : {}),
    });
  }

  return {
    list,
    load,
    deleteOperation,
    deleteTheater,
    restore,
    sweepExpired,
    hasPendingOperation,
    hasPendingTheater,
    dispose,
  };
}

function toReceipt(tombstone: DurableDeletionTombstone): DeferredDeletionReceipt {
  return {
    deletionId: tombstone.deletionId,
    kind: tombstone.kind,
    targetId: tombstone.targetId,
    expiresAt: tombstone.expiresAt,
  };
}

function hasGroupConflict(groups: readonly DurableOperationGroup[], existing: readonly DurableOperationGroup[]): boolean {
  const existingIds = new Set(existing.map((group) => group.id));
  return groups.some((group) => existingIds.has(group.id));
}
