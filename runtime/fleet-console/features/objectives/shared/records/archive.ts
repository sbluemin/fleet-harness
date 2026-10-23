import type { ObjectiveRecord } from "./types.js";

/** 보관은 별도 저장소에 있다. 기본 Objective 목록과 get의 의미는 바꾸지 않는다. */
export const OBJECTIVE_ARCHIVE_PATH = "/api/v1/objectives/records/archive";
export const OBJECTIVE_ARCHIVE_CHANGED_EVENT = "objective:archive-changed";
export const OBJECTIVE_ARCHIVED_EVENT = "objective:archived";
export const OBJECTIVE_PURGED_EVENT = "objective:purged";
export const OBJECTIVE_CLUSTER_CHANGED_EVENT = "objective:cluster-changed";

export type ObjectiveAccessIntent = "ensure-active" | "open" | "activate" | "resume";

export interface ObjectiveDescription {
  readonly objectiveRecord: ObjectiveRecord;
  readonly location: "active" | "archived";
  readonly rootObjectiveId: string;
  readonly archivedAt: number | null;
}

export interface ObjectiveArchiveReceipt {
  readonly archiveId: string;
  readonly targetId: string;
  readonly rootObjectiveId: string;
  readonly objectiveIds: readonly string[];
  readonly archivedAt: number;
  readonly revision: number;
}

export interface ObjectiveAccessResult {
  readonly targetId: string;
  readonly rootObjectiveId: string;
  readonly restoredIds: readonly string[];
  /** 브라우저 응답에서는 일반 Objective DTO와 동일하게 정화한다. */
  readonly objectiveRecords: readonly ObjectiveRecord[];
}

export interface ObjectiveArchiveSnapshot {
  readonly revision: number;
  readonly total: number;
  readonly entries: readonly ObjectiveDescription[];
  readonly pendingPurges?: readonly ObjectivePendingPurge[];
}

/** 유예 중에는 원본 보관 기록을 그대로 둔다. 보류만 서버 메모리에 있으며 재기동은 이를 취소한다. */
export interface ObjectivePendingPurge {
  readonly purgeId: string;
  readonly objectiveIds: readonly string[];
  readonly purgeAt: number;
}

export const OBJECTIVE_PURGE_GRACE_MS = 10_000;

/** 확인한 대상 집합과 revision을 그대로 확정 요청에 보낸다. */
export interface ObjectivePurgeConfirmation {
  readonly targetId: string;
  readonly objectiveIds: readonly string[];
  readonly revision: number;
}

export interface ObjectivePurgeResult {
  readonly objectiveIds: readonly string[];
  readonly revision: number;
  readonly purgeId?: string;
  readonly purgeAt?: number;
}

export interface ObjectiveArchiveRestoreResult {
  readonly objectiveRecords: readonly ObjectiveRecord[];
  readonly revision: number;
}

export interface ObjectiveArchiveChangedEvent {
  readonly revision: number;
  readonly total: number;
  /** total은 전체 수이며, 입구는 활성 Theater의 수만 읽는다. */
  readonly totalsByTheater?: Readonly<Record<string, number>>;
}

export interface ObjectiveClusterChangedEvent {
  readonly removedIds: readonly string[];
  readonly objectiveRecords: readonly ObjectiveRecord[];
}

/** 공개 lifecycle 사건에는 경로·원본 payload·확장 기능별 상태를 넣지 않는다. */
export interface ObjectivePurgedEvent {
  readonly eventId: string;
  readonly objectiveId: string;
  readonly theaterId: string;
  readonly pluginId: string | null;
  readonly type: string;
}

export type ObjectiveArchiveErrorCode =
  | "unknown_objectiveRecord" | "objectiveRecord_busy" | "pending_deletion"
  | "archive_not_found" | "archive_revision_conflict" | "archive_undo_conflict"
  | "archive_cluster_conflict" | "archive_recovery_required" | "archive_stop_failed"
  | "objectiveRecord_not_archived" | "restore_parent_missing" | "invalid_archive_request" | "child_session_not_closable";

/**
 * Host는 이 capability를 구현한다. get/list는 여전히 active 저장소만 읽는다.
 * 보관·삭제는 최상위 Objective만 받으며 sessions를 함께 이동한다.
 * describe/access/restore에 자식 ID를 주면 소유 Objective을 찾는다. access의 사용 대상 ID는 유지한다.
 */
export interface ObjectiveArchiveCapability {
  /** 실행 소유자가 이동 중 새 입력·기동을 거절할 때 사용하는 Core fence. */
  isTransitioning?(id: string): boolean;
  describe(id: string): ObjectiveDescription | null;
  listArchived(theaterId?: string): ObjectiveArchiveSnapshot;
  archive(id: string): Promise<ObjectiveArchiveReceipt>;
  access(id: string, intent?: ObjectiveAccessIntent): Promise<ObjectiveAccessResult>;
  restore(id: string): Promise<ObjectiveAccessResult>;
  undoArchive(receipt: Pick<ObjectiveArchiveReceipt, "targetId" | "archiveId">): Promise<ObjectiveAccessResult>;
  previewPurge(id: string): ObjectivePurgeConfirmation;
  /** 10초 되돌리기 유예를 시작한다. 기록·데이터는 만료 뒤에만 지우며 서버 재기동은 보류를 취소한다. */
  purge(confirmation: ObjectivePurgeConfirmation): Promise<ObjectivePurgeResult>;
}
