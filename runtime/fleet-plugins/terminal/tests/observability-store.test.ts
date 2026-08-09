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
      cliId: "claude-gateway",
      cliLabel: "Claude (Gateway)",
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

  it("clears the in-memory provider session for a fresh start and ignores unknown sessions", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-agent-store-"));
    tempDirs.push(cwd);
    const store = createConsoleObservabilityStore({
      canonicalizeTheaterPath: (value) => fs.realpathSync.native(value),
      workspaceHash: () => "theater-a",
    });
    store.injectDormantOperation({
      sessionId: "session-a",
      theaterId: "theater-a",
      cwd,
      cliId: "claude-gateway",
      cliLabel: "Claude (Gateway)",
      createdAt: 1_000,
      providerSession: {
        provider: "claude",
        sessionId: "provider-session-secret",
        transcriptPath: "/secret/transcript.jsonl",
        source: "startup",
        capturedAt: "2026-06-16T00:00:00.000Z",
      },
    });

    const cleared = store.clearTerminalSessionProviderSession("session-a");

    expect(cleared).not.toBeNull();
    expect(cleared?.resumeAvailable).toBe(false);
    expect(JSON.stringify(store.listTerminalSessions())).not.toContain("provider-session-secret");
    expect(store.clearTerminalSessionProviderSession("missing")).toBeNull();
  });
});

