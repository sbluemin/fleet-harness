import { describe, expect, it, vi } from "vitest";

import type { CredentialResolverDeps } from "../../src/transport/credentials.js";
import { fetchCodexUsage, parseCodexUsage, parseResetCredits } from "../../src/codex/quota.js";

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function claudeCredentials(subscriptionType = "max"): CredentialResolverDeps {
  return {
    platform: "linux",
    homedir: () => "/users/operator",
    env: {},
    readBounded: async () => JSON.stringify({
      claudeAiOauth: { accessToken: "secret", subscriptionType },
    }),
    execFile: async () => "",
  };
}


describe("Codex response parsing", () => {
  it("classifies Codex windows by duration and preserves primary/secondary fallback", () => {
    // Codex는 limit_window_seconds로 기간을 직접 선언하므로 period는 upstream이다.
    expect(parseCodexUsage({
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 9.5, limit_window_seconds: 300 * 60, reset_at: 2_000_000_000 },
        secondary_window: { used_percent: -3, limit_window_seconds: 10_080 * 60, reset_at: 2_000_000_000_000 },
      },
    })).toEqual({
      plan: "Pro",
      windows: [
        {
          id: "session",
          usedPercent: 10,
          resetsAt: 2_000_000_000_000,
          period: {
            durationMs: 18_000_000,
            durationBasis: "upstream",
            startsAt: 2_000_000_000_000 - 18_000_000,
            startsAtBasis: "derived",
          },
        },
        {
          id: "weekly",
          usedPercent: 0,
          resetsAt: 2_000_000_000_000,
          period: {
            durationMs: 604_800_000,
            durationBasis: "upstream",
            startsAt: 2_000_000_000_000 - 604_800_000,
            startsAtBasis: "derived",
          },
        },
      ],
    });
    expect(parseCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 1, limit_window_seconds: 1 },
        secondary_window: { used_percent: 2, limit_window_seconds: 2 },
      },
    }).windows.map((row) => row.id)).toEqual(["session", "weekly"]);
  });

  it("validates reset credits and chooses the earliest available expiry", () => {
    expect(parseResetCredits({
      available_count: 3,
      credits: [
        { status: "available", expires_at: 2_100_000_000 },
        { status: "consumed", expires_at: 1_000_000_000 },
        { status: "available", expires_at: 2_000_000_000 },
      ],
    })).toEqual({ available: 3, nextExpiresAt: 2_000_000_000_000 });
    expect(parseResetCredits({ available_count: -1 })).toBeUndefined();
  });
});

describe("Codex provider requests", () => {
  it("uses GET-only wham endpoints and never calls a consume endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(
        String(url).endsWith("/usage")
          ? { rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18_000 } } }
          : { available_count: 0, credits: [] },
      ), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const credentials: CredentialResolverDeps = {
      platform: "win32",
      homedir: () => "C:\\Users\\operator",
      env: { CODEX_HOME: "C:\\codex" },
      readBounded: async () => JSON.stringify({ tokens: { access_token: "secret", account_id: "acct" } }),
      execFile: async () => { throw new Error("must not spawn"); },
    };
    const result = await fetchCodexUsage({ credentials, fetch: fetchImpl as typeof fetch, now: () => 42 });
    expect(result.status).toBe("ok");
    expect(calls.map((call) => call.url)).toEqual([
      "https://chatgpt.com/backend-api/wham/usage",
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
    ]);
    expect(calls.every((call) => call.init?.method === "GET")).toBe(true);
    expect(calls.every((call) => call.init?.redirect === "error")).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/secret|acct|access_token/);
  });

  it("keeps the usage snapshot when the credits endpoint fails", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/usage")) {
        return new Response(JSON.stringify(
          { rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18_000 } } },
        ), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    });
    const credentials: CredentialResolverDeps = {
      platform: "linux",
      homedir: () => "/home/operator",
      env: {},
      readBounded: async () => JSON.stringify({ tokens: { access_token: "secret" } }),
      execFile: async () => { throw new Error("must not spawn"); },
    };
    const result = await fetchCodexUsage({ credentials, fetch: fetchImpl as typeof fetch, now: () => 42 });
    expect(result.status).toBe("ok");
    expect(result.windows?.map((row) => row.id)).toEqual(["session"]);
    expect("credits" in result).toBe(false);
  });

});
