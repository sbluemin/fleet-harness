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
});

describe("source integrity and DTO boundaries", () => {

  it("fails closed on aggregate overflow without serializing non-finite cost", () => {
    const dto = buildSummary([], { window: "week" }, "ok", 123, 0, breakdown([
      entry({ costUsd: Number.MAX_VALUE }),
      entry({ sessionId: sessionB, costUsd: Number.MAX_VALUE }),
    ]));
    expect(dto.totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, messages: 0 });
    expect(dto.source).toMatchObject({ status: "unreadable", models: "unreadable", skippedEntries: 2 });
    expect(JSON.stringify(dto)).not.toContain('"costUsd":null');
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
