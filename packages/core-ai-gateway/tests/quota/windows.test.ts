import { describe, expect, it, vi } from "vitest";

import type { CredentialResolverDeps } from "../../src/transport/credentials.js";
import { createQuotaService } from "../../src/quota/service.js";
import { sanitizeProviderError } from "../../src/quota/windows.js";
import { fetchClaudeUsage } from "../../src/upstream/anthropic/quota.js";

function claudeCredentials(subscriptionType = "max"): CredentialResolverDeps {
  return {
    platform: "linux",
    homedir: () => "/users/operator",
    env: {},
    readBounded: async () => JSON.stringify({ claudeAiOauth: { accessToken: "secret", subscriptionType } }),
    execFile: async () => "",
  };
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}


describe("provider error sanitization", () => {
  it("classifies a TLS certificate verification failure", () => {
    const error = new TypeError("fetch failed");
    Object.defineProperty(error, "cause", { value: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } });
    expect(sanitizeProviderError(error)).toBe("Certificate verification failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)");
  });

  it("classifies a nested TLS certificate verification failure", () => {
    const error = new TypeError("fetch failed");
    Object.defineProperty(error, "cause", {
      value: { cause: { code: "CERT_HAS_EXPIRED" } },
    });
    expect(sanitizeProviderError(error)).toBe("Certificate verification failed (CERT_HAS_EXPIRED)");
  });

  it("keeps non-TLS causes generic", () => {
    const error = new TypeError("fetch failed");
    Object.defineProperty(error, "cause", { value: { code: "ECONNREFUSED" } });
    expect(sanitizeProviderError(error)).toBe("Provider request failed");
  });
});

describe("provider response boundaries", () => {
  it("rejects a response whose final URL differs and surfaces no quota data", async () => {
    const response = jsonResponse({ five_hour: { used_percentage: 99 } });
    Object.defineProperty(response, "url", { value: "https://redirected.example/usage" });
    const service = createQuotaService({
      isClaudeConnected: async () => true,
      fetchKimi: async () => ({ status: "signed_out" }),
      fetchClaude: () => fetchClaudeUsage({
        credentials: claudeCredentials(),
        fetch: (async () => response) as typeof fetch,
      }),
      fetchCodex: async () => ({ status: "signed_out" }),
      isCursorConnected: async () => false,
      fetchCursor: async () => ({ status: "signed_out" }),
      fetchOpencode: async () => ({ status: "signed_out" }),
    });
    const result = (await service.getSummary()).providers.claude;
    expect(result.status).not.toBe("ok");
    expect(result).not.toHaveProperty("windows");
    expect(result.message).toBe("Provider request failed");
  });

  it("rejects a declared oversized response without leaking its body", async () => {
    const body = "sensitive-provider-body";
    const response = new Response(body, {
      status: 200,
      headers: { "content-length": "262145" },
    });
    let caught: unknown;
    try {
      await fetchClaudeUsage({
        credentials: claudeCredentials(),
        fetch: (async () => response) as typeof fetch,
      });
    } catch (error) {
      caught = error;
    }
    expect(sanitizeProviderError(caught)).toBe("Provider response too large");
    expect(sanitizeProviderError(caught)).not.toContain(body);
  });

  it("aborts a streamed response after the bounded byte limit", async () => {
    const secret = "private-stream-content";
    const chunk = new TextEncoder().encode(secret.repeat(12_000));
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    }), { status: 200 });
    let caught: unknown;
    try {
      await fetchClaudeUsage({
        credentials: claudeCredentials(),
        fetch: (async () => response) as typeof fetch,
      });
    } catch (error) {
      caught = error;
    }
    expect(sanitizeProviderError(caught)).toBe("Provider response too large");
    expect(sanitizeProviderError(caught)).not.toContain(secret);
  });
});
