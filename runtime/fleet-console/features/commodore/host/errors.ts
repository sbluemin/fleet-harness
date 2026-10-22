/** 사령관 저장소의 거절 — 보드 구현에 의존하지 않는 feature 자체 오류다. */
export class CommodoreStoreError extends Error {
  constructor(readonly code: string, message?: string, readonly details?: Record<string, unknown>) {
    super(message ?? code);
    this.name = "CommodoreStoreError";
  }
}
