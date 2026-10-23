import crypto from "node:crypto";
import { OBJECTIVE_PURGE_GRACE_MS, type ObjectiveAccessIntent, type ObjectiveAccessResult, type ObjectiveArchiveCapability, type ObjectiveArchiveReceipt, type ObjectiveDescription, type ObjectivePendingPurge, type ObjectivePurgeConfirmation } from "../../objectives/shared/records/archive.js";
import type { ObjectiveRecord, ObjectiveRecordsStore } from "../../objectives/host/records/objective-records-domain.js";
import type { DurableConsoleState } from "./durable-state.js";
import { archiveEvent, archiveSessionNodes, ObjectiveArchiveError, type ArchivedObjective, type ArchiveLifecycleEvent, type ObjectiveArchiveStorage } from "./objective-archive-storage.js";

interface ObjectiveArchiveDeps {
  readonly objectiveRecords: ObjectiveRecordsStore;
  readonly storage: ObjectiveArchiveStorage;
  readonly snapshot: () => DurableConsoleState;
  readonly theaterExists: (id: string) => boolean;
  readonly pendingDeletion: (id: string) => boolean;
  readonly stop: (objectiveRecord: ObjectiveRecord) => Promise<void>;
  readonly use: (id: string, intent: ObjectiveAccessIntent) => Promise<void>;
  readonly publish: (event: ArchiveLifecycleEvent) => void;
  readonly publishChanged: () => void;
  readonly now?: () => number;
  readonly setTimer?: typeof setTimeout;
  readonly clearTimer?: typeof clearTimeout;
  /** 최신 보관 일수. null·부재·허용 밖은 꺼짐이다. 저장 요청 안에서는 지우지 않는다. */
  readonly readRetentionDays?: () => 7 | 30 | 90 | null;
}

const RETENTION_INTERVAL_MS = 60_000;
const RETENTION_DAY_MS = 86_400_000;

