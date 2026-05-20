import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAuthValidationError,
  isAuthValidationSuccess,
  validateAnthropicCompatibleApiKey,
} from "../../../src/infra/auth/index.js";

describe("auth validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns success for an accepted Anthropic-compatible ping", async () => {
    const fetchMock = mockFetch(new Response("{}", { status: 200 }));

    const result = await validateAnthropicCompatibleApiKey({
      providerId: "Claude Code with Z.AI GLM",
      apiKey: "valid-token",
      baseUrl: "https://api.z.ai/api/anthropic/",
    });

    expect(result).toEqual({
      providerId: "Claude Code with Z.AI GLM",
      status: "success",
    });
    expect(isAuthValidationSuccess(result)).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("https://api.z.ai/api/anthropic/v1/messages", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        "content-type": "application/json",
        "x-api-key": "valid-token",
      }),
    }));
  });

  it("distinguishes 401 unauthorized", async () => {
    mockFetch(new Response("bad key", { status: 401 }));

    await expect(validateAnthropicCompatibleApiKey(baseRequest())).resolves.toMatchObject({
      status: "unauthorized",
    });
  });

  it("distinguishes 403 forbidden", async () => {
    mockFetch(new Response("forbidden", { status: 403 }));

    await expect(validateAnthropicCompatibleApiKey(baseRequest())).resolves.toMatchObject({
      status: "forbidden",
    });
  });

  it("distinguishes timeout failures", async () => {
    const timeoutError = new DOMException("The operation was aborted.", "AbortError");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeoutError);

    await expect(validateAnthropicCompatibleApiKey(baseRequest())).resolves.toMatchObject({
      status: "timeout",
    });
  });

  it("distinguishes network failures", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network failed"));

    await expect(validateAnthropicCompatibleApiKey(baseRequest())).resolves.toMatchObject({
      status: "network",
      detail: "network failed",
    });
  });

  it("distinguishes server failures", async () => {
    mockFetch(new Response("server error", { status: 503 }));

    await expect(validateAnthropicCompatibleApiKey(baseRequest())).resolves.toMatchObject({
      status: "server",
      detail: "HTTP 503",
    });
  });

  it("creates a plain English validation error message", () => {
    const error = createAuthValidationError({
      providerId: "Claude Code with Moonshot Kimi",
      status: "forbidden",
    });

    expect(error.message).toContain("Auth token is not allowed for this provider");
    expect(error.message).toContain("Claude Code with Moonshot Kimi");
  });
});

function baseRequest() {
  return {
    providerId: "Claude Code with Z.AI GLM",
    apiKey: "token",
    baseUrl: "https://api.z.ai/api/anthropic",
  };
}

function mockFetch(response: Response) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
}
