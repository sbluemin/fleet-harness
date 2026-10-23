import crypto from "node:crypto";

import { deletionObjectiveRecords, type DurableDeletionTombstone, type DurableObjectiveGroup } from "./durable-state.js";
import type { ArchivedObjective } from "./objective-archive-storage.js";
import type { ObjectiveRecord, ObjectiveRecordsStore } from "../../objectives/host/records/objective-records-domain.js";
import { DELETION_GRACE_MS } from "../../objectives/host/records/objective-records-domain.js";
import type { TheaterRegistration } from "./theaters/theater-domain.js";
import type { TheaterRegistry } from "./theaters/theater-domain.js";

export interface DeferredDeletionReceipt {
  readonly deletionId: string;
  readonly kind: "objectiveRecord" | "theater";
  readonly targetId: string;
  readonly expiresAt: number;
  /** Theater 잊기의 기존 toast에 표시할 보관 Objective 수. */
  readonly archivedObjectiveCount?: number;
}

export interface DeferredDeletionResponse {
  readonly ok: true;
  readonly deletion: DeferredDeletionReceipt | null;
}

export interface DeferredRestoreResponse {
  readonly ok: true;
  readonly kind: "objectiveRecord" | "theater";
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
  readonly deleteObjective: (objectiveId: string) => DeferredDeletionReceipt | null;
  readonly deleteTheater: (theaterId: string) => DeferredDeletionReceipt | null;
  readonly restore: (deletionId: string) => Promise<DeferredRestoreResponse>;
  readonly sweepExpired: () => void;
  readonly hasPendingObjective: (objectiveId: string) => boolean;
  readonly hasPendingTheater: (theaterId: string) => boolean;
  readonly dispose: () => void;
}

