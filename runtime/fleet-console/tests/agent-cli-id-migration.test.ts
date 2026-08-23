import { describe, expect, it } from "vitest";

import { sanitizeDurableConsoleState } from "../core/host/durable-state.js";

const baseOperation = {
  id: "op",
  theaterId: "theater",
  type: "agent",
  pluginId: "terminal",
  title: "Agent",
  geometry: null,
  ts: { createdAt: 1, updatedAt: 2 },
};

describe("Agent session durable migration", () => {
  it("moves v3 CLI and launch coordinates into one session object", () => {
    const state = sanitizeDurableConsoleState({
      version: 3,
      theaters: [],
      operations: [{
        ...baseOperation,
        payload: {
          cwd: "/work",
          cliId: "claude-gateway",
          launchKindId: "claude-gateway",
          cliLabel: "Claude (Gateway)",
          launchProvider: "codex",
          launchModel: "codex--gpt-5.6-sol",
          launchEffort: "medium",
          providerSession: {
            provider: "claude-gateway",
            sessionId: "provider-session",
            transcriptPath: "/secret/transcript.jsonl",
            capturedAt: "2026-08-23T00:00:00.000Z",
          },
        },
      }],
      groups: [],
      deletionTombstones: [],
    });

    expect(state.version).toBe(4);
    expect(state.operations[0]?.payload).toEqual({
      cwd: "/work",
      session: {
        harness: "claude-code",
        model: "codex--gpt-5.6-sol",
        effort: "medium",
        id: "provider-session",
        transcriptPath: "/secret/transcript.jsonl",
        capturedAt: "2026-08-23T00:00:00.000Z",
      },
    });
  });

  it("keeps legacy Codex captures analysis-only instead of making them resumable by Claude Code", () => {
    const state = sanitizeDurableConsoleState({
      version: 3,
      theaters: [],
      operations: [{
        ...baseOperation,
        payload: {
          launchModel: "codex--gpt-5.6-sol",
          providerSession: {
            provider: "codex",
            sessionId: "codex-session",
            transcriptPath: "/secret/codex.jsonl",
            capturedAt: "2026-08-23T00:00:00.000Z",
          },
        },
      }],
      groups: [],
      deletionTombstones: [],
    });

    expect(state.operations[0]?.payload.session).toEqual({
      harness: "codex",
      model: "codex--gpt-5.6-sol",
      id: "codex-session",
      transcriptPath: "/secret/codex.jsonl",
      capturedAt: "2026-08-23T00:00:00.000Z",
    });
  });

  it("migrates live and tombstoned Operations and is idempotent", () => {
    const legacy = {
      ...baseOperation,
      payload: { cliId: "claude-gateway", launchModel: "opus[1m]" },
    };
    const once = sanitizeDurableConsoleState({
      version: 3,
      theaters: [],
      operations: [legacy],
      groups: [],
      deletionTombstones: [{
        deletionId: "d",
        targetId: "op",
        deletedAt: 1,
        expiresAt: 2,
        kind: "operation",
        operation: legacy,
      }],
    });
    const twice = sanitizeDurableConsoleState(once);

    expect(twice).toEqual(once);
    expect(once.operations[0]?.payload).toEqual({ session: { harness: "claude-code", model: "opus[1m]" } });
    expect(once.deletionTombstones?.[0]).toMatchObject({
      kind: "operation",
      operation: { payload: { session: { harness: "claude-code", model: "opus[1m]" } } },
    });
  });
});
