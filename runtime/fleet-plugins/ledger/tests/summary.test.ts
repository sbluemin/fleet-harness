import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { OperationNode } from "@fleet-console/sdk/operations";
import { describe, expect, it } from "vitest";

import { parseTokscaleOutput } from "../server/parser.js";
import { buildSummary } from "../server/summary.js";

const fixture = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "tokscale-report.json"), "utf8");
const sessions = parseTokscaleOutput(fixture).sessions;

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
    const scoped = buildSummary(sessions, operations, { theaterId: "theater-a", window: "week" });
    const all = buildSummary(sessions, operations, { theaterId: null, window: "week" });
    expect(scoped.clients).toEqual(all.clients);
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
    ], { theaterId: null, window: "week" });
    expect(dto.source).toMatchObject({ status: "unreadable", skippedSessions: 2 });
    expect(dto.totals).toEqual({ costUsd: 0, input: 0, output: 0, cacheRead: 0, messages: 0 });
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
