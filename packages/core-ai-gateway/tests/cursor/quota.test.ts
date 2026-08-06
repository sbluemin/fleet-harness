import { describe, expect, it, vi } from "vitest";

import type { CredentialResolverDeps } from "../../src/transport/credentials.js";
import { fetchCursorUsage, parseCursorUsage } from "../../src/cursor/quota.js";

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

describe("Cursor response parsing", () => {
  it("parses Cursor numeric-string epochs, measured percentages, and cycle length", () => {
    // 두 경계 모두 상류 사실이므로 period는 upstream으로 태그되고, scope-less 총합
    // 창은 자매 풀이 있을 때 isAggregate로 표시되어 이중 계산을 막는다.
    const cyclePeriod = {
      durationMs: 1_785_858_430_000 - 1_783_180_030_000,
      durationBasis: "upstream",
      startsAt: 1_783_180_030_000,
      startsAtBasis: "upstream",
    };
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
        { id: "cycle", usedPercent: 38, resetsAt: 1_785_858_430_000, period: cyclePeriod, isAggregate: true },
        { id: "cycle", scope: "auto", label: "Auto", usedPercent: 36, resetsAt: 1_785_858_430_000, period: cyclePeriod },
        { id: "cycle", scope: "api", label: "API", usedPercent: 53, resetsAt: 1_785_858_430_000, period: cyclePeriod },
      ],
    });
  });

  it("tags the Cursor total as an aggregate only when scoped pools accompany it", () => {
    // scope-less 창이 단독이면 그 자체가 전체 할당이다. 그때도 aggregate로 표시하면
    // 헤드룸 계산에서 제외되어 읽을 창이 사라진다.
    const withPools = parseCursorUsage({ enabled: true, planUsage: { totalPercentUsed: 10, apiPercentUsed: 20 } });
    const pools = withPools.status === "ok" ? withPools.windows : [];
    expect(pools.find((window) => window.scope === undefined)?.isAggregate).toBe(true);
    expect(pools.find((window) => window.scope === "api")?.isAggregate).toBeUndefined();
    const alone = parseCursorUsage({ enabled: true, planUsage: { totalPercentUsed: 10 } });
    expect(alone.status === "ok" ? alone.windows[0]?.isAggregate : "unreachable").toBeUndefined();
  });

  it("scopes each Cursor pool so a model's own allowance is readable apart from the total", () => {
    // 2026-08-02 실측: 합산은 65%인데 API 풀은 92%로 거의 고갈이었다. 합산만 노출하면
    // API 티어 모델을 고르는 호출자가 여유가 있다고 오독한다.
    const parsed = parseCursorUsage({
      enabled: true,
      planUsage: { totalPercentUsed: 65, autoPercentUsed: 62, apiPercentUsed: 92 },
    });
    expect(parsed.status).toBe("ok");
    const windows = parsed.status === "ok" ? parsed.windows : [];
    expect(windows.find((window) => window.scope === undefined)?.usedPercent).toBe(65);
    expect(windows.find((window) => window.scope === "auto")?.usedPercent).toBe(62);
    expect(windows.find((window) => window.scope === "api")?.usedPercent).toBe(92);
  });

  it("never derives Cursor percentages from cents and identifies no-subscription states", () => {
    expect(parseCursorUsage({
      planUsage: { totalSpend: 34_799, limit: 7_000, autoPercentUsed: 12 },
      enabled: true,
    })).toEqual({
      status: "ok",
      windows: [{ id: "cycle", scope: "auto", label: "Auto", usedPercent: 12 }],
    });
    expect(parseCursorUsage({ enabled: false, planUsage: { totalPercentUsed: 10 } }))
      .toEqual({ status: "no_subscription" });
    expect(parseCursorUsage({ enabled: true })).toEqual({ status: "no_subscription" });
    expect(parseCursorUsage({ enabled: true, planUsage: { totalPercentUsed: Number.NaN } }))
      .toEqual({ status: "no_subscription" });
    expect(parseCursorUsage({ enabled: true, planUsage: {} }))
      .toEqual({ status: "no_subscription" });
  });

  it("omits fabricated Cursor cycle lengths while preserving a valid 31-day span", () => {
    const start = 1_700_000_000_000;
    const parseCycle = (end: number) => parseCursorUsage({
      billingCycleStart: start,
      billingCycleEnd: end,
      planUsage: { totalPercentUsed: 10 },
      enabled: true,
    });
    for (const end of [start - 86_400_000, start, start + 500 * 86_400_000]) {
      expect(parseCycle(end)).not.toHaveProperty("cycleDays");
    }
    expect(parseCycle(start + 31 * 86_400_000)).toMatchObject({ cycleDays: 31 });
  });

  it("accepts only canonical numeric-string epochs and preserves date-string parsing", () => {
    const resetFor = (billingCycleEnd: unknown) => {
      const parsed = parseCursorUsage({
        billingCycleEnd,
        planUsage: { totalPercentUsed: 10 },
        enabled: true,
      });
      return parsed.status === "ok" ? parsed.windows[0]?.resetsAt : undefined;
    };
    expect(resetFor("2024")).toBe(Date.parse("2024"));
    expect(resetFor("1785858430000")).toBe(1_785_858_430_000);
    expect(resetFor("-1")).toBe(Date.parse("-1"));
    expect(resetFor("0123456789012")).toBe(
      Number.isFinite(Date.parse("0123456789012")) ? Date.parse("0123456789012") : undefined,
    );
    expect(resetFor("2026-08-01T00:00:00Z")).toBe(Date.parse("2026-08-01T00:00:00Z"));
    expect(resetFor(2_000_000_000)).toBe(2_000_000_000_000);
    expect(resetFor(2_000_000_000_000)).toBe(2_000_000_000_000);
  });
});

describe("Cursor provider requests", () => {
  it("POSTs exact empty JSON to only the measured endpoints and returns a token-free DTO", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse(String(url).endsWith("/GetPlanInfo")
        ? { planInfo: { planName: "Pro+", includedAmountCents: 7000 }, nextUpgrade: { name: "Ultra" } }
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

  it("rejects numeric Cursor plan labels without enumerating valid tiers", async () => {
    const fetchPlan = async (planName: string) => fetchCursorUsage({
      credentials: {
        platform: "linux",
        homedir: () => "/home/operator",
        env: {},
        readBounded: async () => JSON.stringify({ accessToken: "secret" }),
        execFile: async () => "",
      },
      fetch: (async (url: string | URL | Request) => jsonResponse(
        String(url).endsWith("/GetPlanInfo")
          ? { planInfo: { planName } }
          : { enabled: true, planUsage: { totalPercentUsed: 7 } },
      )) as typeof fetch,
      now: () => 42,
    });
    expect(await fetchPlan("7000")).not.toHaveProperty("plan");
    for (const planName of ["Pro+", "Ultra", "Teams"]) {
      expect(await fetchPlan(planName)).toHaveProperty("plan", planName);
    }
  });
});

