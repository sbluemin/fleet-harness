export const commonEn = {
  "common.loading": "Loading…",
  "common.retry": "Retry",
  "common.close": "Close",
  "common.cancel": "Cancel",
  "common.refresh": "Refresh",
  "common.dismiss": "Dismiss",
  "common.unknown": "Unknown",
  "common.error.methodNotAllowed": "Method not allowed",
  "common.error.notFound": "Not found",
  "common.error.unauthorized": "Unauthorized",
  "common.error.internal": "Internal server error",
} as const;

export const commonKo: Record<keyof typeof commonEn, string> = {
  "common.loading": "불러오는 중…",
  "common.retry": "다시 시도",
  "common.close": "닫기",
  "common.cancel": "취소",
  "common.refresh": "새로고침",
  "common.dismiss": "닫기",
  "common.unknown": "알 수 없음",
  "common.error.methodNotAllowed": "허용되지 않은 요청 방식입니다",
  "common.error.notFound": "찾을 수 없습니다",
  "common.error.unauthorized": "권한이 없습니다",
  "common.error.internal": "서버 내부 오류가 발생했습니다",
};
