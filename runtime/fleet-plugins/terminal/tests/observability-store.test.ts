import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { sessionActivity } from "../client/agent/connection.js";
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
      createdAt: 1_000,
      session: {
        harness: "claude-code",
        id: "provider-session-secret",
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
});

describe("agent activity observability state", () => {
  function createStore() {
    const store = createConsoleObservabilityStore({ workspaceHash: () => "theater-a" });
    store.createPendingTerminalSession({ sessionId: "session-a", cwd: "/workspace/project", cliId: "claude", createdAt: 1_000 });
    return store;
  }

  it("preserves attentionPending across transitionTerminalSessionToDormant", () => {
    const store = createStore();
    store.setTerminalSessionModelActivity("session-a", "not-working");
    store.notifySessionAttention(store.getTerminalSessionInfo("session-a")!, "permission_prompt");
    expect(store.getTerminalSessionInfo("session-a")).toMatchObject({ attentionPending: true });

    const dormant = store.transitionTerminalSessionToDormant("session-a", {
      harness: "claude-code",
      id: "provider-session",
      capturedAt: "2026-07-25T00:00:00.000Z",
    });
    expect(dormant).toMatchObject({ status: "dormant", attentionPending: true });
    expect(store.getTerminalSessionInfo("session-a")).toMatchObject({ attentionPending: true });
  });
});
