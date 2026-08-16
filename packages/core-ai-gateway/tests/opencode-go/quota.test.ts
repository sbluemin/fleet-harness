import { describe, expect, it, vi } from "vitest";

import { OPENCODE_AUTH_PROVIDER_ID } from "../../src/opencode-go/index.js";
import {
  fetchOpencodeUsage,
  OPENCODE_GO_USAGE_URL,
  OPENCODE_MONTH_MS,
  OPENCODE_SESSION_MS,
  parseOpencodeUsage,
} from "../../src/opencode-go/quota.js";
import { WEEK_MS } from "../../src/quota/windows.js";

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

const authService = (key: string | undefined) => ({
  getApiKey: async () => key,
  setApiKey: async () => undefined,
  deleteApiKey: async () => false,
  listProviderIds: async () => [],
});

const samplePayload = {
  usage: {
    rolling: { status: "ok", percent: 12, resetsAt: "2026-07-12T17:00:00.000Z" },
    weekly: { status: "ok", percent: 8, resetsAt: "2026-07-13T00:00:00.000Z" },
    monthly: { status: "ok", percent: 35, resetsAt: "2026-08-04T11:18:32.000Z" },
  },
};

describe("OpenCode Go response parsing", () => {
  it("maps rolling/weekly/monthly percents onto Fleet session/weekly/cycle windows", () => {
    const sessionResetsAt = Date.parse("2026-07-12T17:00:00.000Z");
    const weeklyResetsAt = Date.parse("2026-07-13T00:00:00.000Z");
    const cycleResetsAt = Date.parse("2026-08-04T11:18:32.000Z");
    expect(parseOpencodeUsage(samplePayload)).toEqual({
      cycleDays: 30,
      windows: [
        {
          id: "session",
          usedPercent: 12,
          resetsAt: sessionResetsAt,
          period: {
            durationMs: OPENCODE_SESSION_MS,
            durationBasis: "catalog",
            startsAt: sessionResetsAt - OPENCODE_SESSION_MS,
            startsAtBasis: "derived",
          },
        },
        {
          id: "weekly",
          usedPercent: 8,
          resetsAt: weeklyResetsAt,
          period: {
            durationMs: WEEK_MS,
            durationBasis: "catalog",
            startsAt: weeklyResetsAt - WEEK_MS,
            startsAtBasis: "derived",
          },
        },
        {
          id: "cycle",
          usedPercent: 35,
          resetsAt: cycleResetsAt,
          period: {
            durationMs: OPENCODE_MONTH_MS,
            durationBasis: "catalog",
            startsAt: cycleResetsAt - OPENCODE_MONTH_MS,
            startsAtBasis: "derived",
          },
        },
      ],
    });
  });

  it("treats a genuine 0% as a real meter, not an empty subscription", () => {
    expect(parseOpencodeUsage({
      usage: {
        rolling: { percent: 0, resetsAt: "2026-07-12T17:00:00.000Z" },
        weekly: { percent: 0, resetsAt: "2026-07-13T00:00:00.000Z" },
        monthly: { percent: 0, resetsAt: "2026-08-04T00:00:00.000Z" },
      },
    })).toMatchObject({
      windows: [
        { id: "session", usedPercent: 0 },
        { id: "weekly", usedPercent: 0 },
        { id: "cycle", usedPercent: 0 },
      ],
    });
  });

  it("clamps percents and refuses a payload that cannot quantify every window", () => {
    expect(parseOpencodeUsage({
      usage: {
        rolling: { percent: 150 },
        weekly: { percent: -4 },
        monthly: { percent: 35 },
      },
    })).toMatchObject({
      windows: [
        { id: "session", usedPercent: 100 },
        { id: "weekly", usedPercent: 0 },
        { id: "cycle", usedPercent: 35 },
      ],
    });
    // A 200 with a missing window is schema drift, not "no plan" — that is HTTP 403.
    expect(parseOpencodeUsage({})).toBeNull();
    expect(parseOpencodeUsage({ usage: { weekly: { percent: 1 } } })).toBeNull();
    expect(parseOpencodeUsage({
      usage: {
        rolling: { percent: "12" },
        weekly: { percent: 8 },
        monthly: { percent: 35 },
      },
    })).toBeNull();
  });
});

describe("OpenCode Go provider requests", () => {
  it("GETs the official usage endpoint with the stored key and returns a key-free DTO", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse(samplePayload);
    });
    const result = await fetchOpencodeUsage({
      authService: authService("sk-opencode-secret"),
      fetch: fetchImpl as typeof fetch,
      now: () => 42,
    });
    expect(calls.map((call) => call.url)).toEqual([OPENCODE_GO_USAGE_URL]);
    expect(calls[0]?.init?.method).toBe("GET");
    expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe("Bearer sk-opencode-secret");
    expect(result).toMatchObject({
      status: "ok",
      plan: "Go",
      cycleDays: 30,
      windows: [
        { id: "session", usedPercent: 12 },
        { id: "weekly", usedPercent: 8 },
        { id: "cycle", usedPercent: 35 },
      ],
      fetchedAt: 42,
    });
    expect(JSON.stringify(result)).not.toMatch(/sk-opencode-secret/);
  });

  it("reads its key through the injected auth service without constructing a default auth path", async () => {
    const auth = {
      getApiKey: vi.fn(async (providerId: string) => providerId === OPENCODE_AUTH_PROVIDER_ID ? "opencode-key" : undefined),
      setApiKey: async () => undefined,
      deleteApiKey: async () => false,
      listProviderIds: async () => [],
    };
    const result = await fetchOpencodeUsage({
      authService: auth,
      fetch: (async () => jsonResponse(samplePayload)) as typeof fetch,
      now: () => 42,
    });
    expect(result).toMatchObject({ status: "ok", plan: "Go", fetchedAt: 42 });
    expect(auth.getApiKey).toHaveBeenCalledWith(OPENCODE_AUTH_PROVIDER_ID);
  });

  it("reports a missing key as signed out without reaching the network", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("must not fetch"); });
    expect(await fetchOpencodeUsage({ authService: authService(undefined), fetch: fetchImpl as typeof fetch }))
      .toEqual({ status: "signed_out" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails loudly when a 200 body cannot quantify every window", async () => {
    await expect(fetchOpencodeUsage({
      authService: authService("sk-valid"),
      fetch: (async () => jsonResponse({})) as typeof fetch,
    })).rejects.toThrow("Provider response invalid");
  });

  it("maps a rejected key to expired and a 403 to no subscription", async () => {
    expect(await fetchOpencodeUsage({
      authService: authService("sk-stale"),
      fetch: (async () => new Response("{}", { status: 401 })) as typeof fetch,
    })).toEqual({ status: "expired" });
    expect(await fetchOpencodeUsage({
      authService: authService("sk-valid"),
      fetch: (async () => new Response(
        JSON.stringify({ type: "error", error: { type: "EntitlementError", message: "OpenCode Go subscription required." } }),
        { status: 403 },
      )) as typeof fetch,
    })).toEqual({ status: "no_subscription" });
  });
});
