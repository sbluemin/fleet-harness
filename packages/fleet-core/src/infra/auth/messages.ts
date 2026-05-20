import type {
  AuthMessageProviderRef,
  AuthMigrationNoticeInput,
  AuthValidationFailureMessageInput,
} from "./types.js";

export const AUTH_LIST_EMPTY_MESSAGE = "No auth tokens are registered. Run `fleet auth login` to add one.";
export const AUTH_LOGIN_PROVIDER_PROMPT_MESSAGE = "Select a Claude-family provider to register.";
export const AUTH_LOGIN_SECRET_PROMPT_MESSAGE = "Enter the auth token.";
export const AUTH_COMMAND_CANCELLED_MESSAGE = "Auth command cancelled.";
export const AUTH_LOGOUT_PROVIDER_PROMPT_MESSAGE = "Select a Claude-family provider to remove.";

export function formatAuthMigrationNotice(input: AuthMigrationNoticeInput): string {
  const skipped = input.skippedCount > 0
    ? ` Skipped ${input.skippedCount} existing legacy entries to keep current auth entries unchanged.`
    : "";
  return `Migrated auth storage to ~/.fleet/auth.json. Merged ${input.migratedCount} auth entries.${skipped}`;
}

export function formatMissingAuthKeyMessage(input: AuthMessageProviderRef): string {
  const cliHint = input.cli ? `cli '${input.cli}'` : "selected CLI";
  return `Auth token not found for ${cliHint} (providerId: '${input.providerId}'). Run \`fleet auth login\` to register one.`;
}

export function formatAuthValidationFailureMessage(input: AuthValidationFailureMessageInput): string {
  const detail = input.detail ? ` Detail: ${input.detail}` : "";
  if (input.status === "unauthorized") {
    return `Auth token was rejected (providerId: '${input.providerId}'). Check the token and try again.${detail}`;
  }
  if (input.status === "forbidden") {
    return `Auth token is not allowed for this provider (providerId: '${input.providerId}'). Check the token permissions.${detail}`;
  }
  if (input.status === "timeout") {
    return `Auth token validation timed out (providerId: '${input.providerId}'). Check the connection and try again.${detail}`;
  }
  if (input.status === "network") {
    return `Auth token validation failed due to a network error (providerId: '${input.providerId}'). Check the connection and try again.${detail}`;
  }
  if (input.status === "server") {
    return `Auth token validation failed because the provider returned an error (providerId: '${input.providerId}'). Try again later.${detail}`;
  }
  return `Auth token validation failed (providerId: '${input.providerId}'). Check the token and try again.${detail}`;
}

export function formatAuthLoginSuccessMessage(providerId: string): string {
  return `Auth token registered (providerId: '${providerId}').`;
}

export function formatAuthLogoutSuccessMessage(providerId: string): string {
  return `Auth token removed (providerId: '${providerId}').`;
}
