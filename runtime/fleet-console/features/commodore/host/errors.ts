/** 사령관 저장소의 거절 — 보드 구현에 의존하지 않는 feature 자체 오류다. */
export class CommodoreStoreError extends Error {
  constructor(readonly code: string, message?: string, readonly details?: Record<string, unknown>) {
    super(message ?? code);
    this.name = "CommodoreStoreError";
  }
}

/**
 * 오류 코드로 내보낼 수 있는 모양인가 — 한 낱말 소문자·밑줄 64자 이하만 그대로 쓰고, 아니면 그 경계의 일반 코드로 접는다.
 * 라우트의 HTTP 오류 본문과 도구 거절, 감독자의 실패 분류가 같은 규칙을 쓴다.
 */
export function safeErrorCode(value: string, fallback = "commodore_failed"): string {
  return /^[a-z_]{1,64}$/.test(value) ? value : fallback;
}

/** TaskForce 저장소의 거절 — 보드 구현에 의존하지 않는 feature 자체 오류다. */
export class TaskforceStoreError extends Error {
  constructor(readonly code: string, message?: string, readonly details?: Record<string, unknown>) {
    super(message ?? code);
    this.name = "TaskforceStoreError";
  }
}
