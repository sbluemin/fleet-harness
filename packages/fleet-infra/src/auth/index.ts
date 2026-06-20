// auth 공개 배럴 — named export 일원화 (집계 객체 없음)

export { createAuthService, DEFAULT_AUTH_PATH } from "./auth-storage.js";
export {
  CLI_TO_AUTH_PROVIDER_ID,
  resolveAuthEnv,
  validateAuthKeyForCli,
} from "./auth-providers.js";
export {
  AUTH_LIST_EMPTY_MESSAGE,
  AUTH_COMMAND_CANCELLED_MESSAGE,
  AUTH_LOGIN_PROVIDER_PROMPT_MESSAGE,
  AUTH_LOGIN_SECRET_PROMPT_MESSAGE,
  AUTH_LOGOUT_PROVIDER_PROMPT_MESSAGE,
  formatAuthLoginSuccessMessage,
  formatAuthLogoutSuccessMessage,
  formatAuthValidationFailureMessage,
} from "./messages.js";
export {
  createAuthValidationError,
  isAuthValidationSuccess,
  validateAnthropicCompatibleApiKey,
} from "./validation.js";

export type {
  AuthMessageProviderRef,
  AuthService,
  AuthStorageData,
  AuthStorageEntry,
  AuthValidationFailureMessageInput,
  AuthValidationFailureResult,
  AuthValidationFailureStatus,
  AuthValidationRequest,
  AuthValidationResult,
  AuthValidationStatus,
  CreateAuthServiceDeps,
} from "./types.js";
