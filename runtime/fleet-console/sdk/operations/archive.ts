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
}

/** 확인한 대상 집합과 revision을 그대로 확정 요청에 보낸다. */
export interface OperationPurgeConfirmation {
  readonly targetId: string;
  readonly operationIds: readonly string[];
  readonly revision: number;
}

export interface OperationPurgeResult {
  readonly operationIds: readonly string[];
  readonly revision: number;
}

export interface OperationArchiveChangedEvent {
  readonly revision: number;
  readonly total: number;
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
  | "operation_not_archived" | "restore_parent_missing" | "invalid_archive_request";

/** Host는 이 capability를 구현한다. get/list는 여전히 active 저장소만 읽는다. */
export interface OperationArchiveCapability {
  describe(id: string): OperationDescription | null;
  listArchived(theaterId?: string): OperationArchiveSnapshot;
  archive(id: string): Promise<OperationArchiveReceipt>;
  access(id: string, intent?: OperationAccessIntent): Promise<OperationAccessResult>;
  restore(id: string): Promise<OperationAccessResult>;
  undoArchive(receipt: Pick<OperationArchiveReceipt, "targetId" | "archiveId">): Promise<OperationAccessResult>;
  previewPurge(id: string): OperationPurgeConfirmation;
  purge(confirmation: OperationPurgeConfirmation): Promise<OperationPurgeResult>;
}
