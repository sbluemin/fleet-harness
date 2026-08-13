import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { OperationNode } from "@fleet-console/sdk/operations";
import { describe, expect, it } from "vitest";

import { parseTokscaleOutput } from "../server/parser.js";
import { buildSummary, localDayKey } from "../server/summary.js";

const fixture = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "tokscale-report.json"), "utf8");
const sessions = parseTokscaleOutput(fixture).sessions;

function shiftLocalDate(atMs: number, days: number): number {
  const date = new Date(atMs);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

function operation(
  id: string,
  theaterId: string,
  provider: "claude" | "codex",
  sessionId: string,
  updatedAt: number,
): OperationNode {
  return {
    id,
    theaterId,
    pluginId: "terminal",
    type: "agent",
    title: `Operation ${id}`,
    payload: {
      cliId: provider,
      cliLabel: provider === "claude" ? "Claude Code" : "Codex",
      providerSession: { provider, sessionId, capturedAt: "2026-07-26T00:00:00Z" },
    },
    geometry: null,
    ts: { createdAt: updatedAt - 1, updatedAt },
  };
}

describe("buildSummary matching", () => {
  it("matches claude directly and extracts the UUID suffix from codex rollouts", () => {
    const dto = buildSummary(sessions, [
      operation("claude-op", "theater-a", "claude", "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103", 10),
      operation("codex-op", "theater-a", "codex", "019f9ab4-7d11-7000-8000-123456789abc", 20),
    ], { theaterId: null, window: "week" });
    expect(dto.operations.map((entry) => entry.operationId).sort()).toEqual(["claude-op", "codex-op"]);
    expect(dto.clients).toHaveLength(3);
    expect(dto.clients.find((entry) => entry.client === "opencode")).toEqual({
      client: "opencode",
      sessions: 1,
      usage: { input: 1_000, output: 200, cacheRead: 0 },
      costUsd: 0.05,
    });
  });

  it("includes every session in device-wide client totals without requiring an Operation claim", () => {
    const dto = buildSummary(sessions, [], { theaterId: null, window: "week" });
    expect(dto.operations).toEqual([]);
    expect(dto.clients.map((entry) => entry.client)).toEqual(["claude", "codex", "opencode"]);
  });

  it("merges session costs from the same local day into one daily point", () => {
    const morning = new Date(2026, 6, 15, 8).getTime();
    const evening = new Date(2026, 6, 15, 20).getTime();
    const dto = buildSummary([
      { ...sessions[0]!, lastActive: morning, costUsd: 1.25 },
      { ...sessions[1]!, lastActive: evening, costUsd: 2.75 },
    ], [], { theaterId: null, window: "today" }, "ok", evening);

    expect(localDayKey(morning)).toBe("2026-07-15");
    expect(dto.daily).toEqual([{ day: localDayKey(evening), costUsd: 4 }]);
  });

  it("fills a week through its final generated day when only that day has a session", () => {
    const generatedAtMs = new Date(2026, 6, 31, 12).getTime();
    const firstDay = shiftLocalDate(generatedAtMs, -6);
    const dto = buildSummary([
      { ...sessions[0]!, lastActive: generatedAtMs, costUsd: 7 },
    ], [], { theaterId: null, window: "week" }, "ok", generatedAtMs);

    expect(dto.daily).toEqual(Array.from({ length: 7 }, (_, index) => ({
      day: localDayKey(shiftLocalDate(firstDay, index)),
      costUsd: index === 6 ? 7 : 0,
    })));
  });

  it("fills a month from its first local day through the generated day", () => {
    const generatedAtMs = new Date(2026, 6, 15, 12).getTime();
    const firstDay = new Date(generatedAtMs);
    firstDay.setDate(1);
    const dto = buildSummary([
      { ...sessions[0]!, lastActive: generatedAtMs, costUsd: 5 },
    ], [], { theaterId: null, window: "month" }, "ok", generatedAtMs);

    expect(dto.daily).toEqual(Array.from({ length: 15 }, (_, index) => ({
      day: localDayKey(shiftLocalDate(firstDay.getTime(), index)),
      costUsd: index === 14 ? 5 : 0,
    })));
  });

  it("preserves an observed day earlier than the derived window start", () => {
    const generatedAtMs = new Date(2026, 6, 31, 12).getTime();
    const observedAtMs = shiftLocalDate(generatedAtMs, -8);
    const dto = buildSummary([
      { ...sessions[0]!, lastActive: observedAtMs, costUsd: 4 },
    ], [], { theaterId: null, window: "week" }, "ok", generatedAtMs);

    expect(dto.daily).toEqual(Array.from({ length: 9 }, (_, index) => ({
      day: localDayKey(shiftLocalDate(observedAtMs, index)),
      costUsd: index === 0 ? 4 : 0,
    })));
  });

  it("fills an interior local-day gap with a zero-cost point in ascending order", () => {
    const earlier = new Date(2026, 6, 14, 12).getTime();
    const middle = shiftLocalDate(earlier, 1);
    const later = shiftLocalDate(earlier, 2);
    const dto = buildSummary([
      { ...sessions[0]!, lastActive: later, costUsd: 3 },
      { ...sessions[1]!, lastActive: earlier, costUsd: 1 },
    ], [], { theaterId: null, window: "today" }, "ok", later);

    expect(dto.daily).toEqual([
      { day: localDayKey(earlier), costUsd: 1 },
      { day: localDayKey(middle), costUsd: 0 },
      { day: localDayKey(later), costUsd: 3 },
    ]);
  });

  it("keeps adjacent local days without inserting extra points", () => {
    const first = new Date(2026, 6, 14, 12).getTime();
    const second = shiftLocalDate(first, 1);
    const dto = buildSummary([
      { ...sessions[0]!, lastActive: second, costUsd: 3 },
      { ...sessions[1]!, lastActive: first, costUsd: 1 },
    ], [], { theaterId: null, window: "today" }, "ok", second);

    expect(dto.daily).toEqual([
      { day: localDayKey(first), costUsd: 1 },
      { day: localDayKey(second), costUsd: 3 },
    ]);
  });

  it("clips spans over 366 local days before filling the most recent contiguous run", () => {
    const latest = new Date(2026, 6, 15, 12).getTime();
    const cutoff = shiftLocalDate(latest, -365);
    const stale = shiftLocalDate(latest, -400);
    const dto = buildSummary([
      { ...sessions[0]!, lastActive: stale, costUsd: 1 },
      { ...sessions[1]!, lastActive: cutoff, costUsd: 2 },
      { ...sessions[2]!, lastActive: latest, costUsd: 3 },
    ], [], { theaterId: null, window: "today" }, "ok", latest);

    expect(dto.daily).toHaveLength(366);
    expect(dto.daily[0]).toEqual({ day: localDayKey(cutoff), costUsd: 2 });
    expect(dto.daily[1]).toEqual({ day: localDayKey(shiftLocalDate(cutoff, 1)), costUsd: 0 });
    expect(dto.daily.at(-1)).toEqual({ day: localDayKey(latest), costUsd: 3 });
    expect(dto.daily.some((point) => point.day === localDayKey(stale))).toBe(false);
  });

  it("returns no daily points for an empty session set instead of a derived all-zero window", () => {
    const generatedAtMs = new Date(2026, 6, 31, 12).getTime();
    expect(buildSummary([], [], { theaterId: null, window: "week" }, "ok", generatedAtMs).daily).toEqual([]);
  });

  it("fails closed when daily cost accumulation overflows", () => {
    const lastActive = new Date(2026, 6, 15, 12).getTime();
    const dto = buildSummary([
      { ...sessions[0]!, lastActive, costUsd: Number.MAX_VALUE },
      { ...sessions[1]!, lastActive, costUsd: Number.MAX_VALUE },
    ], [], { theaterId: null, window: "today" }, "ok", lastActive);

    expect(dto).toMatchObject({
      totals: { costUsd: 0, input: 0, output: 0, cacheRead: 0, messages: 0 },
      operations: [],
      clients: [],
      daily: [],
      source: { status: "unreadable", skippedSessions: 2 },
    });
  });

  it("aggregates linked and unclaimed sessions together in the same client total", () => {
    const unclaimed = {
      ...sessions[0]!,
      sessionId: "not-a-canonical-uuid",
      input: 10,
      output: 20,
      cacheRead: 30,
      costUsd: 0.25,
    };
    const dto = buildSummary([sessions[0]!, unclaimed], [
      operation("claimed", "theater-a", "claude", sessions[0]!.sessionId, 1),
    ], { theaterId: "theater-a", window: "week" });
    expect(dto.operations).toHaveLength(1);
    expect(dto.clients).toEqual([{
      client: "claude",
      sessions: 2,
      usage: { input: 1_200_010, output: 42_020, cacheRead: 900_030 },
      costUsd: 2.5,
    }]);
  });

  it("assigns a duplicated claim only to the most recently active Operation", () => {
    const sessionId = "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103";
    const dto = buildSummary([sessions[0]!], [
      operation("older", "theater-a", "claude", sessionId, 100),
      operation("newer", "theater-a", "claude", sessionId, 200),
    ], { theaterId: null, window: "week" });
    expect(dto.operations).toHaveLength(1);
    expect(dto.operations[0]?.operationId).toBe("newer");
    expect(dto.totals.costUsd).toBe(2.25);
  });

  it("filters claim candidates by theater when theaterId is present", () => {
    const operations = [
      operation("a", "theater-a", "claude", "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103", 100),
      operation("b", "theater-b", "codex", "019f9ab4-7d11-7000-8000-123456789abc", 200),
    ];
    expect(buildSummary(sessions, operations, { theaterId: "theater-a", window: "week" }).operations.map((entry) => entry.operationId)).toEqual(["a"]);
    expect(buildSummary(sessions, operations, { theaterId: null, window: "week" }).operations.map((entry) => entry.operationId).sort()).toEqual(["a", "b"]);
  });

  it("keeps all-session client totals device-wide when operations are filtered to one theater", () => {
    const operations = [
      operation("a", "theater-a", "claude", "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103", 100),
      operation("b", "theater-b", "codex", "019f9ab4-7d11-7000-8000-123456789abc", 200),
    ];
    const generatedAtMs = Math.max(...sessions.map((session) => session.lastActive));
    const scoped = buildSummary(sessions, operations, { theaterId: "theater-a", window: "week" }, "ok", generatedAtMs);
    const all = buildSummary(sessions, operations, { theaterId: null, window: "week" }, "ok", generatedAtMs);
    expect(scoped.clients).toEqual(all.clients);
    expect(scoped.daily).toEqual(all.daily);
    expect(scoped.clients).toEqual([
      { client: "claude", sessions: 1, usage: { input: 1_200_000, output: 42_000, cacheRead: 900_000 }, costUsd: 2.25 },
      { client: "codex", sessions: 1, usage: { input: 800_000, output: 30_000, cacheRead: 100_000 }, costUsd: 1.75 },
      { client: "opencode", sessions: 1, usage: { input: 1_000, output: 200, cacheRead: 0 }, costUsd: 0.05 },
    ]);
  });

  it("makes totals exactly equal the sum of the response operations", () => {
    const dto = buildSummary(sessions, [
      operation("a", "theater-a", "claude", "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103", 100),
      operation("b", "theater-b", "codex", "019f9ab4-7d11-7000-8000-123456789abc", 200),
    ], { theaterId: null, window: "week" });
    const summed = dto.operations.reduce((total, operationDto) => ({
      costUsd: total.costUsd + operationDto.costUsd,
      input: total.input + operationDto.usage.input,
      output: total.output + operationDto.usage.output,
      cacheRead: total.cacheRead + operationDto.usage.cacheRead,
      messages: total.messages + operationDto.messages,
    }), { costUsd: 0, input: 0, output: 0, cacheRead: 0, messages: 0 });
    expect(dto.totals).toEqual(summed);
    expect(dto.operations.map((entry) => entry.usage.input + entry.usage.output + entry.usage.cacheRead).sort((a, b) => b - a))
      .toEqual([2_142_000, 930_000]);
  });

  it("limits totals to the selected Theater operations without adding device-wide client usage", () => {
    const dto = buildSummary(sessions, [
      operation("a", "theater-a", "claude", "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103", 100),
      operation("b", "theater-b", "codex", "019f9ab4-7d11-7000-8000-123456789abc", 200),
    ], { theaterId: "theater-a", window: "week" });
    expect(dto.totals).toEqual({
      costUsd: 2.25,
      input: 1_200_000,
      output: 42_000,
      cacheRead: 900_000,
      messages: 12,
    });
    expect(dto.clients.reduce((cost, entry) => cost + entry.costUsd, 0)).toBe(4.05);
  });

  it("keeps zero Operation totals and populated device-wide client data when no operations match", () => {
    const dto = buildSummary(sessions, [], { theaterId: "theater-a", window: "week" });
    expect(dto.operations).toEqual([]);
    expect(dto.totals).toEqual({ costUsd: 0, input: 0, output: 0, cacheRead: 0, messages: 0 });
    expect(dto.clients).toHaveLength(3);
    expect(dto.clients.reduce((totals, entry) => ({
      sessions: totals.sessions + entry.sessions,
      costUsd: totals.costUsd + entry.costUsd,
      tokens: totals.tokens + entry.usage.input + entry.usage.output + entry.usage.cacheRead,
    }), { sessions: 0, costUsd: 0, tokens: 0 })).toEqual({
      sessions: 3,
      costUsd: 4.05,
      tokens: 3_073_200,
    });
  });

  it("does not match malformed claude or codex session ids", () => {
    const malformed = [
      { ...sessions[0]!, sessionId: "not-a-canonical-uuid" },
      { ...sessions[1]!, sessionId: "garbage-prefix-019f9ab4-7d11-7000-8000-123456789abc" },
    ];
    const dto = buildSummary(malformed, [
      operation("claude", "theater-a", "claude", "not-a-canonical-uuid", 1),
      operation("codex", "theater-a", "codex", "019f9ab4-7d11-7000-8000-123456789abc", 1),
    ], { theaterId: null, window: "week" });
    expect(dto.operations).toEqual([]);
    expect(dto.clients.reduce((count, entry) => count + entry.sessions, 0)).toBe(2);
  });

  it("matches canonical UUIDs case-insensitively", () => {
    const dto = buildSummary([{ ...sessions[0]!, sessionId: "30BF2AB7-5A5D-4A8C-8AAA-730A40ECF103" }], [
      operation("claude", "theater-a", "claude", "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103", 1),
    ], { theaterId: null, window: "week" });
    expect(dto.operations[0]?.operationId).toBe("claude");
  });

  it("breaks equal updatedAt claims deterministically by Operation id", () => {
    const sessionId = "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103";
    const claims = [
      operation("z-operation", "theater-a", "claude", sessionId, 100),
      operation("a-operation", "theater-a", "claude", sessionId, 100),
    ];
    expect(buildSummary([sessions[0]!], claims, { theaterId: null, window: "week" }).operations[0]?.operationId).toBe("a-operation");
    expect(buildSummary([sessions[0]!], [...claims].reverse(), { theaterId: null, window: "week" }).operations[0]?.operationId).toBe("a-operation");
  });

  it("ignores Operations without a providerSession", () => {
    const withoutProvider = {
      ...operation("missing", "theater-a", "claude", "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103", 1),
      payload: { cliId: "claude", cliLabel: "Claude Code" },
    };
    const dto = buildSummary([sessions[0]!], [withoutProvider], { theaterId: null, window: "week" });
    expect(dto.operations).toEqual([]);
    expect(dto.clients[0]?.sessions).toBe(1);
  });

  it("fails closed when aggregate cost overflows", () => {
    const secondSessionId = "40bf2ab7-5a5d-4a8c-8aaa-730a40ecf104";
    const overflowSessions = [
      { ...sessions[0]!, costUsd: Number.MAX_VALUE },
      { ...sessions[0]!, sessionId: secondSessionId, costUsd: Number.MAX_VALUE },
    ];
    const dto = buildSummary(overflowSessions, [
      operation("first", "theater-a", "claude", sessions[0]!.sessionId, 1),
      operation("second", "theater-a", "claude", secondSessionId, 1),
    ], { theaterId: null, window: "week" }, "ok", Math.max(...overflowSessions.map((session) => session.lastActive)));
    expect(dto.source).toMatchObject({ status: "unreadable", skippedSessions: 2 });
    expect(dto.totals).toEqual({ costUsd: 0, input: 0, output: 0, cacheRead: 0, messages: 0 });
    expect(dto.daily).toEqual([]);
    expect(JSON.stringify(dto)).not.toContain('"costUsd":null');
  });

  it("allowlists the DTO and never serializes native session ids or paths", () => {
    const dto = buildSummary(sessions, [
      operation("claude-op", "theater-a", "claude", "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103", 10),
    ], { theaterId: null, window: "week" });
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain("session_id");
    expect(serialized).not.toContain("sessionId");
    expect(serialized).not.toContain("/Users/example/project");
    expect(serialized).not.toContain("workspace_label");
  });
});

describe("buildSummary coverage", () => {
  it("reports device-wide totals across every session regardless of operation claims or theater scope", () => {
    const dto = buildSummary(sessions, [
      operation("a", "theater-a", "claude", "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103", 100),
    ], { theaterId: "theater-a", window: "week" });
    expect(dto.totals.costUsd).toBe(2.25);
    expect(dto.deviceTotals).toEqual({
      input: 2_001_000,
      output: 72_200,
      cacheRead: 1_000_000,
      costUsd: 4.05,
      messages: 22,
      sessions: 3,
    });
  });

  it("lists claimed operations with no matched session as unmatched, scoped by theater", () => {
    const dto = buildSummary(sessions, [
      operation("matched", "theater-a", "claude", "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103", 100),
      operation("ghost", "theater-a", "claude", "00000000-0000-4000-8000-000000000000", 200),
      operation("other-theater", "theater-b", "claude", "11111111-1111-4111-8111-111111111111", 300),
    ], { theaterId: "theater-a", window: "week" });
    expect(dto.operations.map((entry) => entry.operationId)).toEqual(["matched"]);
    expect(dto.unmatched).toEqual([{
      operationId: "ghost",
      title: "Operation ghost",
      cliId: "claude",
      cliLabel: "Claude Code",
      lastActivityAtMs: 200,
    }]);
    expect(dto.unmatchedTotal).toBe(1);
  });

  it("caps the serialized unmatched list while unmatchedTotal keeps the full count", () => {
    const ghosts = Array.from({ length: 60 }, (_, index) => operation(
      `ghost-${index}`,
      "theater-a",
      "claude",
      `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      index,
    ));
    const dto = buildSummary([], ghosts, { theaterId: "theater-a", window: "week" });
    expect(dto.unmatched).toHaveLength(50);
    expect(dto.unmatchedTotal).toBe(60);
    expect(dto.unmatched[0]?.operationId).toBe("ghost-59");
  });

  it("keeps other-theater Console attribution out of both operations and unmatched but counts it in otherTheaterTotals", () => {
    const operations = [
      operation("a", "theater-a", "claude", "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103", 100),
      operation("b", "theater-b", "codex", "019f9ab4-7d11-7000-8000-123456789abc", 200),
    ];
    const scoped = buildSummary(sessions, operations, { theaterId: "theater-a", window: "week" });
    expect(scoped.operations.map((entry) => entry.operationId)).toEqual(["a"]);
    expect(scoped.unmatched).toEqual([]);
    expect(scoped.otherTheaterTotals).toEqual({ costUsd: 1.75, input: 800_000, output: 30_000, cacheRead: 100_000, messages: 8 });
    expect(scoped.deviceTotals.costUsd).toBe(4.05);

    const all = buildSummary(sessions, operations, { theaterId: null, window: "week" });
    expect(all.otherTheaterTotals).toEqual({ costUsd: 0, input: 0, output: 0, cacheRead: 0, messages: 0 });
  });

  it("excludes operations without a claim and losing duplicate claims from unmatched", () => {
    const withoutSession: OperationNode = {
      ...operation("no-session", "theater-a", "claude", "ignored", 100),
      payload: { cliId: "claude", cliLabel: "Claude Code" },
    };
    const sessionId = "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103";
    const dto = buildSummary([sessions[0]!], [
      operation("older", "theater-a", "claude", sessionId, 100),
      operation("newer", "theater-a", "claude", sessionId, 200),
      withoutSession,
    ], { theaterId: null, window: "week" });
    expect(dto.operations.map((entry) => entry.operationId)).toEqual(["newer"]);
    expect(dto.unmatched).toEqual([]);
  });

  it("keeps unmatched empty and deviceTotals zeroed in the overflow fallback", () => {
    const lastActive = new Date(2026, 6, 15, 12).getTime();
    const dto = buildSummary([
      { ...sessions[0]!, lastActive, costUsd: Number.MAX_VALUE },
      { ...sessions[1]!, lastActive, costUsd: Number.MAX_VALUE },
    ], [], { theaterId: null, window: "today" }, "ok", lastActive);
    expect(dto.unmatched).toEqual([]);
    expect(dto.unmatchedTotal).toBe(0);
    expect(dto.otherTheaterTotals).toEqual({ costUsd: 0, input: 0, output: 0, cacheRead: 0, messages: 0 });
    expect(dto.deviceTotals).toEqual({ costUsd: 0, input: 0, output: 0, cacheRead: 0, messages: 0, sessions: 0 });
  });
});