/** 보관 단위는 최상위 Objective이다. 자식은 부모의 sessions 안에서만 이동한다. */
export function createObjectiveArchiveCoordinator(deps: ObjectiveArchiveDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  let serial: Promise<unknown> = Promise.resolve();
  const locked = new Set<string>();
  // 유예를 durable tombstone으로 옮기지 않는다. 종료·크래시 중 시간이 지나도 원본과 데이터는 온전히 남는다.
  const pending = new Map<string, { readonly receipt: ObjectivePendingPurge; readonly entries: readonly ArchivedObjective[] }>();
  let volatileRevision = 0;
  // 브라우저 revision은 불투명한 비교 토큰이다. 메모리 보류가 사라진 재기동에서 옛 preview를 재사용하지 못하게 한다.
  const epoch = crypto.randomInt(1, 2 ** 48);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retentionTimer: ReturnType<typeof setTimeout> | null = null;
  let retentionStarted = false;
  let disposed = false;
  const revision = () => epoch + deps.storage.revision() + volatileRevision;
  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const task = serial.then(run, run);
    serial = task.catch(() => undefined);
    return task;
  }
  function all(): readonly ObjectiveRecord[] { return [...deps.objectiveRecords.list(), ...deps.storage.entries().map((entry) => entry.objectiveRecord)]; }
  function find(id: string): ObjectiveRecord | undefined {
    return all().find((objectiveRecord) => objectiveRecord.id === id || objectiveRecord.sessions?.some((child) => child.id === id));
  }
  function pendingFor(id: string): boolean {
    return [...pending.values()].some((batch) => batch.entries.some((entry) => entry.objectiveRecord.id === id || entry.objectiveRecord.sessions?.some((child) => child.id === id)));
  }
  function requireNode(id: string): ObjectiveRecord {
    deps.storage.assertReady();
    if (disposed) throw new ObjectiveArchiveError(503, "archive_recovery_required");
    if (deps.pendingDeletion(id) || pendingFor(id)) throw new ObjectiveArchiveError(409, "pending_deletion");
    const objectiveRecord = find(id);
    if (!objectiveRecord) throw new ObjectiveArchiveError(404, "unknown_objectiveRecord");
    return objectiveRecord;
  }
  function requireRoot(id: string): ObjectiveRecord {
    const objectiveRecord = requireNode(id);
    if (objectiveRecord.id !== id) throw new ObjectiveArchiveError(409, "child_session_not_closable");
    return objectiveRecord;
  }
  function describe(id: string): ObjectiveDescription | null {
    const objectiveRecord = find(id);
    if (!objectiveRecord) return null;
    const entry = deps.storage.entries().find((entry) => entry.objectiveRecord.id === objectiveRecord.id);
    return { objectiveRecord, location: entry ? "archived" : "active", rootObjectiveId: objectiveRecord.id, archivedAt: entry?.archivedAt ?? null };
  }
  function listArchived(theaterId?: string) {
    const entries = deps.storage.entries().filter((entry) => !theaterId || entry.objectiveRecord.theaterId === theaterId)
      .sort((a, b) => b.archivedAt - a.archivedAt || a.objectiveRecord.id.localeCompare(b.objectiveRecord.id))
      .map((entry): ObjectiveDescription => ({ objectiveRecord: entry.objectiveRecord, location: "archived", rootObjectiveId: entry.objectiveRecord.id, archivedAt: entry.archivedAt }));
    const ids = new Set(entries.map((entry) => entry.objectiveRecord.id));
    return { revision: revision(), total: entries.length, entries, pendingPurges: [...pending.values()].filter((batch) => batch.receipt.objectiveIds.some((id) => ids.has(id))).map((batch) => batch.receipt) };
  }
  function flushEvents(): void {
    for (const event of deps.storage.events()) {
      deps.publish(event);
      deps.storage.acknowledgeEvents([event.eventId]);
    }
  }
  function commit(objectiveRecords: readonly ObjectiveRecord[], entries: readonly ArchivedObjective[], events: readonly ArchiveLifecycleEvent[]): void {
    // 디스크 확정 전 active Map을 바꾸지 않는다. 실패한 prepare는 다음 기동이 복구한다.
    deps.storage.save({ ...deps.snapshot(), objectiveRecords }, entries, events);
    deps.objectiveRecords.replace(objectiveRecords);
    flushEvents();
    deps.publishChanged();
  }
  async function withStopped<T>(root: ObjectiveRecord, run: () => T): Promise<T> {
    const nodes = archiveSessionNodes(root);
    for (const node of nodes) locked.add(node.id);
    try {
      for (const node of nodes) if (deps.objectiveRecords.get(node.id)) await deps.stop(node);
      deps.storage.assertReady();
      return run();
    } finally { for (const node of nodes) locked.delete(node.id); }
  }
  function receipt(entry: ArchivedObjective): ObjectiveArchiveReceipt {
    const id = entry.objectiveRecord.id;
    return { archiveId: entry.archiveId, targetId: id, rootObjectiveId: id, objectiveIds: [id], archivedAt: entry.archivedAt, revision: revision() };
  }
  const archive = (id: string): Promise<ObjectiveArchiveReceipt> => enqueue(async () => {
    const root = requireRoot(id);
    const existing = deps.storage.entries().find((entry) => entry.objectiveRecord.id === id);
    if (existing) return receipt(existing);
    return withStopped(root, () => {
      const objectiveRecord = deps.objectiveRecords.get(id)!;
      const moved = { objectiveRecord, archiveId: crypto.randomUUID(), archivedAt: now() };
      commit(deps.objectiveRecords.list().filter((node) => node.id !== id), [...deps.storage.entries(), moved], [archiveEvent("objective:archived", objectiveRecord)]);
      return receipt(moved);
    });
  });
  function dormant(root: ObjectiveRecord): ObjectiveRecord {
    if (!deps.theaterExists(root.theaterId)) throw new ObjectiveArchiveError(409, "restore_parent_missing");
    const groups = new Set(deps.objectiveRecords.listGroups(root.theaterId).map((group) => group.id));
    return {
      ...root,
      ...(root.groupId && !groups.has(root.groupId) ? { groupId: null } : {}),
      ...({ ...root, restoredDormant: true }),
      ...(root.sessions ? { sessions: root.sessions.map((child) => ({ ...child, ...({ ...child, restoredDormant: true }) })) } : {}),
    };
  }
  async function accessNow(id: string, intent: ObjectiveAccessIntent): Promise<ObjectiveAccessResult> {
    const root = requireNode(id);
    if (!deps.theaterExists(root.theaterId)) throw new ObjectiveArchiveError(409, "restore_parent_missing");
    const archived = deps.storage.entries().some((entry) => entry.objectiveRecord.id === root.id);
    if (archived) {
      const restored = dormant(root);
      commit([...deps.objectiveRecords.list(), restored], deps.storage.entries().filter((entry) => entry.objectiveRecord.id !== root.id), [archiveEvent("objective:restored", restored)]);
    }
    // 명시적 자식 사용도 부모를 통째로 복원한 뒤 원래 세션 ID로 보낸다.
    await deps.use(id, intent);
    return { targetId: id, rootObjectiveId: root.id, restoredIds: archived ? [root.id] : [], objectiveRecords: [deps.objectiveRecords.get(root.id)!] };
  }
  const access = (id: string, intent: ObjectiveAccessIntent = "ensure-active") => enqueue(() => accessNow(id, intent));
  const restore = (id: string) => access(id);
  const undoArchive = (input: Pick<ObjectiveArchiveReceipt, "targetId" | "archiveId">) => enqueue(async () => {
    const entry = deps.storage.entries().find((entry) => entry.objectiveRecord.id === input.targetId);
    if (!entry || entry.archiveId !== input.archiveId) throw new ObjectiveArchiveError(409, "archive_undo_conflict");
    return accessNow(input.targetId, "ensure-active");
  });
  function previewBatch(ids: readonly string[]): ObjectivePurgeConfirmation {
    if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== "string" || !id || id.length > 128)) throw new ObjectiveArchiveError(400, "invalid_archive_request");
    deps.storage.assertReady();
    if (disposed) throw new ObjectiveArchiveError(503, "archive_recovery_required");
    const archived = new Set(deps.storage.entries().map((entry) => entry.objectiveRecord.id));
    for (const id of ids) {
      if (deps.pendingDeletion(id) || pendingFor(id)) throw new ObjectiveArchiveError(409, "pending_deletion");
      if (!archived.has(id)) {
        requireRoot(id); // 미지의 ID·자식 세션 거절은 기존 단건 경계와 같다.
        throw new ObjectiveArchiveError(409, "objectiveRecord_not_archived");
      }
    }
    return { targetId: ids[0]!, objectiveIds: [...ids].sort(), revision: revision() };
  }
  const previewPurge = (id: string) => previewBatch([id]);
  function confirmedEntries(confirmation: ObjectivePurgeConfirmation): readonly ArchivedObjective[] {
    // revision 확인과 대상 집합 검증은 단건·일괄 모두 같은 경계에서 끝낸다.
    if (confirmation.revision !== revision() || !confirmation.objectiveIds.includes(confirmation.targetId)) throw new ObjectiveArchiveError(409, "archive_revision_conflict");
    const current = previewBatch(confirmation.objectiveIds);
    if (JSON.stringify([...confirmation.objectiveIds].sort()) !== JSON.stringify(current.objectiveIds)) throw new ObjectiveArchiveError(409, "archive_revision_conflict");
    const entries = new Map(deps.storage.entries().map((entry) => [entry.objectiveRecord.id, entry]));
    return current.objectiveIds.map((id) => entries.get(id)!);
  }
  const restoreBatch = (confirmation: ObjectivePurgeConfirmation) => enqueue(async () => {
    const entries = confirmedEntries(confirmation);
    // 모든 부모와 그룹을 먼저 검증한 뒤 한 번만 확정한다. 부분 복원은 없다.
    const restored = entries.map((entry) => dormant(entry.objectiveRecord));
    const ids = new Set(confirmation.objectiveIds);
    commit([...deps.objectiveRecords.list(), ...restored], deps.storage.entries().filter((entry) => !ids.has(entry.objectiveRecord.id)), restored.map((node) => archiveEvent("objective:restored", node)));
    return { objectiveRecords: restored, revision: revision() };
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
      const intact = batch.entries.every((original) => deps.storage.entries().some((entry) => entry.archiveId === original.archiveId && entry.objectiveRecord.id === original.objectiveRecord.id));
      pending.delete(purgeId);
      volatileRevision += 1;
      if (intact) {
        const ids = new Set(batch.receipt.objectiveIds);
        commit(deps.objectiveRecords.list(), deps.storage.entries().filter((entry) => !ids.has(entry.objectiveRecord.id)), batch.entries.map((entry) => archiveEvent("objective:purged", entry.objectiveRecord)));
      } else deps.publishChanged();
    }
    schedule();
  });
  const purge = (confirmation: ObjectivePurgeConfirmation) => enqueue(async () => {
    const entries = confirmedEntries(confirmation);
    const receipt: ObjectivePendingPurge = Object.freeze({ purgeId: crypto.randomUUID(), objectiveIds: Object.freeze(entries.map((entry) => entry.objectiveRecord.id)), purgeAt: now() + OBJECTIVE_PURGE_GRACE_MS });
    pending.set(receipt.purgeId, { receipt, entries });
    volatileRevision += 1;
    schedule();
    deps.publishChanged();
    return { ...receipt, revision: revision() };
  });
  const undoPurge = (purgeId: string) => enqueue(async () => {
    const batch = pending.get(purgeId);
    if (!batch || now() >= batch.receipt.purgeAt) throw new ObjectiveArchiveError(409, "archive_undo_conflict");
    pending.delete(purgeId);
    volatileRevision += 1;
    schedule();
    deps.publishChanged();
    return { objectiveIds: batch.receipt.objectiveIds, revision: revision() };
  });
  function retentionDays(): 7 | 30 | 90 | null {
    const value = deps.readRetentionDays?.();
    return value === 7 || value === 30 || value === 90 ? value : null;
  }
  function isExpired(entry: ArchivedObjective, currentNow: number, limit: number): boolean {
    return Number.isSafeInteger(entry.archivedAt) && entry.archivedAt >= 0 && entry.archivedAt <= currentNow && currentNow - entry.archivedAt >= limit;
  }
  function isProtected(entry: ArchivedObjective): boolean {
    return pendingFor(entry.objectiveRecord.id) || deps.pendingDeletion(entry.objectiveRecord.id);
  }
  const sweepRetention = () => enqueue(async () => {
    if (disposed) return;
    deps.storage.assertReady();
    // 이 큐 턴에는 await가 없다. 설정과 현재 목록을 한 번만 읽고 archiveId로 가른다.
    const days = retentionDays();
    const currentNow = now();
    if (days === null || !Number.isFinite(currentNow)) return;
    const limit = days * RETENTION_DAY_MS;
    const dueIds = new Set<string>();
    for (const entry of deps.storage.entries()) {
      if (isExpired(entry, currentNow, limit) && !isProtected(entry)) dueIds.add(entry.archiveId);
    }
    if (!dueIds.size) return;
    // pendingDeletion이 동기 save로 목록 참조를 갈아끼울 수 있어, commit 기준은 그 다음 목록이다.
    const entries = deps.storage.entries();
    const confirmed = entries.filter((entry) => dueIds.has(entry.archiveId));
    if (!confirmed.length) return;
    commit(deps.objectiveRecords.list(), entries.filter((entry) => !dueIds.has(entry.archiveId)), confirmed.map((entry) => archiveEvent("objective:purged", entry.objectiveRecord)));
  });
  function runRetention(): Promise<void> {
    return sweepRetention().catch(() => {
      // 저장 실패·복구 필요는 원본과 blocked 를 그대로 둔다. 다음 확인이 재시도한다.
    });
  }
  function armRetention(): void {
    if (disposed || retentionTimer) return;
    retentionTimer = setTimer(() => {
      retentionTimer = null;
      void runRetention().finally(() => { if (!disposed) armRetention(); });
    }, RETENTION_INTERVAL_MS);
    retentionTimer.unref?.();
  }
  function startRetention(): Promise<void> {
    if (disposed || retentionStarted) return Promise.resolve();
    retentionStarted = true;
    // 다음 60초는 이번 sweep이 끝난 뒤에만 건다. 긴 stop 뒤에 틱이 큐에 쌓이지 않게 한다.
    return runRetention().finally(() => { if (!disposed) armRetention(); });
  }
  const capability: ObjectiveArchiveCapability = { describe, listArchived, archive, access, restore, undoArchive, previewPurge, purge };
  return {
    ...capability, purge, previewBatch, restoreBatch, undoPurge, sweepExpired, sweepRetention, startRetention, revision, flushEvents,
    dispose: () => {
      disposed = true;
      if (timer) clearTimer(timer);
      timer = null;
      if (retentionTimer) clearTimer(retentionTimer);
      retentionTimer = null;
      pending.clear();
    },
    isTransitioning: (id: string) => locked.has(id) || pendingFor(id),
    assertMutable: (id: string) => { deps.storage.assertReady(); if (locked.has(id) || pendingFor(id)) throw new ObjectiveArchiveError(409, "objectiveRecord_busy"); },
  };
}
export type ObjectiveArchiveCoordinator = ReturnType<typeof createObjectiveArchiveCoordinator>;