describe("agent activity observability state", () => {
  function createStore() {
    const store = createConsoleObservabilityStore({ workspaceHash: () => "theater-a" });
    store.createPendingTerminalSession({ sessionId: "session-a", cwd: "/workspace/project", cliId: "claude-gateway", createdAt: 1_000 });
    return store;
  }

  it("projects only classified activity and pending attention into browser DTOs", () => {
    const store = createStore();
    const frames: unknown[] = [];
    store.subscribeAll((event) => frames.push(event));

    const notWorking = store.setTerminalSessionModelActivity("session-a", "not-working");
    expect(notWorking).toMatchObject({ modelActivity: "not-working" });
    if (notWorking) store.notifySessionUpdated(notWorking);
    expect(store.setTerminalSessionModelActivity("session-a", "not-working")).toBeNull();

    store.notifySessionAttention(notWorking!, "permission_prompt");
    expect(store.getTerminalSessionInfo("session-a")).toMatchObject({
      modelActivity: "not-working",
      attentionPending: true,
    });

    const working = store.setTerminalSessionModelActivity("session-a", "working");
    expect(working).toMatchObject({ modelActivity: "working" });
    expect(working).not.toHaveProperty("attentionPending");
    if (working) store.notifySessionUpdated(working);
    expect(store.setTerminalSessionModelActivity("session-a", "working")).toBeNull();

    expect(frames.map((frame) => (frame as { readonly type: string }).type)).toEqual([
      "session:updated",
      "session:attention",
      "session:updated",
    ]);
    const serialized = JSON.stringify({ durable: store.listDurableOperations(), frames });
    expect(serialized).not.toContain("raw title");
    expect(JSON.stringify(store.listDurableOperations())).not.toContain("modelActivity");
    expect(JSON.stringify(store.listDurableOperations())).not.toContain("attentionPending");
  });

  it("applies the background report as an absolute value and survives turn transitions", () => {
    const store = createStore();

    expect(store.setTerminalSessionBackgroundPending("missing", true)).toBeNull();
    expect(store.setTerminalSessionBackgroundPending("session-a", true)).toMatchObject({ backgroundPending: true });
    expect(store.setTerminalSessionBackgroundPending("session-a", true)).toMatchObject({ backgroundPending: true });
    expect(store.setTerminalSessionTurnState("session-a", "ended")).toMatchObject({ backgroundPending: true });
    // 워크플로우 에이전트가 하나씩 끝나도 남은 작업이 보고되는 한 배지는 유지된다.
    expect(store.setTerminalSessionBackgroundPending("session-a", true)).toMatchObject({ backgroundPending: true });
    expect(store.setTerminalSessionBackgroundPending("session-a", false)).not.toHaveProperty("backgroundPending");
    expect(store.setTerminalSessionBackgroundPending("session-a", false)).not.toHaveProperty("backgroundPending");
  });

  it("remembers stopped agents past a cleared badge, and forgets them with the session lifecycle", () => {
    const store = createStore();

    expect(store.getTerminalSessionSettledAgentIds("session-a")).toEqual(new Set());
    // 배지가 꺼졌다고 stop 보고까지 잊으면, 상주 에이전트가 다음 턴 종료 payload에서 되살아난다.
    store.setTerminalSessionBackgroundPending("session-a", false, new Set(["a5c0d92a34c49dcfe"]));
    expect(store.getTerminalSessionSettledAgentIds("session-a")).toEqual(new Set(["a5c0d92a34c49dcfe"]));
    store.setTerminalSessionBackgroundPending("session-a", true, new Set(["a5c0d92a34c49dcfe", "b77c0de1"]));
    expect(store.getTerminalSessionSettledAgentIds("session-a")).toEqual(new Set(["a5c0d92a34c49dcfe", "b77c0de1"]));

    // 세션이 dormant로 내려가면 그 기억은 CLI 프로세스와 함께 끝난다.
    store.transitionTerminalSessionToDormant("session-a", {
      provider: "claude",
      sessionId: "provider-session",
      capturedAt: "2026-07-25T00:00:00.000Z",
    });
    expect(store.getTerminalSessionSettledAgentIds("session-a")).toEqual(new Set());
  });

  it("expires background pending after 30 minutes and emits an updated session", () => {
    vi.useFakeTimers();
    const store = createStore();
    const frames: unknown[] = [];
    store.subscribeAll((event) => frames.push(event));

    store.setTerminalSessionBackgroundPending("session-a", true);
    vi.advanceTimersByTime(29 * 60_000);
    expect(store.getTerminalSessionInfo("session-a")).toMatchObject({ backgroundPending: true });
    vi.advanceTimersByTime(60_000);

    expect(store.getTerminalSessionInfo("session-a")).not.toHaveProperty("backgroundPending");
    expect(frames).toEqual([
      expect.objectContaining({ type: "session:updated", session: expect.not.objectContaining({ backgroundPending: true }) }),
    ]);
    vi.useRealTimers();
  });

  it("clears background pending and its expiry timer when a session becomes dormant", () => {
    vi.useFakeTimers();
    const store = createStore();
    const frames: unknown[] = [];
    store.subscribeAll((event) => frames.push(event));
    store.setTerminalSessionBackgroundPending("session-a", true);

    const dormant = store.transitionTerminalSessionToDormant("session-a", {
      provider: "claude",
      sessionId: "provider-session",
      capturedAt: "2026-07-25T00:00:00.000Z",
    });
    expect(dormant).not.toHaveProperty("backgroundPending");
    vi.advanceTimersByTime(30 * 60_000);
    expect(frames).toEqual([]);
    vi.useRealTimers();
  });

  it("ignores late background events for dormant sessions instead of resurrecting the badge", () => {
    vi.useFakeTimers();
    const store = createStore();
    store.transitionTerminalSessionToDormant("session-a", {
      provider: "claude",
      sessionId: "provider-session",
      capturedAt: "2026-07-25T00:00:00.000Z",
    });

    // 전이 시점에 in-flight였던 best-effort hook이 뒤늦게 도착해도 무시된다.
    expect(store.setTerminalSessionBackgroundPending("session-a", true)).toBeNull();
    expect(store.getTerminalSessionInfo("session-a")).not.toHaveProperty("backgroundPending");
    vi.advanceTimersByTime(30 * 60_000);
    expect(store.getTerminalSessionInfo("session-a")).not.toHaveProperty("backgroundPending");
    vi.useRealTimers();
  });

  it("clears both transient axes on either turn phase and falls back to the hook turn state", () => {
    const store = createStore();
    const initial = store.getTerminalSessionInfo("session-a")!;
    store.setTerminalSessionModelActivity("session-a", "not-working");
    store.notifySessionAttention(initial, "permission_prompt");

    const started = store.setTerminalSessionTurnState("session-a", "running")!;
    expect(started).not.toHaveProperty("attentionPending");
    expect(started).not.toHaveProperty("modelActivity");
    expect(sessionActivity(started)).toBe("running");
    store.setTerminalSessionModelActivity("session-a", "not-working");
    store.notifySessionAttention(store.getTerminalSessionInfo("session-a")!, "elicitation_dialog");
    const ended = store.setTerminalSessionTurnState("session-a", "ended")!;
    expect(ended).not.toHaveProperty("attentionPending");
    expect(ended).not.toHaveProperty("modelActivity");
    expect(sessionActivity(ended)).toBe("idle");
    store.notifySessionAttention(store.getTerminalSessionInfo("session-a")!, "idle_prompt");
    expect(store.getTerminalSessionInfo("session-a")).not.toHaveProperty("attentionPending");

    store.notifySessionAttention(store.getTerminalSessionInfo("session-a")!, "permission_prompt");
    const dormant = store.transitionTerminalSessionToDormant("session-a", {
      provider: "claude",
      sessionId: "provider-session",
      capturedAt: "2026-07-25T00:00:00.000Z",
    });
    expect(dormant).toMatchObject({ status: "dormant", attentionPending: true });
    expect(dormant).not.toHaveProperty("modelActivity");
  });

  it("preserves attentionPending across transitionTerminalSessionToDormant", () => {
    const store = createStore();
    store.setTerminalSessionModelActivity("session-a", "not-working");
    store.notifySessionAttention(store.getTerminalSessionInfo("session-a")!, "permission_prompt");
    expect(store.getTerminalSessionInfo("session-a")).toMatchObject({ attentionPending: true });

    const dormant = store.transitionTerminalSessionToDormant("session-a", {
      provider: "claude",
      sessionId: "provider-session",
      capturedAt: "2026-07-25T00:00:00.000Z",
    });
    expect(dormant).toMatchObject({ status: "dormant", attentionPending: true });
    expect(store.getTerminalSessionInfo("session-a")).toMatchObject({ attentionPending: true });
  });

  it("still clears attentionPending when updateTerminalSessionStatus sets dormant", () => {
    const store = createStore();
    store.setTerminalSessionModelActivity("session-a", "not-working");
    store.notifySessionAttention(store.getTerminalSessionInfo("session-a")!, "permission_prompt");
    const rolledBack = store.updateTerminalSessionStatus("session-a", "dormant");
    expect(rolledBack).toMatchObject({ status: "dormant" });
    expect(rolledBack).not.toHaveProperty("attentionPending");
  });

  it("emits exactly one update when repeated working clears late attention", () => {
    const store = createStore();
    const frames: unknown[] = [];
    store.subscribeAll((event) => frames.push(event));
    const firstWorking = store.setTerminalSessionModelActivity("session-a", "working")!;
    store.notifySessionUpdated(firstWorking);
    store.notifySessionAttention(firstWorking, "permission_prompt");

    const cleared = store.setTerminalSessionModelActivity("session-a", "working");
    expect(cleared).toMatchObject({ modelActivity: "working" });
    expect(cleared).not.toHaveProperty("attentionPending");
    if (cleared) store.notifySessionUpdated(cleared);
    expect(store.setTerminalSessionModelActivity("session-a", "working")).toBeNull();

    expect(frames.map((frame) => (frame as { readonly type: string }).type)).toEqual([
      "session:updated",
      "session:attention",
      "session:updated",
    ]);
  });
});

