import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { sessionActivity } from "../../features/execution/client/agent/connection.js";
import { createConsoleObservabilityStore } from "../../features/execution/host/agent/observability-store.js";
import { createLaunchConfiguration } from "../../features/execution/host/agent/launch-fingerprint.js";
import { projectWorkspace } from "../../features/execution/host/agent/workspace-context.js";
import { createWorkspaceHookRegistry } from "../../features/execution/host/agent/workspace-hooks.js";

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

  it("projects a live session's launch configuration as a verdict only, and keeps the start fingerprint after the setup changes", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-agent-store-"));
    tempDirs.push(cwd);
    let prompt: { mode: string; body: string } | null = { mode: "append", body: "launch-prompt-secret" };
    const configuration = createLaunchConfiguration({
      consoleVersion: "1.251.0",
      executionBuildId: () => "build-a",
      readTheaterPrompt: () => prompt,
      listTools: () => [],
      hookEntry: { entryPath: path.join(cwd, "hook-entry.mjs"), execPath: "/usr/bin/node" },
      disabledTools: [],
      expectedTtlMs: 0,
    });
    const store = createConsoleObservabilityStore({
      canonicalizeTheaterPath: (value) => fs.realpathSync.native(value),
      workspaceHash: () => "theater-a",
      describeLaunchConfiguration: (fingerprint) => configuration.describe(fingerprint),
    });
    store.createPendingTerminalSession({ sessionId: "session-b", cwd, cliId: "claude" });
    const launchFingerprint = configuration.capture({ surface: "pty", theaterId: "theater-a", subagentsBlocked: false, autoMemoryDisabled: false });
    const started = store.registerTerminalRuntimeSession({ sessionId: "session-b", cliId: "claude", label: "Claude", mcpToolCount: 0, launchFingerprint });
    expect(started?.configurationState).toBe("current");

    // 새 세션부터 적용되는 설정이 바뀌었다 — 이미 도는 세션의 지문은 그대로이고 판정만 이전 구성이 된다.
    prompt = { mode: "append", body: "changed-prompt" };
    configuration.invalidate();
    const after = store.getTerminalSessionInfo("session-b");
    expect(after?.configurationState).toBe("previous");
    expect(after?.configurationRelease).toBeUndefined();

    const serialized = JSON.stringify({ after, sessions: store.listTerminalSessions() });
    expect(serialized).not.toContain(launchFingerprint.digest);
    expect(serialized).not.toContain(launchFingerprint.effectivePromptHash);
    expect(serialized).not.toContain("launch-prompt-secret");
    expect(serialized).not.toContain("hook-entry");
    expect(serialized).not.toContain("Fingerprint");
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

describe("workspace hook ownership", () => {
  it("accepts only the current main session and never rewinds it with stale reports", () => {
    const report = vi.fn();
    const hooks = createWorkspaceHookRegistry(report);
    let active = true;
    const first = hooks.bind("op", "provider", () => active);
    const input = (cwd: string, extra = {}) => JSON.stringify({ hook_event_name: "CwdChanged", session_id: "provider", new_cwd: cwd, ...extra });
    const cwd = path.resolve("workspace");
    const next = path.join(cwd, "next");
    const run = first.env.FLEET_CONSOLE_WORKSPACE_RUN_ID;
    expect(hooks.report("op", run, input(cwd), 2)).toBe(true);
    expect(hooks.report("op", run, input(next), 1)).toBe(false);
    expect(hooks.report("op", run, input(next, { agent_id: "child" }), 3)).toBe(false);
    expect(hooks.report("op", run, input(next, { session_id: "other" }), 3)).toBe(false);
    expect(hooks.report("op", run, input("relative"), 3)).toBe(false);
    const revision = first.revision;
    expect(hooks.report("op", run, input(next), 4)).toBe(true);
    first.observe(cwd, revision);
    expect(report.mock.calls).toEqual([["op", cwd], ["op", next]]);

    const second = hooks.bind("op", "provider", () => active);
    first.dispose();
    expect(hooks.report("op", run, input(cwd), 5)).toBe(false);
    expect(hooks.report("op", second.env.FLEET_CONSOLE_WORKSPACE_RUN_ID, input(cwd), 6)).toBe(true);
    active = false;
    expect(hooks.report("op", second.env.FLEET_CONSOLE_WORKSPACE_RUN_ID, input(next), 7)).toBe(false);
    second.dispose();
    expect(hooks.has("op")).toBe(false);
    hooks.dispose();
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
