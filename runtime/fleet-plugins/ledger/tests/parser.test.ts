import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTokscaleModelsOutput, parseTokscaleOutput } from "../server/parser.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const reportFixture = fs.readFileSync(path.join(fixturesDir, "tokscale-report.json"), "utf8");
const modelsFixture = fs.readFileSync(path.join(fixturesDir, "tokscale-models.json"), "utf8");
const sessionId = "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103";

function modelEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client: "claude",
    sessionId,
    model: "claude-opus-5",
    input: 10,
    output: 2,
    cacheRead: 3,
    cacheWrite: 0,
    cost: 1.25,
    messageCount: 4,
    ...overrides,
  };
}

describe("parseTokscaleOutput", () => {
  it("reads only canonical session and date metadata", () => {
    const result = parseTokscaleOutput(reportFixture);
    expect(result).toEqual({
      status: "degraded",
      sessions: [{ sessionId, lastActive: 1_750_000_300_000 }],
      skippedSessions: 2,
    });
    expect(JSON.stringify(result)).not.toContain("total_cost");
    expect(JSON.stringify(result)).not.toContain("workspace");
  });

  it("canonicalizes uppercase UUIDs", () => {
    const result = parseTokscaleOutput(JSON.stringify([{
      session_id: sessionId.toUpperCase(),
      last_active: 1_750_000_300_000,
    }]));
    expect(result).toEqual({
      status: "ok",
      sessions: [{ sessionId, lastActive: 1_750_000_300_000 }],
      skippedSessions: 0,
    });
  });

  it.each([
    ["malformed UUID", { session_id: "rollout-prefix", last_active: 1_750_000_300_000 }],
    ["fractional timestamp", { session_id: sessionId, last_active: 1.5 }],
    ["unsafe timestamp", { session_id: sessionId, last_active: Number.MAX_SAFE_INTEGER }],
  ])("rejects %s", (_label, row) => {
    expect(parseTokscaleOutput(JSON.stringify([row]))).toEqual({
      status: "unreadable",
      sessions: [],
      skippedSessions: 1,
    });
  });

  it("degrades one bad row while retaining valid metadata", () => {
    const result = parseTokscaleOutput(JSON.stringify([
      { session_id: sessionId, last_active: 1_750_000_300_000 },
      { session_id: "bad", last_active: 1_750_000_300_000 },
    ]));
    expect(result.status).toBe("degraded");
    expect(result.sessions).toEqual([{ sessionId, lastActive: 1_750_000_300_000 }]);
    expect(result.skippedSessions).toBe(1);
  });

  it("marks malformed JSON and non-array output unreadable", () => {
    expect(parseTokscaleOutput("{broken")).toEqual({ status: "unreadable", sessions: [], skippedSessions: 0 });
    expect(parseTokscaleOutput("{}")).toEqual({ status: "unreadable", sessions: [], skippedSessions: 0 });
  });
});

describe("parseTokscaleModelsOutput", () => {
  it("reads measured client,session,model rows and canonicalizes session ids", () => {
    const result = parseTokscaleModelsOutput(modelsFixture);
    expect(result.status).toBe("ok");
    expect(result.entries).toEqual([
      {
        sessionId,
        modelId: "claude-gateway--cursor--claude-opus-5",
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: 5.5,
        messages: 3,
      },
      {
        sessionId,
        modelId: "claude-opus-5",
        input: 4,
        output: 1,
        cacheRead: 2,
        cacheWrite: 0,
        costUsd: 1.25,
        messages: 8,
      },
      {
        sessionId: "40bf2ab7-5a5d-4a8c-8aaa-730a40ecf104",
        modelId: "claude-gateway--xai--grok-4.6",
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: 0,
        messages: 292,
      },
    ]);
  });

  it("keeps valid gateway rows for semantic filtering without degrading the source", () => {
    const result = parseTokscaleModelsOutput(JSON.stringify({
      entries: [modelEntry({ model: "claude-gateway--codex--gpt-5.6-sol" })],
    }));
    expect(result.status).toBe("ok");
    expect(result.entries[0]?.modelId).toBe("claude-gateway--codex--gpt-5.6-sol");
  });

  it("requires the measured Claude Code client on every row", () => {
    const result = parseTokscaleModelsOutput(JSON.stringify({
      entries: [modelEntry({ client: undefined })],
    }));
    expect(result).toEqual({ status: "unreadable", entries: [], skippedEntries: 1 });
  });

  it("keeps zero-cost rows and a 1M context marker", () => {
    const result = parseTokscaleModelsOutput(JSON.stringify({
      entries: [modelEntry({ model: "claude-opus-5[1M]", cost: 0, messageCount: 12 })],
    }));
    expect(result.status).toBe("ok");
    expect(result.entries[0]).toMatchObject({ modelId: "claude-opus-5[1M]", costUsd: 0, messages: 12 });
  });

  it.each([
    ["missing session", { sessionId: undefined }],
    ["wrong source client", { client: "codex" }],
    ["absolute model path", { model: "/Users/private/model" }],
    ["traversal model", { model: "../../transcript" }],
    ["UUID model", { model: sessionId }],
    ["negative cost", { cost: -1 }],
    ["fractional messages", { messageCount: 1.5 }],
    ["unsafe token count", { input: Number.MAX_SAFE_INTEGER + 1 }],
  ])("rejects %s", (_label, overrides) => {
    const result = parseTokscaleModelsOutput(JSON.stringify({
      entries: [modelEntry(overrides), modelEntry({ model: "claude-sonnet-5" })],
    }));
    expect(result.status).toBe("degraded");
    expect(result.entries).toHaveLength(1);
    expect(result.skippedEntries).toBe(1);
  });

  it("marks a report array and wholly incompatible entries unreadable", () => {
    expect(parseTokscaleModelsOutput(reportFixture).status).toBe("unreadable");
    expect(parseTokscaleModelsOutput(JSON.stringify({ entries: [{ model: "only-one-field" }] }))).toEqual({
      status: "unreadable",
      entries: [],
      skippedEntries: 1,
    });
  });
});