describe("agent operation title precedence", () => {
  function createStore() {
    return createConsoleObservabilityStore({ workspaceHash: () => "theater-a" });
  }

  function createSession(store: ReturnType<typeof createStore>, sessionId = "session-a") {
    store.createPendingTerminalSession({ sessionId, cwd: "/workspace/project", createdAt: 1_000 });
  }

  it("applies default, auto, provider, refreshed provider, then user precedence", () => {
    const store = createStore();
    createSession(store);

    expect(store.autoNameTerminalSession("session-a", "Prompt title")).toMatchObject({ renamed: true, session: { label: "Prompt title", labelSource: "auto" } });
    expect(store.applyTerminalSessionProviderIdentity("session-a", "Provider title")).toMatchObject({ renamed: true, session: { label: "Provider title" } });
    expect(store.getDurableOperation("session-a")).toMatchObject({ providerTitle: { source: "provider" } });
    expect(store.applyTerminalSessionProviderIdentity("session-a", "Refreshed title")).toMatchObject({ renamed: true, session: { label: "Refreshed title" } });
    expect(store.renameTerminalSession("session-a", "Manual title")).toMatchObject({ label: "Manual title", labelSource: "user" });
    expect(store.applyTerminalSessionProviderIdentity("session-a", "Ignored provider title")).toMatchObject({ renamed: false, session: { label: "Manual title", labelSource: "user" } });
    expect(store.getDurableOperation("session-a")?.providerTitle).toBeUndefined();
  });

  it("protects conservatively interpreted legacy titles and refuses auto-name after provider identity", () => {
    const store = createStore();
    store.injectDormantOperation({ sessionId: "legacy", theaterId: "theater-a", cwd: "/workspace/project", label: "Legacy title", createdAt: 1_000 });
    expect(store.applyTerminalSessionProviderIdentity("legacy", "Provider title")).toMatchObject({ renamed: false, session: { label: "Legacy title" } });

    createSession(store);
    store.applyTerminalSessionProviderIdentity("session-a", "Provider title");
    expect(store.autoNameTerminalSession("session-a", "Prompt title")).toMatchObject({ renamed: false, session: { label: "Provider title" } });
  });

  it("clears user and provider provenance on empty rename, and ignores malformed or duplicate provider titles", () => {
    const store = createStore();
    createSession(store);
    expect(store.applyTerminalSessionProviderIdentity("session-a", "  Provider title  ")).toMatchObject({ renamed: true, session: { label: "Provider title" } });
    expect(store.applyTerminalSessionProviderIdentity("session-a", "Provider title")).toMatchObject({ renamed: false });
    expect(store.applyTerminalSessionProviderIdentity("session-a", "   ")).toMatchObject({ renamed: false });
    expect(store.renameTerminalSession("session-a", "")).toMatchObject({ label: undefined, labelSource: undefined });
    expect(store.getDurableOperation("session-a")?.providerTitle).toBeUndefined();

    expect(store.applyTerminalSessionProviderIdentity("session-a", `  ${"x".repeat(201)}  `)?.session.label).toBe("x".repeat(200));
  });

  it("rehydrates provider provenance without exposing it in browser session DTOs", () => {
    const store = createStore();
    const session = store.injectDormantOperation({
      sessionId: "session-a",
      theaterId: "theater-a",
      cwd: "/workspace/project",
      label: "Provider title",
      providerTitle: { source: "provider" },
      createdAt: 1_000,
    });

    expect(store.applyTerminalSessionProviderIdentity("session-a", "Refreshed title")).toMatchObject({ renamed: true, session: { label: "Refreshed title" } });
    expect(JSON.stringify(session)).not.toContain("providerTitle");
    expect(store.getDurableOperation("session-a")).toMatchObject({ label: "Refreshed title", providerTitle: { source: "provider" } });
  });
});
