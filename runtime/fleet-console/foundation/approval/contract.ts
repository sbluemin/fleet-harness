/**
 * 승인 코어의 공용 계약 — 호스트와 나중에 붙는 화면이 같이 읽는다.
 * 여기에는 파일·프로세스 접근이 없다.
 */

/** 브라우저 SSE 사건. 본문은 `ApprovalSnapshot`. 붙는 순간에도 같은 스냅숏을 한 번 보낸다. */
export const APPROVAL_CHANNEL = "approval:state";

/** 사람만 부르는 라우트. 경로는 `/api/v1/` 아래이고, 게이트는 사령관 설명 라우트와 같다. */
export const APPROVAL_LIST_ROUTE = "approvals/list";
export const APPROVAL_ANSWER_ROUTE = "approvals/answer";

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired", "withdrawn", "stale"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

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
  readonly payload: unknown;
}

export interface ApprovalSnapshot {
  readonly requests: readonly ApprovalRequestView[];
}
