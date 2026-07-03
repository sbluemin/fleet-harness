import type { AuthValidationFailureMessageInput } from "./types.js";

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
