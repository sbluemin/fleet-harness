import type {
  AuthMessageProviderRef,
  AuthMigrationNoticeInput,
  AuthValidationFailureMessageInput,
} from "./types.js";

export const AUTH_LIST_EMPTY_MESSAGE = "함대 인증 저장소가 비어 있습니다. fleet auth login으로 인증 토큰을 등록하세요.";
export const AUTH_LOGIN_PROVIDER_PROMPT_MESSAGE = "인증할 Claude-family 기함을 선택하세요.";
export const AUTH_LOGIN_SECRET_PROMPT_MESSAGE = "기함 인증 토큰을 입력하세요.";
export const AUTH_COMMAND_CANCELLED_MESSAGE = "기함 인증 작전을 취소했습니다.";
export const AUTH_LOGOUT_PROVIDER_PROMPT_MESSAGE = "인증 해제할 Claude-family 기함을 선택하세요.";

export function formatAuthMigrationNotice(input: AuthMigrationNoticeInput): string {
  const skipped = input.skippedCount > 0
    ? ` 기존 기함 저장소의 ${input.skippedCount}개 항목은 새 저장소 항목을 보존하기 위해 건너뛰었습니다.`
    : "";
  return `함대 인증 저장소를 ~/.fleet/auth.json으로 이전했습니다. ${input.migratedCount}개 인증 항목을 병합했습니다.${skipped}`;
}

export function formatMissingAuthKeyMessage(input: AuthMessageProviderRef): string {
  const cliHint = input.cli ? `cli '${input.cli}'` : "선택한 CLI";
  return `함대 인증 저장소(~/.fleet/auth.json)에서 ${cliHint}의 인증 토큰을 찾을 수 없습니다 (providerId: '${input.providerId}'). fleet auth login으로 인증 토큰을 등록하세요.`;
}

export function formatAuthValidationFailureMessage(input: AuthValidationFailureMessageInput): string {
  const detail = input.detail ? ` 세부 정보: ${input.detail}` : "";
  if (input.status === "unauthorized") {
    return `기함 인증이 거부되었습니다 (providerId: '${input.providerId}'). 인증 토큰을 다시 확인하세요.${detail}`;
  }
  if (input.status === "forbidden") {
    return `기함 인증 권한이 부족합니다 (providerId: '${input.providerId}'). 해당 토큰의 접근 권한을 확인하세요.${detail}`;
  }
  if (input.status === "timeout") {
    return `기함 인증 검증이 시간 내에 응답하지 않았습니다 (providerId: '${input.providerId}'). 잠시 후 다시 시도하세요.${detail}`;
  }
  if (input.status === "network") {
    return `기함 인증 검증 중 네트워크 항로가 끊겼습니다 (providerId: '${input.providerId}'). 연결 상태를 확인하세요.${detail}`;
  }
  if (input.status === "server") {
    return `기함 인증 검증 중 원격 관제소 오류가 발생했습니다 (providerId: '${input.providerId}'). 잠시 후 다시 시도하세요.${detail}`;
  }
  return `기함 인증 검증에 실패했습니다 (providerId: '${input.providerId}'). 인증 토큰을 확인하세요.${detail}`;
}

export function formatAuthLoginSuccessMessage(providerId: string): string {
  return `기함 인증 토큰을 등록했습니다 (providerId: '${providerId}').`;
}

export function formatAuthLogoutSuccessMessage(providerId: string): string {
  return `기함 인증 토큰을 제거했습니다 (providerId: '${providerId}').`;
}
