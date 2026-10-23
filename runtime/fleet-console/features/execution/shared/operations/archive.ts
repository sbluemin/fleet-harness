import type { OperationNode } from "./types.js";

/** 보관은 별도 저장소에 있다. 기본 Operation 목록과 get의 의미는 바꾸지 않는다. */
export const OPERATION_ARCHIVE_PATH = "/api/v1/operations/archive";
export const OPERATION_ARCHIVE_CHANGED_EVENT = "operation:archive-changed";
export const OPERATION_ARCHIVED_EVENT = "operation:archived";
export const OPERATION_PURGED_EVENT = "operation:purged";
export const OPERATION_CLUSTER_CHANGED_EVENT = "operation:cluster-changed";

export type OperationAccessIntent = "ensure-active" | "open" | "activate" | "resume";

export interface OperationDescription {
  readonly operation: OperationNode;
  readonly location: "active" | "archived";
  readonly rootOperationId: string;
  readonly archivedAt: number | null;
}

export interface OperationArchiveReceipt {
  readonly archiveId: string;
  readonly targetId: string;
  readonly rootOperationId: string;
  readonly operationIds: readonly string[];
  readonly archivedAt: number;
  readonly revision: number;
}

export interface OperationAccessResult {
  readonly targetId: string;
  readonly rootOperationId: string;
  readonly restoredIds: readonly string[];
  /** 브라우저 응답에서는 일반 Operation DTO와 동일하게 정화한다. */
  readonly operations: readonly OperationNode[];
}

export interface OperationArchiveSnapshot {
  readonly revision: number;
  readonly total: number;
  readonly entries: readonly OperationDescription[];
  readonly pendingPurges?: readonly OperationPendingPurge[];
}

/** 유예 중에는 원본 보관 기록을 그대로 둔다. 보류만 서버 메모리에 있으며 재기동은 이를 취소한다. */
export interface OperationPendingPurge {
  readonly purgeId: string;
  readonly operationIds: readonly string[];
  readonly purgeAt: number;
}

export const OPERATION_PURGE_GRACE_MS = 10_000;

/** 확인한 대상 집합과 revision을 그대로 확정 요청에 보낸다. */
export interface OperationPurgeConfirmation {
  readonly targetId: string;
  readonly operationIds: readonly string[];
  readonly revision: number;
}

export interface OperationPurgeResult {
  readonly operationIds: readonly string[];
  readonly revision: number;
  readonly purgeId?: string;
  readonly purgeAt?: number;
}

export interface OperationArchiveRestoreResult {
  readonly operations: readonly OperationNode[];
  readonly revision: number;
}

export interface OperationArchiveChangedEvent {
  readonly revision: number;
  readonly total: number;
  /** total은 전체 수이며, 입구는 활성 Theater의 수만 읽는다. */
  readonly totalsByTheater?: Readonly<Record<string, number>>;
}

export interface OperationClusterChangedEvent {
  readonly removedIds: readonly string[];
  readonly operations: readonly OperationNode[];
}

/** 공개 lifecycle 사건에는 경로·원본 payload·확장 기능별 상태를 넣지 않는다. */
export interface OperationPurgedEvent {
  readonly eventId: string;
  readonly operationId: string;
  readonly theaterId: string;
  readonly pluginId: string | null;
  readonly type: string;
}

export type OperationArchiveErrorCode =
  | "unknown_operation" | "operation_busy" | "pending_deletion"
  | "archive_not_found" | "archive_revision_conflict" | "archive_undo_conflict"
  | "archive_cluster_conflict" | "archive_recovery_required" | "archive_stop_failed"
  | "operation_not_archived" | "restore_parent_missing" | "invalid_archive_request" | "child_session_not_closable";

/**
 * Host는 이 capability를 구현한다. get/list는 여전히 active 저장소만 읽는다.
 * 보관·삭제는 최상위 Operation만 받으며 childSessions를 함께 이동한다.
 * describe/access/restore에 자식 ID를 주면 소유 Operation을 찾는다. access의 사용 대상 ID는 유지한다.
 */
export interface OperationArchiveCapability {
  /** 실행 소유자가 이동 중 새 입력·기동을 거절할 때 사용하는 Core fence. */
  isTransitioning?(id: string): boolean;
  describe(id: string): OperationDescription | null;
  listArchived(theaterId?: string): OperationArchiveSnapshot;
  archive(id: string): Promise<OperationArchiveReceipt>;
  access(id: string, intent?: OperationAccessIntent): Promise<OperationAccessResult>;
  restore(id: string): Promise<OperationAccessResult>;
  undoArchive(receipt: Pick<OperationArchiveReceipt, "targetId" | "archiveId">): Promise<OperationAccessResult>;
  previewPurge(id: string): OperationPurgeConfirmation;
  /** 10초 되돌리기 유예를 시작한다. 기록·데이터는 만료 뒤에만 지우며 서버 재기동은 보류를 취소한다. */
  purge(confirmation: OperationPurgeConfirmation): Promise<OperationPurgeResult>;
}
