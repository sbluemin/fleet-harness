import * as authProviders from "./auth-providers.js";
import * as authStorage from "./auth-storage.js";
import * as messages from "./messages.js";
import * as migration from "./migration.js";
import * as validation from "./validation.js";
import { CLI_TO_AUTH_PROVIDER_ID, resolveAuthEnv, validateAuthKeyForCli } from "./auth-providers.js";
import { createAuthService, DEFAULT_AUTH_PATH } from "./auth-storage.js";
import {
  AUTH_LIST_EMPTY_MESSAGE,
  AUTH_COMMAND_CANCELLED_MESSAGE,
  AUTH_LOGIN_PROVIDER_PROMPT_MESSAGE,
  AUTH_LOGIN_SECRET_PROMPT_MESSAGE,
  AUTH_LOGOUT_PROVIDER_PROMPT_MESSAGE,
  formatAuthLoginSuccessMessage,
  formatAuthLogoutSuccessMessage,
  formatAuthMigrationNotice,
  formatAuthValidationFailureMessage,
  formatMissingAuthKeyMessage,
} from "./messages.js";
import {
  CURRENT_AUTH_PATH,
  LEGACY_AUTH_PATH,
  mergeAuthStoresNoOverwrite,
  migrateLegacyAuthStore,
} from "./migration.js";
import {
  createAuthValidationError,
  isAuthValidationSuccess,
  validateAnthropicCompatibleApiKey,
} from "./validation.js";

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
  formatAuthMigrationNotice,
  formatAuthValidationFailureMessage,
  formatMissingAuthKeyMessage,
} from "./messages.js";
export {
  CURRENT_AUTH_PATH,
  LEGACY_AUTH_PATH,
  mergeAuthStoresNoOverwrite,
  migrateLegacyAuthStore,
} from "./migration.js";
export {
  createAuthValidationError,
  isAuthValidationSuccess,
  validateAnthropicCompatibleApiKey,
} from "./validation.js";

export type {
  AuthMessageProviderRef,
  AuthMigrationMergeResult,
  AuthMigrationNoticeInput,
  AuthMigrationResult,
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

export const auth = {
  authProviders,
  authStorage,
  messages,
  migration,
  validation,
  AUTH_LIST_EMPTY_MESSAGE,
  AUTH_COMMAND_CANCELLED_MESSAGE,
  AUTH_LOGIN_PROVIDER_PROMPT_MESSAGE,
  AUTH_LOGIN_SECRET_PROMPT_MESSAGE,
  AUTH_LOGOUT_PROVIDER_PROMPT_MESSAGE,
  CURRENT_AUTH_PATH,
  DEFAULT_AUTH_PATH,
  LEGACY_AUTH_PATH,
  create: createAuthService,
  createAuthService,
  CLI_TO_AUTH_PROVIDER_ID,
  createAuthValidationError,
  formatAuthLoginSuccessMessage,
  formatAuthLogoutSuccessMessage,
  formatAuthMigrationNotice,
  formatAuthValidationFailureMessage,
  formatMissingAuthKeyMessage,
  isAuthValidationSuccess,
  mergeAuthStoresNoOverwrite,
  migrateLegacyAuthStore,
  resolveAuthEnv,
  validateAuthKeyForCli,
  validateAnthropicCompatibleApiKey,
};
