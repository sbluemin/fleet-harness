// auth 공개 배럴 — named export 일원화 (집계 객체 없음)

export { createAuthService, DEFAULT_AUTH_PATH } from "./auth-storage.js";
export {
  createAuthValidationError,
  isAuthValidationSuccess,
  validateAnthropicCompatibleApiKey,
} from "./validation.js";

export type {
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
