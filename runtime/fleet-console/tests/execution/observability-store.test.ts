import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { sessionActivity } from "../../core/client/src/agent/connection.js";
import { createConsoleObservabilityStore } from "../../core/host/agent/observability-store.js";
import { projectWorkspace } from "../../core/host/agent/workspace-context.js";

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

  it("projects the Operation location as Theater-relative folder and branch, never an absolute path", () => {
    const root = path.join(os.tmpdir(), "fleet-theater-root");
    expect(projectWorkspace({ cwd: root, theaterRoot: root, branch: "canary" })).toEqual({ folder: null, outside: false, branch: "canary" });
    expect(projectWorkspace({ cwd: path.join(root, "runtime", "fleet-console"), theaterRoot: root, branch: "canary" }))
      .toEqual({ folder: "runtime/fleet-console", outside: false, branch: "canary" });
    // Theater 밖은 basename 하나만 남는다 — 사용자의 다른 디렉터리 구조가 브라우저로 새지 않는다.
    const outside = projectWorkspace({ cwd: path.join(os.tmpdir(), "elsewhere", "secret-project"), theaterRoot: root, branch: null });
    expect(outside).toEqual({ folder: "secret-project", outside: true, branch: null });
    expect(JSON.stringify(outside)).not.toContain(os.tmpdir());

    const store = createConsoleObservabilityStore({ workspaceHash: () => "theater-a" });
    store.createPendingTerminalSession({ sessionId: "session-a", cwd: path.join(root, "runtime"), cliId: "claude", createdAt: 1_000 });
    expect(store.getTerminalSessionInfo("session-a")).not.toHaveProperty("workspace");
    const withWorkspace = store.setTerminalSessionWorkspace("session-a", { folder: "runtime", outside: false, branch: "canary" });
    expect(withWorkspace).toMatchObject({ workspace: { folder: "runtime", branch: "canary" } });
    expect(JSON.stringify(withWorkspace)).not.toContain(root);
    // 옵트인을 끄면 축이 DTO에서 사라진다 — 꺼진 Console은 위치를 말하지 않는다.
    expect(store.setTerminalSessionWorkspace("session-a", null)).not.toHaveProperty("workspace");
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
