/**
 * 승인 코어의 공용 계약 — 호스트와 나중에 붙는 화면이 같이 읽는다.
 * 여기에는 파일·프로세스 접근이 없다.
 */

/** 브라우저 SSE 사건. 본문은 `ApprovalSnapshot`. 붙는 순간에도 같은 스냅숏을 한 번 보낸다. */
export const APPROVAL_CHANNEL = "approval:state";

/**
 * 끝난 요청을 한 번만 알린다. 본문은 그 요청의 마지막 `ApprovalRequestView`(`status`·`reason`).
 * 저장하지 않고, 다시 붙을 때 다시 보내지 않는다. 스냅숏에는 대기만 남는다.
 */
export const APPROVAL_NOTICE_CHANNEL = "approval:notice";

/** 사람만 부르는 라우트. 경로는 `/api/v1/` 아래이고, 게이트는 사령관 설명 라우트와 같다. */
export const APPROVAL_LIST_ROUTE = "approvals/list";
export const APPROVAL_ANSWER_ROUTE = "approvals/answer";

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired", "withdrawn"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * 끝난 이유. 스냅숏에는 대기만 남으므로, 답·깨움·`approval:notice` 한 번에서만 보인다.
 * `replaced` 는 같은 대상의 새 제안, `missing` 은 반영할 항목이 없음(승인 시도의 안전장치),
 * `proposer` 는 제안자가 거둠, `item-removed` 는 대상 정보 항목이 승인 전에 지워짐.
 */
export type ApprovalEndReason = "replaced" | "missing" | "proposer" | "item-removed";

/**
 * 사람이 고르는 답.
 * 보류형(디스크)은 `approve` | `reject`.
 * 즉답형(메모리, `expiresAt`)은 `always` | `declined` 만 받는다. 「이번 작업만」은 계약에 없다.
 * 호스트가 끝내는 결말은 답이 아니다. `no_response` 는 expire, `stopped`·`withdrawn`·`authorized` 는 withdraw.
 */
export const APPROVAL_DECISIONS = ["approve", "reject", "always", "declined"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** `disk` 는 재시작 후에도 남는다. `memory` 는 프로세스 안이고 `expiresAt` 이 있다. */
export type ApprovalRetention = "disk" | "memory";

export interface ApprovalRequestView {
  readonly id: string;
  readonly type: string;
  readonly retention: ApprovalRetention;
  readonly status: ApprovalStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 즉답형만. 이 시각이 지나면 `expired`. */
  readonly expiresAt?: number;
  /** 대기 중이 아닌 결말의 사유. 대기 스냅숏에는 없다. */
  readonly reason?: ApprovalEndReason;
  readonly payload: unknown;
}

export interface ApprovalSnapshot {
  readonly requests: readonly ApprovalRequestView[];
}
