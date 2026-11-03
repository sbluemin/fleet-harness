import { describe, expect, it, vi } from "vitest";

import type { CredentialResolverDeps } from "../../src/transport/credentials.js";
import { createQuotaService } from "../../src/quota/service.js";
import { sanitizeProviderError } from "../../src/quota/windows.js";
import { fetchClaudeUsage } from "../../src/upstream/anthropic/quota.js";

function claudeCredentials(subscriptionType = "max", rateLimitTier?: string): CredentialResolverDeps {
  return {
    platform: "linux",
    homedir: () => "/users/operator",
    env: {},
    readBounded: async () => JSON.stringify({
      claudeAiOauth: {
        accessToken: "secret",
        subscriptionType,
        ...(rateLimitTier === undefined ? {} : { rateLimitTier }),
      },
    }),
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
});

describe("provider response boundaries", () => {
  it("rejects a response whose final URL differs and surfaces no quota data", async () => {
    const response = jsonResponse({ five_hour: { used_percentage: 99 } });
    Object.defineProperty(response, "url", { value: "https://redirected.example/usage" });
    const service = createQuotaService({
      isClaudeConnected: async () => true,
      fetchClaude: () => fetchClaudeUsage({
        credentials: claudeCredentials(),
        fetch: (async () => response) as typeof fetch,
      }),
      fetchCodex: async () => ({ status: "signed_out" }),
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
});

describe("claude plan naming", () => {
  // The fictional name proves the value flows from the profile API rather
  // than a hardcoded label or the login-snapshot derivation ("Max 20x").
  it("surfaces the profile display name verbatim", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).includes("/api/oauth/profile")) {
        return jsonResponse({ organization: { plan_display_name: "Nova" } });
      }
      return jsonResponse({ five_hour: { used_percentage: 12 } });
    }) as typeof fetch;
    const result = await fetchClaudeUsage({
      credentials: claudeCredentials("max", "default_claude_max_20x"),
      fetch: fetchImpl,
    });
    expect(result).toMatchObject({ status: "ok", plan: "Nova" });
  });

  it("falls back to the login-snapshot plan when the profile cannot be read", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).includes("/api/oauth/profile")) {
        return new Response("{}", { status: 500 });
      }
      return jsonResponse({ five_hour: { used_percentage: 12 } });
    }) as typeof fetch;
    const result = await fetchClaudeUsage({
      credentials: claudeCredentials("max", "default_claude_max_20x"),
      fetch: fetchImpl,
    });
    expect(result).toMatchObject({ status: "ok", plan: "Max 20x" });
  });
});
