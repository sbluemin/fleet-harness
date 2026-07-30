import { describe, expect, it, vi } from "vitest";

import {
  fetchClaudeUsage,
  fetchCodexUsage,
  fetchCursorUsage,
  parseClaudeUsage,
  parseCodexUsage,
  parseCursorUsage,
  parseResetCredits,
  sanitizeProviderError,
} from "../server/providers.js";
import type { CredentialResolverDeps } from "../server/credentials.js";
import { createQuotaService } from "../server/service.js";

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

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("provider response parsing", () => {
  it("parses Cursor numeric-string epochs, measured percentages, and cycle length", () => {
    expect(parseCursorUsage({
      billingCycleStart: "1783180030000",
      billingCycleEnd: "1785858430000",
      planUsage: {
        totalSpend: 34_799,
        limit: 7_000,
        totalPercentUsed: 38.24065934065934,
        autoPercentUsed: 36.2275,
        apiPercentUsed: 52.88181818181818,
      },
      enabled: true,
    })).toEqual({
      status: "ok",
      cycleDays: 31,
      windows: [
        { id: "cycle", usedPercent: 38, resetsAt: 1_785_858_430_000 },
        { id: "cycle", label: "Auto", usedPercent: 36, resetsAt: 1_785_858_430_000 },
        { id: "cycle", label: "API", usedPercent: 53, resetsAt: 1_785_858_430_000 },
      ],
    });
  });

  it("never derives Cursor percentages from cents and identifies no-subscription states", () => {
    expect(parseCursorUsage({
      planUsage: { totalSpend: 34_799, limit: 7_000, autoPercentUsed: 12 },
      enabled: true,
    })).toEqual({
      status: "ok",
      windows: [{ id: "cycle", label: "Auto", usedPercent: 12 }],
    });
    expect(parseCursorUsage({ enabled: false, planUsage: { totalPercentUsed: 10 } }))
      .toEqual({ status: "no_subscription" });
    expect(parseCursorUsage({ enabled: true })).toEqual({ status: "no_subscription" });
  });

  it("maps Claude session, weekly, and scoped model windows", () => {
    expect(parseClaudeUsage({
      five_hour: { used_percentage: 12.6, resets_at: "2026-08-01T00:00:00Z" },
      seven_day: { utilization: 0.714, resets_at: 2_000_000_000 },
      limits: [{
        kind: "weekly_scoped",
        scope: { model: { display_name: "Sonnet" } },
        utilization: 120,
        resets_at: 2_000_000_000_000,
      }],
    }).windows).toEqual([
      { id: "session", usedPercent: 13, resetsAt: Date.parse("2026-08-01T00:00:00Z") },
      { id: "weekly", usedPercent: 1, resetsAt: 2_000_000_000_000 },
      { id: "model", label: "Sonnet", usedPercent: 100, resetsAt: 2_000_000_000_000 },
    ]);
  });

  it("uses the legacy Fable row only when no scoped model rows exist", () => {
    expect(parseClaudeUsage({ seven_day_fable: { utilization: 0.1 } }).windows)
      .toEqual([{ id: "model", label: "Fable", usedPercent: 0 }]);
    expect(parseClaudeUsage({
      fable_weekly: {},
      seven_day_fable: { percent: 55 },
    }).windows).toEqual([{ id: "model", label: "Fable", usedPercent: 55 }]);
  });

  it("uses the first finite Claude percentage field without magnitude guessing", () => {
    expect(parseClaudeUsage({
      limits: [
        { kind: "weekly_scoped", percent: 60 },
        { kind: "weekly_scoped", percent: 10, used_percentage: 20, utilization: 30 },
        { kind: "weekly_scoped", percent: null, used_percentage: 20 },
        { kind: "weekly_scoped", percent: Number.NaN, used_percentage: "x", utilization: 44 },
        { kind: "weekly_scoped" },
        { kind: "weekly_scoped", utilization: 86 },
        { kind: "weekly_scoped", utilization: 0.5 },
      ],
    }).windows.map((row) => row.usedPercent)).toEqual([60, 10, 20, 44, 86, 1]);
  });

  it("uses session and weekly limits only as fallbacks to named fields", () => {
    expect(parseClaudeUsage({
      limits: [
        { kind: "session", percent: 5 },
        { kind: "weekly_all", percent: 9 },
      ],
    }).windows).toEqual([
      { id: "session", usedPercent: 5 },
      { id: "weekly", usedPercent: 9 },
    ]);
    expect(parseClaudeUsage({
      five_hour: { percent: 17 },
      limits: [
        { kind: "session", percent: 5 },
        { kind: "weekly_all", percent: 9 },
      ],
    }).windows).toEqual([
      { id: "session", usedPercent: 17 },
      { id: "weekly", usedPercent: 9 },
    ]);
    expect(parseClaudeUsage({
      five_hour: { resets_at: 2_000_000_000 },
      limits: [{ kind: "session", percent: 67 }],
    }).windows).toEqual([{ id: "session", usedPercent: 67 }]);
    expect(parseClaudeUsage({
      five_hour: { percent: 0 },
      limits: [{ kind: "session", percent: 67 }],
    }).windows).toEqual([{ id: "session", usedPercent: 0 }]);
  });

  it("bounds untrusted Claude limits and reset-credit collections", () => {
    const limits = Array.from({ length: 100_000 }, (_, index) => ({
      kind: "weekly_scoped",
      scope: { model: { display_name: `Model ${index}` } },
      utilization: 0.1,
    }));
    expect(parseClaudeUsage({ limits }).windows).toHaveLength(8);

    const credits = Array.from({ length: 150_000 }, (_, index) => ({
      status: "available",
      expires_at: index === 200 ? 2_000_000_000 : 2_100_000_000 + index,
    }));
    expect(() => parseResetCredits({ available_count: 150_000, credits })).not.toThrow();
    expect(parseResetCredits({ available_count: 150_000, credits }))
      .toEqual({ available: 150_000, nextExpiresAt: 2_000_000_000_000 });
  });

  it("shape-validates plans and model labels without an enumerated allowlist", async () => {
    expect(parseCodexUsage({ plan_type: "pro" }).plan).toBe("Pro");
    expect(parseClaudeUsage({
      limits: [{
        kind: "weekly_scoped",
        scope: { model: { display_name: "Sonnet 4.5" } },
        utilization: 0.1,
      }],
    }).windows[0]?.label).toBe("Sonnet 4.5");
    expect(parseClaudeUsage({
      limits: [{
        kind: "weekly_scoped",
        scope: { model: { display_name: "x".repeat(300) } },
        utilization: 0.1,
      }],
    }).windows[0]?.label).toBe("Model");

    const valid = await fetchClaudeUsage({
      credentials: claudeCredentials("max"),
      fetch: (async () => jsonResponse({})) as typeof fetch,
      now: () => 1,
    });
    expect(valid.status === "ok" ? valid.plan : undefined).toBe("Max");
    const invalid = await fetchClaudeUsage({
      credentials: claudeCredentials("TOKEN-IN-SUBSCRIPTION-TYPE"),
      fetch: (async () => jsonResponse({})) as typeof fetch,
      now: () => 1,
    });
    expect(invalid.status === "ok" ? invalid.plan : undefined).toBeUndefined();
  });

  it("rejects credential-shaped plans and model labels while preserving legitimate names", () => {
    const rejected = [
      "Bearer abc123",
      "BEARER abc123",
      "550e8400-e29b-41d4-a716-446655440000",
      "e30.e30.sig",
    ];
    for (const value of rejected) {
      expect(parseCodexUsage({ plan_type: value }).plan, value).toBeUndefined();
      expect(parseClaudeUsage({
        limits: [{
          kind: "weekly_scoped",
          percent: 1,
          scope: { model: { display_name: value } },
        }],
      }).windows[0]?.label, value).toBe("Model");
    }

    for (const value of ["max", "pro", "Sonnet 4.5", "Fable", "Max 20x"]) {
      expect(parseCodexUsage({ plan_type: value }).plan, value)
        .toBe(`${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`);
      expect(parseClaudeUsage({
        limits: [{
          kind: "weekly_scoped",
          percent: 1,
          scope: { model: { display_name: value } },
        }],
      }).windows[0]?.label, value).toBe(value);
    }
  });

  it("classifies Codex windows by duration and preserves primary/secondary fallback", () => {
    expect(parseCodexUsage({
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 9.5, limit_window_seconds: 300 * 60, reset_at: 2_000_000_000 },
        secondary_window: { used_percent: -3, limit_window_seconds: 10_080 * 60, reset_at: 2_000_000_000_000 },
      },
    })).toEqual({
      plan: "Pro",
      windows: [
        { id: "session", usedPercent: 10, resetsAt: 2_000_000_000_000 },
        { id: "weekly", usedPercent: 0, resetsAt: 2_000_000_000_000 },
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

describe("Cursor provider requests", () => {
  it("POSTs exact empty JSON to only the measured endpoints and returns a token-free DTO", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse(String(url).endsWith("/GetPlanInfo")
        ? { planName: "Pro+" }
        : {
            billingCycleStart: "1783180030000",
            billingCycleEnd: "1785858430000",
            planUsage: { totalPercentUsed: 38.24065934065934 },
            enabled: true,
          });
    });
    const credentials: CredentialResolverDeps = {
      platform: "linux",
      homedir: () => "/home/operator",
      env: {},
      readBounded: async () => JSON.stringify({ accessToken: "cursor-secret" }),
      execFile: async () => { throw new Error("must not spawn"); },
    };
    const result = await fetchCursorUsage({ credentials, fetch: fetchImpl as typeof fetch, now: () => 42 });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
      "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo",
    ]);
    expect(calls.every((call) => call.init?.method === "POST")).toBe(true);
    expect(calls.every((call) => call.init?.body === "{}")).toBe(true);
    expect(calls.every((call) => call.init?.redirect === "error")).toBe(true);
    expect(calls.every((call) => new Headers(call.init?.headers).get("Content-Type") === "application/json")).toBe(true);
    expect(calls.every((call) => new Headers(call.init?.headers).get("Connect-Protocol-Version") === "1")).toBe(true);
    expect(result).toMatchObject({
      status: "ok",
      method: "file",
      plan: "Pro+",
      cycleDays: 31,
      windows: [{ id: "cycle", usedPercent: 38, resetsAt: 1_785_858_430_000 }],
      fetchedAt: 42,
    });
    expect(JSON.stringify(result)).not.toMatch(/cursor-secret|totalSpend|includedSpend|bonusSpend|limit|remaining/);
  });

  it("keeps Cursor usage when plan metadata fails", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/GetPlanInfo")) return new Response("not found", { status: 404 });
      return jsonResponse({ enabled: true, planUsage: { totalPercentUsed: 7 } });
    });
    const result = await fetchCursorUsage({
      credentials: {
        platform: "linux",
        homedir: () => "/home/operator",
        env: {},
        readBounded: async () => JSON.stringify({ tokens: { access_token: "secret" } }),
        execFile: async () => "",
      },
      fetch: fetchImpl as typeof fetch,
      now: () => 42,
    });
    expect(result).toMatchObject({ status: "ok", windows: [{ id: "cycle", usedPercent: 7 }] });
    expect(result).not.toHaveProperty("plan");
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
      isCursorConnected: async () => false,
      fetchCursor: async () => ({ status: "signed_out" }),
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
