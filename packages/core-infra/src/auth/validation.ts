import type {
  AuthValidationFailureResult,
  AuthValidationRequest,
  AuthValidationResult,
} from "./types.js";

import { formatAuthValidationFailureMessage } from "./auth-storage.js";

// Auth validation issues a real 1-token generation probe. Upstream TTFB for a
// live model often exceeds a few seconds, so a short budget falsely times out
// valid keys (observed on OpenCode Go / minimax-m3) before they can be stored.
export const DEFAULT_AUTH_VALIDATION_TIMEOUT_MS = 20_000;

export async function validateAnthropicCompatibleApiKey(
  request: AuthValidationRequest,
): Promise<AuthValidationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, request.timeoutMs ?? DEFAULT_AUTH_VALIDATION_TIMEOUT_MS);

  try {
    const response = await fetch(buildMessagesUrl(request.baseUrl), {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": request.apiKey,
      },
      body: JSON.stringify({
        model: request.model ?? "claude-3-5-haiku-20241022",
        max_tokens: 1,
        messages: [
          {
            role: "user",
            content: "ping",
          },
        ],
      }),
      signal: controller.signal,
    });
    // Status alone decides validity; drop the body so a slow token stream cannot
    // keep the socket (or the provider generation) alive after we already know.
    // cancel() can reject after a dropped connection — absorb so cleanup never
    // overrides the status we already have or becomes an unhandled rejection.
    if (response.body) void response.body.cancel().catch(() => undefined);

    if (response.ok) {
      return { providerId: request.providerId, status: "success" };
    }
    if (response.status === 401) {
      return { providerId: request.providerId, status: "unauthorized" };
    }
    if (response.status === 403) {
      return { providerId: request.providerId, status: "forbidden" };
    }
    if (response.status >= 500) {
      return {
        providerId: request.providerId,
        status: "server",
        detail: `HTTP ${response.status}`,
      };
    }
    return {
      providerId: request.providerId,
      status: "unknown",
      detail: `HTTP ${response.status}`,
    };
  } catch (error) {
    if (isAbortError(error)) {
      return { providerId: request.providerId, status: "timeout" };
    }
    return {
      providerId: request.providerId,
      status: "network",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function isAuthValidationSuccess(
  result: AuthValidationResult,
): result is AuthValidationResult & { status: "success" } {
  return result.status === "success";
}

export function createAuthValidationError(result: AuthValidationFailureResult): Error {
  return new Error(formatAuthValidationFailureMessage(result));
}

function buildMessagesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
}

function isAbortError(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  return error instanceof Error && error.name === "AbortError";
}
