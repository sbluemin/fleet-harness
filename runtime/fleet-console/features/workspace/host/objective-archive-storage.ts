import crypto from "node:crypto";
import type { ObjectiveRecord } from "../../objectives/host/records/objective-records-domain.js";
import { deletionObjectiveRecords, type DurableConsoleState, type DurableDeletionTombstone } from "./durable-state.js";

export interface ArchivedObjective {
  readonly objectiveRecord: ObjectiveRecord;
  readonly archiveId: string;
  readonly archivedAt: number;
}
export interface ArchiveLifecycleEvent {
  readonly eventId: string;
  readonly channel: "objective:archived" | "objective:restored" | "objective:deleted" | "objective:purged";
  readonly objectiveId: string;
  readonly theaterId: string;
  readonly sessionIds: readonly string[];
  /** 복원 방송만 현재 본문을 읽는다. outbox에는 이 뷰를 저장하지 않는다. */
  readonly objectiveRecord?: ObjectiveRecord;
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
  return [objectiveRecord, ...(objectiveRecord.sessions ?? []).map((child): ObjectiveRecord => ({ ...child,
    id: child.id, theaterId: objectiveRecord.theaterId, title: child.id, parentObjectiveId: objectiveRecord.id, ts: child.ts,
  }))];
}

export function archiveEvent(channel: ArchiveLifecycleEvent["channel"], objectiveRecord: ObjectiveRecord): ArchiveLifecycleEvent {
  return { eventId: crypto.randomUUID(), channel, objectiveId: objectiveRecord.id, theaterId: objectiveRecord.theaterId,
    sessionIds: (objectiveRecord.sessions ?? []).map((child) => child.id),
    ...(channel === "objective:restored" ? { objectiveRecord } : {}),
  };
}
export function validateLocations(active: readonly ObjectiveRecord[], entries: readonly ArchivedObjective[], deletions: readonly DurableDeletionTombstone[]): void {
  const ids = new Set<string>();
  for (const node of [...active, ...entries.map((entry) => entry.objectiveRecord), ...deletions.flatMap(deletionObjectiveRecords)].flatMap(archiveSessionNodes)) {
    if (ids.has(node.id)) throw new ObjectiveArchiveError(409, "archive_cluster_conflict");
    ids.add(node.id);
  }
}