interface DeferredDeletionCoordinatorDeps {
  readonly objectiveRecords: ObjectiveRecordsStore;
  readonly theaters: TheaterRegistry;
  readonly save: (tombstones: readonly DurableDeletionTombstone[], archives?: readonly ArchivedObjective[]) => void;
  readonly archives?: () => readonly ArchivedObjective[];
  readonly assertMutable?: (id: string) => void;
  readonly publish: (channel: string, payload: unknown) => void;
  readonly unregisterTheaterWorkspaces: (theaterId: string) => void;
  readonly validateTheaterRestore: (theater: TheaterRegistration) => Promise<void>;
  readonly registerTheaterWorkspace: (theater: TheaterRegistration) => Promise<void>;
  /**
   * 유예가 끝난 Objective 의 흔적을 지우기 **전에** 관련 자원을 정리한다. 던지면 tombstone 을 그대로 남겨
   * 이번 정리를 미루고 다시 시도한다.
   */
  readonly beforePurge?: (objectiveRecords: readonly ObjectiveRecord[], tombstone: DurableDeletionTombstone) => void;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

const OBJECTIVE_DELETED_EVENT_CHANNEL = "objective:deleted";
const OBJECTIVE_RESTORED_EVENT_CHANNEL = "objective:restored";
const OBJECTIVE_PURGED_EVENT_CHANNEL = "objective:purged";
const PURGE_RETRY_MS = 1_000;

export function createDeferredDeletionCoordinator(deps: DeferredDeletionCoordinatorDeps): DeferredDeletionCoordinator {
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? crypto.randomUUID;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  let tombstones: readonly DurableDeletionTombstone[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  // purge 전 자원 정리(beforePurge)에 실패한 tombstone 의 다음 시도 시각 — 그 tombstone 만 남겨 미루고, 다른 정리와 생성·삭제는 막지 않는다.
  const purgeRetryAt = new Map<string, number>();

  function list(): readonly DurableDeletionTombstone[] {
    return tombstones;
  }

  function load(nextTombstones: readonly DurableDeletionTombstone[]): void {
    tombstones = [...nextTombstones];
    schedule();
  }

  function deleteObjective(objectiveId: string): DeferredDeletionReceipt | null {
    sweepExpired();
    const existing = tombstones.find((item) => deletionObjectiveRecords(item).some((node) => node.id === objectiveId));
    if (existing) return toReceipt(existing);
    // 자식 세션은 부모와 함께 저장한다. 합성 실행 뷰를 독립 묘비로 만들지 않는다.
    if (deps.objectiveRecords.getChild(objectiveId)) return null;
    const archives = deps.archives?.() ?? [];
    const all = [...deps.objectiveRecords.list(), ...archives.map((entry) => entry.objectiveRecord)];
    const objectiveRecord = all.find((node) => node.id === objectiveId);
    if (!objectiveRecord) return null;
    const ids = new Set([objectiveId]);
    let previousSize = -1;
    while (previousSize !== ids.size) {
      previousSize = ids.size;
      for (const node of all) if (node.parentObjectiveId && ids.has(node.parentObjectiveId)) ids.add(node.id);
    }
    const affected = all.filter((node) => ids.has(node.id));
    for (const node of affected) deps.assertMutable?.(node.id);
    const archived = Object.fromEntries(archives.filter((entry) => ids.has(entry.objectiveRecord.id)).map((entry) => [entry.objectiveRecord.id, { archiveId: entry.archiveId, archivedAt: entry.archivedAt }]));
    const previousObjectiveRecords = deps.objectiveRecords.list();
    const deletedAt = now();
    const tombstone: DurableDeletionTombstone = {
      deletionId: randomId(),
      targetId: objectiveRecord.id,
      deletedAt,
      expiresAt: deletedAt + DELETION_GRACE_MS,
      kind: "objectiveRecord",
      objectiveRecord,
      ...(affected.length > 1 ? { descendants: affected.filter((node) => node.id !== objectiveId) } : {}),
      ...(Object.keys(archived).length ? { archived } : {}),
    };
    const nextTombstones = [...tombstones, tombstone];
    for (const node of affected) deps.objectiveRecords.delete(node.id);
    try {
      deps.save(nextTombstones, archives.filter((entry) => !ids.has(entry.objectiveRecord.id)));
    } catch (error) {
      deps.objectiveRecords.replace(previousObjectiveRecords);
      throw error;
    }
    tombstones = nextTombstones;
    for (const node of affected) publishObjective(OBJECTIVE_DELETED_EVENT_CHANNEL, node);
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
    const previousObjectiveRecords = deps.objectiveRecords.list();
    const previousGroups = deps.objectiveRecords.listAllGroups();
    const archives = deps.archives?.() ?? [];
    const archived = Object.fromEntries(archives.filter((entry) => entry.objectiveRecord.theaterId === theaterId).map((entry) => [entry.objectiveRecord.id, { archiveId: entry.archiveId, archivedAt: entry.archivedAt }]));
    const deletedObjectiveRecords = [...deps.objectiveRecords.listByTheater(theaterId), ...archives.filter((entry) => entry.objectiveRecord.theaterId === theaterId).map((entry) => entry.objectiveRecord)];
    for (const node of deletedObjectiveRecords) deps.assertMutable?.(node.id);
    const deletedGroups = deps.objectiveRecords.listGroups(theaterId);
    const deletedAt = now();
    const tombstone: DurableDeletionTombstone = {
      deletionId: randomId(),
      targetId: theater.id,
      deletedAt,
      expiresAt: deletedAt + DELETION_GRACE_MS,
      kind: "theater",
      theater,
      objectiveRecords: deletedObjectiveRecords,
      groups: deletedGroups,
      ...(Object.keys(archived).length ? { archived } : {}),
    };
    const nextTombstones = [...tombstones, tombstone];
    deps.theaters.remove(theaterId);
    deps.objectiveRecords.deleteByTheater(theaterId);
    try {
      deps.save(nextTombstones, archives.filter((entry) => entry.objectiveRecord.theaterId !== theaterId));
    } catch (error) {
      deps.theaters.restore(previousTheaters);
      deps.objectiveRecords.replace(previousObjectiveRecords);
      deps.objectiveRecords.replaceGroups(previousGroups);
      throw error;
    }
    tombstones = nextTombstones;
    deps.unregisterTheaterWorkspaces(theaterId);
    for (const objectiveRecord of deletedObjectiveRecords) publishObjective(OBJECTIVE_DELETED_EVENT_CHANNEL, objectiveRecord);
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
    const archives = deps.archives?.() ?? [];
    const restoredNodes = deletionObjectiveRecords(tombstone);
    const archivedIds = new Set(Object.keys(tombstone.archived ?? {}));
    const restoredArchives = restoredNodes.filter((node) => archivedIds.has(node.id)).map((objectiveRecord) => ({ objectiveRecord, ...tombstone.archived![objectiveRecord.id]! }));
    const activeRestores = restoredNodes.filter((node) => !archivedIds.has(node.id));
    if (tombstone.kind === "objectiveRecord") {
      if (restoredNodes.some((node) => deps.objectiveRecords.get(node.id) || archives.some((entry) => entry.objectiveRecord.id === node.id)) || !deps.theaters.get(tombstone.objectiveRecord.theaterId)) {
        throw new DeferredDeletionError(409, "restore_conflict");
      }
      const previousObjectiveRecords = deps.objectiveRecords.list();
      const nextTombstones = tombstones.filter((item) => item.deletionId !== deletionId);
      deps.objectiveRecords.replace([...previousObjectiveRecords, ...activeRestores]);
      try {
        deps.save(nextTombstones, [...archives, ...restoredArchives]);
      } catch (error) {
        deps.objectiveRecords.replace(previousObjectiveRecords);
        throw error;
      }
      tombstones = nextTombstones;
      for (const node of activeRestores) publishObjective(OBJECTIVE_RESTORED_EVENT_CHANNEL, node);
      schedule();
      return { ok: true, kind: tombstone.kind, targetId: tombstone.targetId };
    }

    await deps.validateTheaterRestore(tombstone.theater);
    if (deps.theaters.get(tombstone.targetId)
      || tombstone.objectiveRecords.some((objectiveRecord) => deps.objectiveRecords.get(objectiveRecord.id) || archives.some((entry) => entry.objectiveRecord.id === objectiveRecord.id))
      || hasGroupConflict(tombstone.groups, deps.objectiveRecords.listAllGroups())) {
      throw new DeferredDeletionError(409, "restore_conflict");
    }
    const previousTheaters = deps.theaters.list();
    const previousObjectiveRecords = deps.objectiveRecords.list();
    const previousGroups = deps.objectiveRecords.listAllGroups();
    const nextTombstones = tombstones.filter((item) => item.deletionId !== deletionId);
    deps.theaters.restore([...previousTheaters, tombstone.theater]);
    deps.objectiveRecords.replace([...previousObjectiveRecords, ...activeRestores]);
    deps.objectiveRecords.replaceGroups([...previousGroups, ...tombstone.groups]);
    try {
      deps.save(nextTombstones, [...archives, ...restoredArchives]);
    } catch (error) {
      deps.theaters.restore(previousTheaters);
      deps.objectiveRecords.replace(previousObjectiveRecords);
      deps.objectiveRecords.replaceGroups(previousGroups);
      throw error;
    }
    tombstones = nextTombstones;
    await deps.registerTheaterWorkspace(tombstone.theater);
    for (const objectiveRecord of activeRestores) publishObjective(OBJECTIVE_RESTORED_EVENT_CHANNEL, objectiveRecord);
    schedule();
    return { ok: true, kind: tombstone.kind, targetId: tombstone.targetId };
  }

  function sweepExpired(): void {
    const cutoff = now();
    const due = tombstones.filter((item) => item.expiresAt <= cutoff && (purgeRetryAt.get(item.deletionId) ?? 0) <= cutoff);
    // purge 전 자원 정리는 tombstone 마다 따로 — 실패한 것은 남겨 나중에 다시 시도하고, 나머지는 정리한다.
    const expired = due.filter((item) => {
      if (!deps.beforePurge) return true;
      try {
        deps.beforePurge(deletionObjectiveRecords(item), item);
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
      for (const objectiveRecord of deletionObjectiveRecords(tombstone)) publishObjective(OBJECTIVE_PURGED_EVENT_CHANNEL, objectiveRecord);
    }
    schedule();
  }

  function hasPendingObjective(objectiveId: string): boolean {
    sweepExpired();
    return tombstones.some((item) => deletionObjectiveRecords(item).some((objectiveRecord) => objectiveRecord.id === objectiveId || objectiveRecord.sessions?.some((child) => child.id === objectiveId)));
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

  function publishObjective(channel: string, objectiveRecord: ObjectiveRecord): void {
    deps.publish(channel, {
      objectiveId: objectiveRecord.id,
      pluginId: null,
      type: "agent",
      ...(channel === OBJECTIVE_RESTORED_EVENT_CHANNEL ? { objectiveRecord } : {}),
    });
    for (const child of objectiveRecord.sessions ?? []) {
      deps.publish(channel, {
        objectiveId: child.id,
        pluginId: null,
        type: "agent",
        ...(channel === OBJECTIVE_RESTORED_EVENT_CHANNEL ? { objectiveRecord: deps.objectiveRecords.get(child.id) } : {}),
      });
    }
  }

  return {
    list,
    load,
    deleteObjective,
    deleteTheater,
    restore,
    sweepExpired,
    hasPendingObjective,
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
    archivedObjectiveCount: Object.keys(tombstone.archived ?? {}).length,
  };
}

function hasGroupConflict(groups: readonly DurableObjectiveGroup[], existing: readonly DurableObjectiveGroup[]): boolean {
  const existingIds = new Set(existing.map((group) => group.id));
  return groups.some((group) => existingIds.has(group.id));
}
