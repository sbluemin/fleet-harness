import { describe, expect, it, vi } from "vitest";

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

import { fetchKimiUsage, parseKimiUsage } from "../../src/kimi/quota.js";

const authService = (key: string | undefined) => ({
  getApiKey: async () => key,
  setApiKey: async () => undefined,
  deleteApiKey: async () => false,
  listProviderIds: async () => [],
});

const kimiUsagePayload = {
  user: { region: "REGION_OVERSEA", membership: { level: "LEVEL_ADVANCED" }, businessId: "" },
  usage: { limit: "100", used: "47", remaining: "53", resetTime: "2026-08-03T13:23:35.825319Z" },
  limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", used: "7", remaining: "93", resetTime: "2026-08-02T11:23:35.825319Z" } }],
  parallel: { limit: "30" }, totalQuota: {}, authentication: { method: "METHOD_API_KEY", scope: "FEATURE_CODING" }, subType: "TYPE_PURCHASE", domain: "DOMAIN_NEXUS",
};

describe("Kimi response parsing", () => {
  it("parses Kimi string quantities, ISO reset times, and declared window durations", () => {
    // 모든 수치가 문자열로 도착하고 resetTime은 ISO-8601이다. 강제 변환을 빠뜨리면
    // percent()가 비-숫자에 0을 돌려주어 소진된 할당량이 미사용으로 보인다.
    // 상세 창의 기간은 상류가 선언하므로 upstream, 최상위 총량 창의 주간 기간은
    // 제품 지식이므로 catalog로 태그된다. 절대량은 개수 단위라 그대로 실린다.
    const cycleResetsAt = Date.parse("2026-08-03T13:23:35.825319Z");
    const sessionResetsAt = Date.parse("2026-08-02T11:23:35.825319Z");
    expect(parseKimiUsage(kimiUsagePayload)).toEqual({
      status: "ok",
      plan: "Advanced",
      windows: [
        {
          id: "cycle",
          usedPercent: 47,
          resetsAt: cycleResetsAt,
          period: {
            durationMs: 604_800_000,
            durationBasis: "catalog",
            startsAt: cycleResetsAt - 604_800_000,
            startsAtBasis: "derived",
          },
          amounts: { used: "47", limit: "100" },
        },
        {
          id: "session",
          usedPercent: 7,
          resetsAt: sessionResetsAt,
          period: {
            durationMs: 18_000_000,
            durationBasis: "upstream",
            startsAt: sessionResetsAt - 18_000_000,
            startsAtBasis: "derived",
          },
          amounts: { used: "7", limit: "100" },
        },
      ],
    });
  });

  it("maps a Kimi window only when its declared duration lands exactly on a Fleet window", () => {
    const withWindow = (duration: number, timeUnit: string) => parseKimiUsage({
      limits: [{ window: { duration, timeUnit }, detail: { limit: "100", used: "10" } }],
    });
    expect(withWindow(5, "TIME_UNIT_HOUR")).toEqual({
      status: "ok",
      windows: [{
        id: "session",
        usedPercent: 10,
        period: { durationMs: 18_000_000, durationBasis: "upstream" },
        amounts: { used: "10", limit: "100" },
      }],
    });
    expect(withWindow(7, "TIME_UNIT_DAY")).toEqual({
      status: "ok",
      windows: [{
        id: "weekly",
        usedPercent: 10,
        period: { durationMs: 604_800_000, durationBasis: "upstream" },
        amounts: { used: "10", limit: "100" },
      }],
    });
    // 60분짜리를 최근접 규칙으로 session에 붙이면 5시간 창으로 오표기된다.
    expect(withWindow(60, "TIME_UNIT_MINUTE")).toEqual({ status: "no_subscription" });
    expect(withWindow(300, "TIME_UNIT_UNSPECIFIED")).toEqual({ status: "no_subscription" });
  });

  it("derives Kimi usage from remaining and refuses windows it cannot quantify", () => {
    expect(parseKimiUsage({ usage: { limit: "200", remaining: "50" } })).toEqual({
      status: "ok",
      windows: [{
        id: "cycle",
        usedPercent: 75,
        period: { durationMs: 604_800_000, durationBasis: "catalog" },
        amounts: { used: "150", limit: "200" },
      }],
    });
    expect(parseKimiUsage({ usage: { limit: "0", used: "0" } })).toEqual({ status: "no_subscription" });
    expect(parseKimiUsage({ usage: { limit: "100" } })).toEqual({ status: "no_subscription" });
    expect(parseKimiUsage({ usage: { limit: "1e3", used: "5" } })).toEqual({ status: "no_subscription" });
    expect(parseKimiUsage({})).toEqual({ status: "no_subscription" });
    expect(parseKimiUsage(null)).toEqual({ status: "no_subscription" });
  });
});

describe("Kimi provider requests", () => {
  it("GETs the usages endpoint with the stored key and returns a key-free DTO", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        usage: { limit: "100", used: "47", resetTime: "2026-08-03T13:23:35.825319Z" },
        user: { userId: "should-not-leak", membership: { level: "LEVEL_ADVANCED" } },
      });
    });
    const result = await fetchKimiUsage({
      authService: authService("sk-kimi-secret"),
      fetch: fetchImpl as typeof fetch,
      now: () => 42,
    });
    expect(calls.map((call) => call.url)).toEqual(["https://api.kimi.com/coding/v1/usages"]);
    expect(calls[0]?.init?.method).toBe("GET");
    expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe("Bearer sk-kimi-secret");
    expect(result).toMatchObject({
      status: "ok",
      plan: "Advanced",
      windows: [{ id: "cycle", usedPercent: 47, amounts: { used: "47", limit: "100" } }],
      fetchedAt: 42,
    });
    // 절대량(amounts.used/limit)은 개수 단위라 의도적으로 노출한다. 비밀 누출 금지는
    // 그대로 유지된다 — 키·계정 식별자가 DTO에 실리면 안 된다는 단언이다.
    expect(JSON.stringify(result)).not.toMatch(/sk-kimi-secret|should-not-leak/);
  });

  it("reports a missing key as signed out without reaching the network", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("must not fetch"); });
    expect(await fetchKimiUsage({ authService: authService(undefined), fetch: fetchImpl as typeof fetch }))
      .toEqual({ status: "signed_out" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a rejected key to expired rather than a generic failure", async () => {
    const result = await fetchKimiUsage({
      authService: authService("sk-stale"),
      fetch: (async () => new Response("{}", { status: 401 })) as typeof fetch,
    });
    expect(result).toEqual({ status: "expired" });
  });
});
