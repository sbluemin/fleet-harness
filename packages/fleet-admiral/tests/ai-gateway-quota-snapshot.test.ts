import { describe, expect, it } from "vitest";

import { parseGatewayQuotaSnapshot } from "../src/ai-gateway/quota-snapshot.js";

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

describe("gateway quota snapshot", () => {
  it("carries each pool's scope through so a model can be matched to its own allowance", () => {
    const snapshot = parseGatewayQuotaSnapshot(summary);
    const cursor = snapshot?.cursor;
    expect(cursor?.windows?.map((window) => window.scope)).toEqual([undefined, "auto", "api"]);
    expect(cursor?.windows?.find((window) => window.scope === "api")?.usedPercent).toBe(92);
  });

  it("keeps a provider that reports no windows instead of dropping it", () => {
    // 창이 없다고 빼버리면 로스터에서 사라지고, 읽을 수 없는 상태가 여유로 오독된다.
    expect(parseGatewayQuotaSnapshot(summary)?.kimi).toEqual({ status: "signed_out" });
  });

  it("discards malformed windows without discarding the provider", () => {
    const snapshot = parseGatewayQuotaSnapshot({
      providers: { cursor: { status: "ok", windows: [{ id: "cycle" }, { usedPercent: 10 }, { id: "cycle", usedPercent: 7 }] } },
    });
    expect(snapshot?.cursor?.windows).toEqual([{ id: "cycle", usedPercent: 7 }]);
  });

  it("carries label, period, isAggregate, and amounts through to the loadout", () => {
    // 이 변환은 과거 label·cycleDays를 버려서 창의 기간·모델 식별을 소비자에게서
    // 숨겼다. 사실 필드는 검증 후 통과가 계약이다.
    const snapshot = parseGatewayQuotaSnapshot({
      providers: {
        claude: {
          status: "ok",
          windows: [{
            id: "model",
            label: "Sonnet",
            usedPercent: 48,
            resetsAt: 2_000_000_000_000,
            period: {
              durationMs: 604_800_000,
              durationBasis: "catalog",
              startsAt: 2_000_000_000_000 - 604_800_000,
              startsAtBasis: "derived",
            },
          }],
        },
        cursor: {
          status: "ok",
          windows: [
            { id: "cycle", usedPercent: 78, isAggregate: true },
            { id: "cycle", scope: "api", usedPercent: 97 },
          ],
        },
        kimi: {
          status: "ok",
          windows: [{ id: "cycle", usedPercent: 47, amounts: { used: "47", limit: "100" } }],
        },
      },
    });
    expect(snapshot?.claude?.windows?.[0]).toEqual({
      id: "model",
      label: "Sonnet",
      usedPercent: 48,
      resetsAt: 2_000_000_000_000,
      period: {
        durationMs: 604_800_000,
        durationBasis: "catalog",
        startsAt: 2_000_000_000_000 - 604_800_000,
        startsAtBasis: "derived",
      },
    });
    expect(snapshot?.cursor?.windows?.map((window) => window.isAggregate)).toEqual([true, undefined]);
    expect(snapshot?.kimi?.windows?.[0]?.amounts).toEqual({ used: "47", limit: "100" });
  });

  it("drops malformed period and amounts without dropping the window", () => {
    const snapshot = parseGatewayQuotaSnapshot({
      providers: {
        kimi: {
          status: "ok",
          windows: [{
            id: "cycle",
            usedPercent: 10,
            period: { durationMs: -1, durationBasis: "catalog" },
            amounts: { used: "not-a-number", limit: "100" },
          }],
        },
      },
    });
    expect(snapshot?.kimi?.windows).toEqual([{ id: "cycle", usedPercent: 10 }]);
  });

  it("rejects a period whose provenance or length violates the quota contract", () => {
    // 미지의 basis나 400일 초과 기간을 통과시키면 하류 파생(cadence/pace)이 출처
    // 불명의 숫자 위에서 수행된다. 닫힌 어휘와 상한은 이 경계가 되짚는 계약이다.
    const windowWith = (period: unknown) => parseGatewayQuotaSnapshot({
      providers: { kimi: { status: "ok", windows: [{ id: "cycle", usedPercent: 10, period }] } },
    })?.kimi?.windows?.[0];
    expect(windowWith({ durationMs: 604_800_000, durationBasis: "bogus" })).toEqual({ id: "cycle", usedPercent: 10 });
    expect(windowWith({ durationMs: 401 * 24 * 3_600_000, durationBasis: "upstream" }))
      .toEqual({ id: "cycle", usedPercent: 10 });
    const oddStartBasis = windowWith({
      durationMs: 604_800_000,
      durationBasis: "upstream",
      startsAt: 1_000,
      startsAtBasis: "secret",
    });
    expect(oddStartBasis?.period).toEqual({ durationMs: 604_800_000, durationBasis: "upstream", startsAt: 1_000 });
  });

  it("returns undefined for a shape it cannot read", () => {
    expect(parseGatewayQuotaSnapshot(null)).toBeUndefined();
    expect(parseGatewayQuotaSnapshot({})).toBeUndefined();
    expect(parseGatewayQuotaSnapshot({ providers: {} })).toBeUndefined();
    expect(parseGatewayQuotaSnapshot({ providers: { cursor: { windows: [] } } })).toBeUndefined();
  });
});
