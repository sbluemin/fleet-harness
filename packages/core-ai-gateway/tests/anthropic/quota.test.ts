import { describe, expect, it, vi } from "vitest";

import type { CredentialResolverDeps } from "../../src/transport/credentials.js";
import { fetchClaudeUsage, parseClaudeUsage } from "../../src/anthropic/quota.js";
import { parseCodexUsage, parseResetCredits } from "../../src/codex/quota.js";

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


  it("maps Claude session, weekly, and scoped model windows", () => {
    // Claude 상류는 기간을 숫자로 선언하지 않고 블록명(five_hour/seven_day)으로만
    // 시사하므로, 5h/7d 길이는 catalog로 태그된 제품 지식으로 실린다.
    const sessionResetsAt = Date.parse("2026-08-01T00:00:00Z");
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
      {
        id: "session",
        usedPercent: 13,
        resetsAt: sessionResetsAt,
        period: {
          durationMs: 18_000_000,
          durationBasis: "catalog",
          startsAt: sessionResetsAt - 18_000_000,
          startsAtBasis: "derived",
        },
      },
      {
        id: "weekly",
        usedPercent: 1,
        resetsAt: 2_000_000_000_000,
        period: {
          durationMs: 604_800_000,
          durationBasis: "catalog",
          startsAt: 2_000_000_000_000 - 604_800_000,
          startsAtBasis: "derived",
        },
      },
      {
        id: "model",
        label: "Sonnet",
        usedPercent: 100,
        resetsAt: 2_000_000_000_000,
        period: {
          durationMs: 604_800_000,
          durationBasis: "catalog",
          startsAt: 2_000_000_000_000 - 604_800_000,
          startsAtBasis: "derived",
        },
      },
    ]);
  });

  it("uses the legacy Fable row only when no scoped model rows exist", () => {
    const weeklyCatalogPeriod = { durationMs: 604_800_000, durationBasis: "catalog" };
    expect(parseClaudeUsage({ seven_day_fable: { utilization: 0.1 } }).windows)
      .toEqual([{ id: "model", label: "Fable", usedPercent: 0, period: weeklyCatalogPeriod }]);
    expect(parseClaudeUsage({
      fable_weekly: {},
      seven_day_fable: { percent: 55 },
    }).windows).toEqual([{ id: "model", label: "Fable", usedPercent: 55, period: weeklyCatalogPeriod }]);
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
    const sessionPeriod = { durationMs: 18_000_000, durationBasis: "catalog" };
    const weeklyPeriod = { durationMs: 604_800_000, durationBasis: "catalog" };
    expect(parseClaudeUsage({
      limits: [
        { kind: "session", percent: 5 },
        { kind: "weekly_all", percent: 9 },
      ],
    }).windows).toEqual([
      { id: "session", usedPercent: 5, period: sessionPeriod },
      { id: "weekly", usedPercent: 9, period: weeklyPeriod },
    ]);
    expect(parseClaudeUsage({
      five_hour: { percent: 17 },
      limits: [
        { kind: "session", percent: 5 },
        { kind: "weekly_all", percent: 9 },
      ],
    }).windows).toEqual([
      { id: "session", usedPercent: 17, period: sessionPeriod },
      { id: "weekly", usedPercent: 9, period: weeklyPeriod },
    ]);
    expect(parseClaudeUsage({
      five_hour: { resets_at: 2_000_000_000 },
      limits: [{ kind: "session", percent: 67 }],
    }).windows).toEqual([{ id: "session", usedPercent: 67, period: sessionPeriod }]);
    expect(parseClaudeUsage({
      five_hour: { percent: 0 },
      limits: [{ kind: "session", percent: 67 }],
    }).windows).toEqual([{ id: "session", usedPercent: 0, period: sessionPeriod }]);
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
