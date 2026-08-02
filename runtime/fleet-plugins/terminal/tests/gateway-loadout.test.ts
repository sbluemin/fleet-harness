import { describe, expect, it, vi } from "vitest";

import { readConsoleQuotaSnapshot, toQuotaSnapshot } from "../server/agent-api/gateway-loadout.js";

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

const summary = {
  providers: {
    claude: { status: "ok", windows: [{ id: "weekly", usedPercent: 28, resetsAt: 1_785_763_415_825 }], fetchedAt: 42 },
    cursor: {
      status: "ok",
      windows: [
        { id: "cycle", usedPercent: 65 },
        { id: "cycle", scope: "auto", label: "Auto", usedPercent: 62 },
        { id: "cycle", scope: "api", label: "API", usedPercent: 92 },
      ],
    },
    kimi: { status: "signed_out" },
  },
};

describe("console quota snapshot", () => {
  it("carries each pool's scope through so a model can be matched to its own allowance", () => {
    const snapshot = toQuotaSnapshot(summary);
    const cursor = snapshot?.cursor;
    expect(cursor?.windows?.map((window) => window.scope)).toEqual([undefined, "auto", "api"]);
    expect(cursor?.windows?.find((window) => window.scope === "api")?.usedPercent).toBe(92);
  });

  it("keeps a provider that reports no windows instead of dropping it", () => {
    // 창이 없다고 빼버리면 로스터에서 사라지고, 읽을 수 없는 상태가 여유로 오독된다.
    expect(toQuotaSnapshot(summary)?.kimi).toEqual({ status: "signed_out" });
  });

  it("discards malformed windows without discarding the provider", () => {
    const snapshot = toQuotaSnapshot({
      providers: { cursor: { status: "ok", windows: [{ id: "cycle" }, { usedPercent: 10 }, { id: "cycle", usedPercent: 7 }] } },
    });
    expect(snapshot?.cursor?.windows).toEqual([{ id: "cycle", usedPercent: 7 }]);
  });

  it("returns undefined for a shape it cannot read", () => {
    expect(toQuotaSnapshot(null)).toBeUndefined();
    expect(toQuotaSnapshot({})).toBeUndefined();
    expect(toQuotaSnapshot({ providers: {} })).toBeUndefined();
    expect(toQuotaSnapshot({ providers: { cursor: { windows: [] } } })).toBeUndefined();
  });

  it("requests the Console's own quota route with an Origin the host gate accepts", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse(summary);
    });
    const snapshot = await readConsoleQuotaSnapshot("http://127.0.0.1:57333", fetchImpl as typeof fetch);
    expect(calls[0]?.url).toBe("http://127.0.0.1:57333/plugins/quota/summary");
    expect(new Headers(calls[0]?.init?.headers).get("Origin")).toBe("http://127.0.0.1:57333");
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(snapshot?.claude?.status).toBe("ok");
  });

  it("waits longer than the summary's own worst-case provider wait", async () => {
    // 요약은 네 프로바이더를 모두 기다리고, 각 요청은 10초까지 버티며 일부는 두 번
    // 순차 호출한다(최악 20초). 그보다 먼저 끊으면 이미 성공한 프로바이더의 결과까지
    // 버려지고 전부 unsupported가 된다.
    const SUMMARY_WORST_CASE_MS = 20_000;
    let observedTimeoutMs: number | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      const started = Date.now();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 0);
        signal?.addEventListener("abort", () => {
          observedTimeoutMs = Date.now() - started;
          clearTimeout(timer);
          resolve();
        });
      });
      return jsonResponse(summary);
    }) as typeof fetch;
    vi.useFakeTimers();
    try {
      const pending = readConsoleQuotaSnapshot("http://127.0.0.1:57333", fetchImpl);
      await vi.advanceTimersByTimeAsync(SUMMARY_WORST_CASE_MS);
      await pending;
    } finally {
      vi.useRealTimers();
    }
    // 최악 대기 시점에 아직 abort되지 않았어야 한다.
    expect(observedTimeoutMs).toBeUndefined();
  });

  it("degrades to no snapshot when the Console has no port or the route fails", async () => {
    expect(await readConsoleQuotaSnapshot(null)).toBeUndefined();
    expect(await readConsoleQuotaSnapshot(
      "http://127.0.0.1:57333",
      (async () => new Response("nope", { status: 500 })) as typeof fetch,
    )).toBeUndefined();
    expect(await readConsoleQuotaSnapshot(
      "http://127.0.0.1:57333",
      (async () => { throw new Error("unreachable"); }) as typeof fetch,
    )).toBeUndefined();
  });
});
