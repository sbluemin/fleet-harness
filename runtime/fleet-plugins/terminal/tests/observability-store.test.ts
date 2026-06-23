import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createConsoleObservabilityStore } from "../server/agent-api/observability-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("agent observability DTO boundary", () => {
  it("does not expose cwd, provider session, transcript, or token material in browser session DTOs", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-agent-store-"));
    tempDirs.push(cwd);
    const store = createConsoleObservabilityStore({
      canonicalizeTheaterPath: (value) => fs.realpathSync.native(value),
      workspaceHash: () => "theater-a",
    });

    const session = store.injectDormantOperation({
      sessionId: "session-a",
      theaterId: "theater-a",
      cwd,
      cwdLabel: path.basename(cwd),
      sequence: 1,
      cliId: "claude",
      cliLabel: "Claude",
      createdAt: 1_000,
      providerSession: {
        provider: "claude",
        sessionId: "provider-session-secret",
        transcriptPath: "/secret/transcript.jsonl",
        source: "startup",
        capturedAt: "2026-06-16T00:00:00.000Z",
      },
    });
    const serialized = JSON.stringify({ session, sessions: store.listTerminalSessions() });

    expect(session.resumeAvailable).toBe(true);
    expect(serialized).not.toContain(cwd);
    expect(serialized).not.toContain("provider-session-secret");
    expect(serialized).not.toContain("transcript");
    expect(serialized).not.toContain("providerSession");
    expect(serialized).not.toContain("token");
  });

  it("sanitizes carrier stream events before observer snapshots and SSE frames", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-agent-events-"));
    tempDirs.push(cwd);
    const store = createConsoleObservabilityStore({
      canonicalizeTheaterPath: (value) => fs.realpathSync.native(value),
      workspaceHash: () => "theater-a",
    });
    store.createPendingTerminalSession({ sessionId: "session-a", cwd, cliId: "claude", createdAt: 1_000 });
    store.registerTerminalRuntimeSession({ sessionId: "session-a", label: "Claude", mcpToolCount: 3 });

    const liveFrames: unknown[] = [];
    store.subscribeAll((event) => liveFrames.push(event));
    store.appendTerminalRuntimeEvent("session-a", {
      type: "job:finalized",
      jobId: "job-a",
      status: "done",
      summary: "ok",
      systemReminder: "secret reminder",
      providerSession: "provider-session-secret",
      transcriptPath: "/secret/transcript.jsonl",
      ticket: "terminal-ticket-secret",
      token: "mcp-token-secret",
      prompt: "private prompt",
    }, 2_000);
    const serialized = JSON.stringify({ jobs: store.listJobs("session-a"), events: store.listEvents("session-a"), liveFrames });

    expect(serialized).toContain("job-a");
    expect(serialized).not.toContain("secret reminder");
    expect(serialized).not.toContain("provider-session-secret");
    expect(serialized).not.toContain("transcript");
    expect(serialized).not.toContain("terminal-ticket-secret");
    expect(serialized).not.toContain("mcp-token-secret");
    expect(serialized).not.toContain("private prompt");
  });

  it("assigns globally monotonic observed ids across terminal sessions", () => {
    const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-agent-a-"));
    const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-agent-b-"));
    tempDirs.push(cwdA, cwdB);
    const store = createConsoleObservabilityStore({
      canonicalizeTheaterPath: (value) => fs.realpathSync.native(value),
      workspaceHash: (canonical) => path.basename(canonical),
    });
    store.createPendingTerminalSession({ sessionId: "session-a", cwd: cwdA, createdAt: 1_000 });
    store.createPendingTerminalSession({ sessionId: "session-b", cwd: cwdB, createdAt: 1_000 });
    store.registerTerminalRuntimeSession({ sessionId: "session-a", label: "A", mcpToolCount: 0 });
    store.registerTerminalRuntimeSession({ sessionId: "session-b", label: "B", mcpToolCount: 0 });

    const a = store.appendTerminalRuntimeEvent("session-a", { type: "track:text", jobId: "job-a", trackId: "t1", text: "a" });
    const b = store.appendTerminalRuntimeEvent("session-b", { type: "track:text", jobId: "job-b", trackId: "t1", text: "b" });

    expect(a?.id).toBe(1);
    expect(b?.id).toBe(2);
  });
});
