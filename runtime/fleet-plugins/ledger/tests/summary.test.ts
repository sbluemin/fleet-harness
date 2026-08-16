import { describe, expect, it } from "vitest";

import { buildSummary, localDayKey } from "../server/summary.js";
import type { LedgerSourceStatus, TokscaleModelEntry, TokscaleSession } from "../server/types.js";

const sessionA = "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103";
const sessionB = "40bf2ab7-5a5d-4a8c-8aaa-730a40ecf104";

function localTime(year: number, month: number, day: number, hour = 12): number {
  return new Date(year, month - 1, day, hour).getTime();
}

function shiftLocalDate(atMs: number, days: number): number {
  const date = new Date(atMs);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

function session(sessionId: string, lastActive: number): TokscaleSession {
  return { sessionId, lastActive };
}

function entry(overrides: Partial<TokscaleModelEntry> = {}): TokscaleModelEntry {
  return {
    sessionId: sessionA,
    modelId: "claude-opus-5",
    input: 10,
    output: 2,
    cacheRead: 3,
    cacheWrite: 0,
    costUsd: 1.25,
    messages: 4,
    ...overrides,
  };
}

function breakdown(
  entries: readonly TokscaleModelEntry[],
  status: LedgerSourceStatus = "ok",
  skippedEntries = 0,
) {
  return { entries, status, skippedEntries };
}

describe("Claude Code provider attribution", () => {
  it("uses every Claude Code model-ledger row as the single source of every total", () => {
    const at = localTime(2026, 8, 14);
    const dto = buildSummary(
      [session(sessionA, at)],
      { window: "today" },
      "ok",
      at,
      0,
      breakdown([
        entry(),
        entry({ modelId: "claude-gateway--cursor--claude-opus-5", input: 1_000, costUsd: 99 }),
        entry({ modelId: "gpt-5", input: 2_000, costUsd: 88 }),
      ]),
    );

    expect(dto.totals).toEqual({
      input: 3_010,
      output: 6,
      cacheRead: 9,
      cacheWrite: 0,
      costUsd: 188.25,
      messages: 12,
    });
    expect(dto.modelRows.map((row) => ({ modelId: row.modelId, provider: row.provider, costUsd: row.costUsd }))).toEqual([
      { modelId: "claude-gateway--cursor--claude-opus-5", provider: "cursor", costUsd: 99 },
      { modelId: "gpt-5", provider: "unknown", costUsd: 88 },
      { modelId: "claude-opus-5", provider: "anthropic", costUsd: 1.25 },
    ]);
    expect(dto.daily).toEqual([{ day: "2026-08-14", costUsd: 188.25 }]);
    expect(dto.dailyDetails[0]?.models).toEqual(dto.modelRows);
  });

  it("preserves cache-write tokens in every usage aggregate", () => {
    const at = localTime(2026, 8, 14);
    const dto = buildSummary(
      [session(sessionA, at)],
      { window: "today" },
      "ok",
      at,
      0,
      breakdown([entry({ cacheWrite: 7 })]),
    );

    expect(dto.totals.cacheWrite).toBe(7);
    expect(dto.modelRows[0]?.usage.cacheWrite).toBe(7);
    expect(dto.dailyDetails[0]?.usage.cacheWrite).toBe(7);
    expect(dto.dailyDetails[0]?.models[0]?.usage.cacheWrite).toBe(7);
  });

  it("splits a mixed native and Gateway session into provider-attributed rows without estimation", () => {
    const at = localTime(2026, 8, 14);
    const dto = buildSummary(
      [session(sessionA, at)],
      { window: "today" },
      "ok",
      at,
      0,
      breakdown([
        entry({ modelId: "claude-opus-5", costUsd: 2 }),
        entry({ modelId: "claude-gateway--xai--grok-4.6", costUsd: 30 }),
      ]),
    );
    expect(dto.totals.costUsd).toBe(32);
    expect(dto.dailyDetails[0]?.costUsd).toBe(32);
    expect(dto.modelRows.map((row) => ({ provider: row.provider, label: row.label }))).toEqual([
      { provider: "xai", label: "Grok 4.6" },
      { provider: "anthropic", label: "Claude Opus 5" },
    ]);
  });

  it("aggregates repeated and Fast rows only within the same provider and base model", () => {
    const at = localTime(2026, 8, 14);
    const dto = buildSummary(
      [session(sessionA, at), session(sessionB, at)],
      { window: "today" },
      "ok",
      at,
      0,
      breakdown([
        entry({ sessionId: sessionA, modelId: "claude-opus-5", costUsd: 2 }),
        entry({ sessionId: sessionB, modelId: "claude-opus-5", input: 7, costUsd: 3, messages: 2 }),
        entry({ sessionId: sessionB, modelId: "claude-gateway--cursor--claude-opus-5", costUsd: 4 }),
        entry({ sessionId: sessionA, modelId: "claude-gateway--cursor--claude-opus-5-fast", input: 5, costUsd: 6, messages: 1 }),
      ]),
    );
    expect(dto.modelRows).toEqual([
      {
        modelId: "claude-gateway--cursor--claude-opus-5",
        provider: "cursor",
        label: "Claude Opus 5",
        usage: { input: 15, output: 4, cacheRead: 6, cacheWrite: 0 },
        costUsd: 10,
        messages: 5,
      },
      {
        modelId: "claude-opus-5",
        provider: "anthropic",
        label: "Claude Opus 5",
        usage: { input: 17, output: 4, cacheRead: 6, cacheWrite: 0 },
        costUsd: 5,
        messages: 6,
      },
    ]);
    expect(dto.dailyDetails[0]).toMatchObject({ costUsd: 15, modelCount: 2, messages: 11 });
  });
});

describe("model-ledger daily join", () => {
  it("joins each session-model row to report lastActive and groups models by local day", () => {
    const first = localTime(2026, 8, 13, 8);
    const second = localTime(2026, 8, 14, 20);
    const dto = buildSummary(
      [session(sessionA, first), session(sessionB, second)],
      { window: "today" },
      "ok",
      second,
      0,
      breakdown([
        entry({ sessionId: sessionA, modelId: "claude-opus-5", costUsd: 2 }),
        entry({ sessionId: sessionB, modelId: "claude-sonnet-5", costUsd: 3 }),
      ]),
    );

    expect(dto.daily).toEqual([
      { day: "2026-08-13", costUsd: 2 },
      { day: "2026-08-14", costUsd: 3 },
    ]);
    expect(dto.dailyDetails.map((detail) => ({
      day: detail.day,
      models: detail.models.map((model) => model.modelId),
    }))).toEqual([
      { day: "2026-08-13", models: ["claude-opus-5"] },
      { day: "2026-08-14", models: ["claude-sonnet-5"] },
    ]);
  });

  it("keeps unmatched Claude Code rows in totals but excludes them from daily detail", () => {
    const at = localTime(2026, 8, 14);
    const dto = buildSummary(
      [session(sessionA, at)],
      { window: "today" },
      "ok",
      at,
      0,
      breakdown([
        entry({ sessionId: sessionA, costUsd: 2 }),
        entry({ sessionId: sessionB, modelId: "claude-sonnet-5", costUsd: 3 }),
        entry({ sessionId: sessionB, modelId: "claude-gateway--xai--grok-4.6", costUsd: 100 }),
      ]),
    );
    expect(dto.totals.costUsd).toBe(105);
    expect(dto.daily).toEqual([{ day: "2026-08-14", costUsd: 2 }]);
    expect(dto.dailySource.unmatchedEntries).toBe(2);
  });

  it("fills the requested local-day axis while retaining an earlier observed day", () => {
    const generatedAtMs = localTime(2026, 8, 14);
    const observedAtMs = shiftLocalDate(generatedAtMs, -8);
    const dto = buildSummary(
      [session(sessionA, observedAtMs), session(sessionB, generatedAtMs)],
      { window: "week" },
      "ok",
      generatedAtMs,
      0,
      breakdown([
        entry({ sessionId: sessionA, costUsd: 2 }),
        entry({ sessionId: sessionB, costUsd: 3 }),
      ]),
    );
    expect(dto.daily).toHaveLength(9);
    expect(dto.daily[0]).toEqual({ day: localDayKey(observedAtMs), costUsd: 2 });
    expect(dto.daily.at(-1)).toEqual({ day: localDayKey(generatedAtMs), costUsd: 3 });
    expect(dto.daily[1]?.costUsd).toBe(0);
  });

  it("caps malformed or stale daily spans to the most recent 366 local days", () => {
    const latest = localTime(2026, 8, 14);
    const cutoff = shiftLocalDate(latest, -365);
    const stale = shiftLocalDate(latest, -400);
    const dto = buildSummary(
      [session(sessionA, stale), session(sessionB, cutoff)],
      { window: "today" },
      "ok",
      latest,
      0,
      breakdown([
        entry({ sessionId: sessionA, costUsd: 1 }),
        entry({ sessionId: sessionB, costUsd: 2 }),
        entry({ sessionId: "50bf2ab7-5a5d-4a8c-8aaa-730a40ecf105", costUsd: 3 }),
      ]),
    );
    expect(dto.daily).toHaveLength(366);
    expect(dto.daily[0]).toEqual({ day: localDayKey(cutoff), costUsd: 2 });
    expect(dto.daily.at(-1)).toEqual({ day: localDayKey(latest), costUsd: 0 });
    expect(dto.daily.some((point) => point.day === localDayKey(stale))).toBe(false);
    expect(dto.dailySource.unmatchedEntries).toBe(1);
  });

  it("returns no derived all-zero axis when no model row has date metadata", () => {
    const at = localTime(2026, 8, 14);
    const dto = buildSummary([], { window: "week" }, "ok", at, 0, breakdown([entry()]));
    expect(dto.totals.costUsd).toBe(1.25);
    expect(dto.daily).toEqual([]);
    expect(dto.dailyDetails).toEqual([]);
    expect(dto.dailySource.unmatchedEntries).toBe(1);
  });
});

describe("source integrity and DTO boundaries", () => {
  it.each(["unavailable", "unreadable"] as const)(
    "retains model totals but omits daily detail when report metadata is %s",
    (reportStatus) => {
      const dto = buildSummary([], { window: "week" }, reportStatus, 123, 0, breakdown([entry()]));
      expect(dto.totals.costUsd).toBe(1.25);
      expect(dto.modelRows).toHaveLength(1);
      expect(dto.daily).toEqual([]);
      expect(dto.dailyDetails).toEqual([]);
      expect(dto.source).toMatchObject({ status: "degraded", models: "ok", report: reportStatus });
    },
  );

  it.each(["bootstrapping", "unavailable", "unreadable"] as const)(
    "fails closed when the canonical model ledger is %s",
    (modelsStatus) => {
      const dto = buildSummary([], { window: "week" }, "ok", 123, 0, breakdown([entry()], modelsStatus));
      expect(dto.totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, messages: 0 });
      expect(dto.modelRows).toEqual([]);
      expect(dto.daily).toEqual([]);
      expect(dto.source.status).toBe(modelsStatus);
    },
  );

  it("reports partial parser coverage without dropping valid model totals", () => {
    const dto = buildSummary([], { window: "week" }, "degraded", 123, 2, breakdown([entry()], "degraded", 3));
    expect(dto.totals.costUsd).toBe(1.25);
    expect(dto.source).toEqual({
      status: "degraded",
      models: "degraded",
      report: "degraded",
      skippedEntries: 3,
      skippedSessions: 2,
    });
  });

  it("fails closed on aggregate overflow without serializing non-finite cost", () => {
    const dto = buildSummary([], { window: "week" }, "ok", 123, 0, breakdown([
      entry({ costUsd: Number.MAX_VALUE }),
      entry({ sessionId: sessionB, costUsd: Number.MAX_VALUE }),
    ]));
    expect(dto.totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, messages: 0 });
    expect(dto.source).toMatchObject({ status: "unreadable", models: "unreadable", skippedEntries: 2 });
    expect(JSON.stringify(dto)).not.toContain('"costUsd":null');
  });

  it("fails closed when aggregated token or message counts stop being safe integers", () => {
    const dto = buildSummary([], { window: "week" }, "ok", 123, 0, breakdown([
      entry({ input: Number.MAX_SAFE_INTEGER }),
      entry({ sessionId: sessionB, input: 1 }),
    ]));
    expect(dto.totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, messages: 0 });
    expect(dto.source).toMatchObject({ status: "unreadable", models: "unreadable", skippedEntries: 2 });
  });

  it("caps serialized model rows while preserving the uncapped model count", () => {
    const entries = Array.from({ length: 81 }, (_, index) => entry({
      modelId: `claude-model-${index}`,
      costUsd: 81 - index,
    }));
    const dto = buildSummary([], { window: "week" }, "unavailable", 123, 0, breakdown(entries));
    expect(dto.modelRows).toHaveLength(80);
    expect(dto.modelCount).toBe(81);
    expect(dto.modelRows[0]?.modelId).toBe("claude-model-0");
  });

  it("allowlists schema version 2 without session identity or filesystem metadata", () => {
    const dto = buildSummary(
      [session(sessionA, localTime(2026, 8, 14))],
      { window: "week" },
      "ok",
      localTime(2026, 8, 14),
      0,
      breakdown([entry()]),
    );
    const serialized = JSON.stringify(dto);
    expect(dto.schemaVersion).toBe(2);
    expect(dto.scope).toEqual({ window: "week" });
    expect(serialized).not.toContain("sessionId");
    expect(serialized).not.toContain(sessionA);
    expect(serialized).not.toContain("workspace");
    expect(serialized).not.toContain("operation");
    expect(serialized).not.toContain("theater");
  });
});
