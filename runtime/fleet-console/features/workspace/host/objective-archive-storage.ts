import crypto from "node:crypto";
import type { ObjectiveRecord } from "../../objectives/host/records/objective-records-domain.js";
import { deletionObjectiveRecords, sanitizeDeletionTombstone, sanitizeDurableConsoleState, sanitizeObjectiveRecord, STATE_VERSION, type DurableConsoleState, type DurableDeletionTombstone } from "./durable-state.js";

export interface ArchivedObjective {
  readonly objectiveRecord: ObjectiveRecord;
  readonly archiveId: string;
  readonly archivedAt: number;
}
export interface ArchiveLifecycleEvent {
  readonly eventId: string;
  readonly channel: "objective:archived" | "objective:restored" | "objective:deleted" | "objective:purged";
  readonly objectiveRecord: ObjectiveRecord;
}
interface ArchiveDocument {
  readonly version: 1;
  readonly revision: number;
  readonly entries: readonly ArchivedObjective[];
  readonly deletions: readonly DurableDeletionTombstone[];
  readonly events: readonly ArchiveLifecycleEvent[];
  readonly transaction?: {
    readonly beforeRevision: number;
    readonly beforeHash: string;
    readonly state: DurableConsoleState;
    readonly archive: Omit<ArchiveDocument, "transaction">;
  };
}

export class ObjectiveArchiveError extends Error {
  constructor(readonly status: number, code: string) { super(code); this.name = "ObjectiveArchiveError"; }
}

/** 기존 실행 서비스의 메모리 포트. 영속 구현은 목표 저장소가 소유한다. */
export interface ObjectiveArchiveStorage {
  load(): DurableConsoleState;
  save(state: DurableConsoleState, entries?: readonly ArchivedObjective[], events?: readonly ArchiveLifecycleEvent[]): void;
  assertReady(): void;
  acknowledgeEvents(ids: readonly string[]): void;
  entries(): readonly ArchivedObjective[];
  events(): readonly ArchiveLifecycleEvent[];
  revision(): number;
  blocked(): boolean;
}

/** 실행 정리용 투영이다. 자식은 별도 보관 레코드나 active 최상위 노드로 저장하지 않는다. */
export function archiveSessionNodes(objectiveRecord: ObjectiveRecord): readonly ObjectiveRecord[] {
  return [objectiveRecord, ...(objectiveRecord.sessions ?? []).map((child): ObjectiveRecord => ({...(child),
id: child.id,
theaterId: objectiveRecord.theaterId,
title: child.id,
parentObjectiveId: objectiveRecord.id,
ts: child.ts}))];
}

export function archiveEvent(channel: ArchiveLifecycleEvent["channel"], objectiveRecord: ObjectiveRecord): ArchiveLifecycleEvent {
  return { eventId: crypto.randomUUID(), channel, objectiveRecord };
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
export function readArchiveDocument(value: unknown): ArchiveDocument {
  if (!record(value) || value.version !== 1 || !integer(value.revision) || !Array.isArray(value.entries) || !Array.isArray(value.deletions) || !Array.isArray(value.events)) throw new ObjectiveArchiveError(503, "archive_recovery_required");
  const entries = value.entries.map((raw): ArchivedObjective => {
    const objectiveRecord = record(raw) ? sanitizeObjectiveRecord(raw.objectiveRecord ?? raw.operation) : null;
    if (!objectiveRecord || !record(raw) || typeof raw.archiveId !== "string" || !raw.archiveId || !integer(raw.archivedAt)) throw new ObjectiveArchiveError(503, "archive_recovery_required");
    return { objectiveRecord, archiveId: raw.archiveId, archivedAt: raw.archivedAt };
  });
  const deletions = value.deletions.map((raw) => {
    const result = sanitizeDeletionTombstone(raw);
    if (!result) throw new ObjectiveArchiveError(503, "archive_recovery_required");
    return result;
  });
  const channels = new Set(["objective:archived", "objective:restored", "objective:deleted", "objective:purged", "operation:archived", "operation:restored", "operation:deleted", "operation:purged"]);
  const events = value.events.map((raw): ArchiveLifecycleEvent => {
    const objectiveRecord = record(raw) ? sanitizeObjectiveRecord(raw.objectiveRecord ?? raw.operation) : null;
    if (!objectiveRecord || !record(raw) || typeof raw.eventId !== "string" || !channels.has(String(raw.channel))) throw new ObjectiveArchiveError(503, "archive_recovery_required");
    return { objectiveRecord, eventId: raw.eventId, channel: String(raw.channel).replace("operation:", "objective:") as ArchiveLifecycleEvent["channel"] };
  });
  let transaction: ArchiveDocument["transaction"];
  if (value.transaction !== undefined) {
    const tx = value.transaction;
    if (!record(tx) || !integer(tx.beforeRevision) || typeof tx.beforeHash !== "string" || !/^[a-f0-9]{64}$/.test(tx.beforeHash) || !record(tx.state) || tx.state.version !== STATE_VERSION || !integer(tx.state.revision) || !record(tx.archive) || tx.archive.transaction !== undefined) throw new ObjectiveArchiveError(503, "archive_recovery_required");
    const state = sanitizeDurableConsoleState(tx.state);
    if (!Array.isArray(tx.state.objectiveRecords ?? tx.state.operations) || state.objectiveRecords.length !== ((tx.state.objectiveRecords ?? tx.state.operations) as unknown[]).length) throw new ObjectiveArchiveError(503, "archive_recovery_required");
    transaction = { beforeRevision: tx.beforeRevision, beforeHash: tx.beforeHash, state: tx.state as unknown as DurableConsoleState, archive: readArchiveDocument(tx.archive) };
  }
  return { version: 1, revision: value.revision, entries, deletions, events, ...(transaction ? { transaction } : {}) };
}
export function validateLocations(active: readonly ObjectiveRecord[], entries: readonly ArchivedObjective[], deletions: readonly DurableDeletionTombstone[]): void {
  const ids = new Set<string>();
  for (const node of [...active, ...entries.map((entry) => entry.objectiveRecord), ...deletions.flatMap(deletionObjectiveRecords)].flatMap(archiveSessionNodes)) {
    if (ids.has(node.id)) throw new ObjectiveArchiveError(409, "archive_cluster_conflict");
    ids.add(node.id);
  }
}
