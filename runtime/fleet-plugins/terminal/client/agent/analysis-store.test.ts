import { describe, expect, it, vi } from "vitest";
import type { ClientApiCapability } from "@fleet-console/sdk/plugin";

import { disposeAnalysisStore, getAnalysisStore } from "./analysis-store.js";

const CATALOG_BODY = JSON.stringify({ clis: [{ cliId: "claude", label: "Claude", available: true, defaultModel: "sonnet", models: [{ id: "sonnet", label: "Sonnet", effortLevels: ["high"], defaultEffort: "high" }] }] });

interface StreamHarness {
  readonly api: ClientApiCapability;
  readonly fetch: ReturnType<typeof vi.fn>;
  readonly emit: (payload: unknown) => void;
  readonly emitLate: (payload: unknown) => void;
  readonly streamReady: () => boolean;
  readonly unsubscribeCount: () => number;
}

function createHarness(onPath?: (path: string) => Response | Promise<Response> | null): StreamHarness {
  let stream: ((event: MessageEvent<string>) => void) | null = null;
  let lastStream: ((event: MessageEvent<string>) => void) | null = null;
  let unsubscribeCount = 0;
  const fetch = vi.fn(async (_pluginId: string, path: string) => {
    const override = onPath?.(path);
    if (override) return override;
    return new Response(path === "analysis/catalog" ? CATALOG_BODY : "{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const api = {
    fetch,
    subscribe: (_pluginId: string, _path: string, listener: (event: MessageEvent<string>) => void) => {
      stream = listener;
      lastStream = listener;
      return () => {
        if (stream === listener) stream = null;
        unsubscribeCount += 1;
      };
    },
    resync: vi.fn(),
  } satisfies ClientApiCapability;
  return {
    api,
    fetch,
    emit: (payload) => stream?.({ data: JSON.stringify(payload) } as MessageEvent<string>),
    emitLate: (payload) => lastStream?.({ data: JSON.stringify(payload) } as MessageEvent<string>),
    streamReady: () => stream !== null,
    unsubscribeCount: () => unsubscribeCount,
  };
}

async function sendWithConnected(store: ReturnType<typeof getAnalysisStore>, harness: StreamHarness, text: string): Promise<void> {
  const pending = store.send(text);
  await vi.waitFor(() => expect(harness.streamReady()).toBe(true));
  harness.emit({ type: "connected" });
  await pending;
}

describe("per-operation analysis store", () => {
  it("shares state, gates the first message on the connected frame, and survives companion unmount", async () => {
    const harness = createHarness();
    const first = getAnalysisStore("operation-store-share", harness.api);
    const second = getAnalysisStore("operation-store-share", harness.api);
    const releaseChat = first.retain();
    const releaseArtifacts = second.retain();
    await vi.waitFor(() => expect(first.getSnapshot().cliId).toBe("claude"));

    expect(second).toBe(first);
    await sendWithConnected(first, harness, "Review this session");
    expect(harness.fetch.mock.calls.map((call) => call[1])).toEqual([
      "analysis/catalog",
      "analysis/operation-store-share/start",
      "analysis/operation-store-share/message",
    ]);
    harness.emit({ type: "chunk", text: "Looks good" });
    expect(second.getSnapshot().entries.at(-1)).toEqual({ role: "analyst", text: "Looks good" });
    harness.emit({ type: "complete" });
    expect(first.getSnapshot().busy).toBe(false);

    // EXIT(모든 companion unmount)은 대화·서버 세션을 보존해야 한다.
    releaseChat();
    releaseArtifacts();
    await Promise.resolve();
    expect(harness.fetch.mock.calls.some((call) => call[1] === "analysis/operation-store-share/stop")).toBe(false);
    expect(first.getSnapshot().entries.length).toBeGreaterThan(0);

    // Operation 종료 경로만 서버 세션을 정리한다.
    disposeAnalysisStore("operation-store-share");
    await vi.waitFor(() => expect(harness.fetch.mock.calls.some((call) => call[1] === "analysis/operation-store-share/stop")).toBe(true));
  });

  it("rolls back started when the start request fails so selectors reopen", async () => {
    const harness = createHarness((path) => path.endsWith("/start")
      ? new Response(JSON.stringify({ error: { code: "analysis_catalog_invalid", message: "Analysis selection is unavailable." } }), { status: 400, headers: { "Content-Type": "application/json" } })
      : null);
    const store = getAnalysisStore("operation-store-start-fail", harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));

    await store.send("Review this session");
    const state = store.getSnapshot();
    expect(state.started).toBe(false);
    expect(state.busy).toBe(false);
    expect(state.error).toBe("Analysis selection is unavailable.");
    expect(harness.fetch.mock.calls.some((call) => call[1] === "analysis/operation-store-start-fail/message")).toBe(false);
    disposeAnalysisStore("operation-store-start-fail");
  });

  it("adopts an existing server session when start reports analysis_session_exists", async () => {
    const harness = createHarness((path) => path.endsWith("/start")
      ? new Response(JSON.stringify({ error: { code: "analysis_session_exists", message: "Analysis session already exists." } }), { status: 409, headers: { "Content-Type": "application/json" } })
      : null);
    const store = getAnalysisStore("operation-store-adopt", harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));

    await sendWithConnected(store, harness, "Continue the analysis");
    expect(store.getSnapshot().error).toBeNull();
    expect(store.getSnapshot().started).toBe(true);
    expect(harness.fetch.mock.calls.some((call) => call[1] === "analysis/operation-store-adopt/message")).toBe(true);
    harness.emit({ type: "complete" });
    disposeAnalysisStore("operation-store-adopt");
  });

  it("drops a missing session after message failure and restarts from start on the next send", async () => {
    let messageCount = 0;
    const harness = createHarness((path) => {
      if (!path.endsWith("/message") || messageCount++ > 0) return null;
      return new Response(JSON.stringify({ error: { code: "analysis_session_not_found", message: "Analysis session was not found." } }), { status: 404, headers: { "Content-Type": "application/json" } });
    });
    const store = getAnalysisStore("operation-store-message-lost", harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));

    await sendWithConnected(store, harness, "First attempt");
    expect(store.getSnapshot()).toMatchObject({ started: false, busy: false, error: "Analysis session ended — send again to restart." });
    expect(harness.streamReady()).toBe(false);
    expect(harness.unsubscribeCount()).toBe(1);

    await sendWithConnected(store, harness, "Second attempt");
    const paths = harness.fetch.mock.calls.map((call) => call[1]);
    expect(paths.filter((path) => path.endsWith("/start"))).toHaveLength(2);
    expect(paths.filter((path) => path.endsWith("/message"))).toHaveLength(2);
    expect(store.getSnapshot().started).toBe(true);
    harness.emit({ type: "complete" });
    disposeAnalysisStore("operation-store-message-lost");
  });

  it("stops through the endpoint, preserves output, rejects late events, and starts fresh on the next send", async () => {
    const harness = createHarness();
    const store = getAnalysisStore("operation-store-stop", harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));

    await sendWithConnected(store, harness, "First analysis");
    harness.emit({ type: "tool", title: "wiki_read", status: "running" });
    harness.emit({ type: "chunk", text: "Confirmed answer" });
    harness.emit({ type: "artifact", artifact: { id: "artifact-1", title: "Evidence", html: "<p>evidence</p>", createdAt: 1 } });
    const beforeStop = store.getSnapshot();

    await store.stop();
    expect(harness.fetch.mock.calls.map((call) => call[1])).toContain("analysis/operation-store-stop/stop");
    expect(harness.unsubscribeCount()).toBe(1);
    expect(store.getSnapshot()).toMatchObject({
      started: false,
      busy: false,
      phase: "stopped",
      entries: beforeStop.entries,
      artifacts: beforeStop.artifacts,
      latestActivity: { kind: "writing" },
    });

    harness.emitLate({ type: "chunk", text: " late output" });
    harness.emitLate({ type: "artifact", artifact: { id: "late", title: "Late", html: "<p>late</p>", createdAt: 2 } });
    harness.emitLate({ type: "complete" });
    expect(store.getSnapshot()).toMatchObject({ phase: "stopped", entries: beforeStop.entries, artifacts: beforeStop.artifacts });

    await sendWithConnected(store, harness, "Fresh analysis");
    const paths = harness.fetch.mock.calls.map((call) => call[1]);
    expect(paths.filter((path) => path.endsWith("/start"))).toHaveLength(2);
    expect(paths.filter((path) => path.endsWith("/message"))).toHaveLength(2);
    expect(store.getSnapshot()).toMatchObject({ started: true, busy: true, phase: "starting" });
    harness.emit({ type: "complete" });
    disposeAnalysisStore("operation-store-stop");
  });

  it("stops the server before reset, clears shared history and artifacts, and rejects late events", async () => {
    const harness = createHarness();
    const store = getAnalysisStore("operation-store-reset", harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));

    await sendWithConnected(store, harness, "Review this session");
    harness.emit({ type: "chunk", text: "Confirmed answer" });
    harness.emit({ type: "artifact", artifact: { id: "artifact-1", title: "Evidence", html: "<p>evidence</p>", createdAt: 1 } });
    harness.emit({ type: "complete" });

    await store.reset();
    expect(harness.fetch.mock.calls.map((call) => call[1])).toContain("analysis/operation-store-reset/stop");
    expect(store.getSnapshot()).toMatchObject({
      cliId: "claude",
      model: "sonnet",
      effort: "high",
      started: false,
      busy: false,
      phase: "idle",
      entries: [],
      tools: [],
      artifacts: [],
      error: null,
    });

    harness.emitLate({ type: "chunk", text: "late output" });
    harness.emitLate({ type: "artifact", artifact: { id: "late", title: "Late", html: "<p>late</p>", createdAt: 2 } });
    expect(store.getSnapshot()).toMatchObject({ phase: "idle", entries: [], artifacts: [] });
    disposeAnalysisStore("operation-store-reset");
  });

  it("preserves history and artifacts when reset cannot stop the server", async () => {
    const harness = createHarness((path) => path.endsWith("/stop")
      ? new Response(JSON.stringify({ error: { code: "analysis_stop_failed", message: "Process did not stop." } }), { status: 500, headers: { "Content-Type": "application/json" } })
      : null);
    const store = getAnalysisStore("operation-store-reset-fail", harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));
    await sendWithConnected(store, harness, "Review this session");
    harness.emit({ type: "chunk", text: "Keep this answer" });
    harness.emit({ type: "artifact", artifact: { id: "artifact-1", title: "Keep this", html: "<p>keep</p>", createdAt: 1 } });

    await expect(store.reset()).rejects.toThrow("Process did not stop.");
    expect(store.getSnapshot()).toMatchObject({
      started: true,
      busy: false,
      phase: "error",
      error: "Reset failed: Process did not stop.",
    });
    expect(store.getSnapshot().entries).toHaveLength(2);
    expect(store.getSnapshot().artifacts).toHaveLength(1);
    disposeAnalysisStore("operation-store-reset-fail");
  });

  it("waits for an in-flight start before stopping during reset", async () => {
    let resolveStart!: (response: Response) => void;
    const startResponse = new Promise<Response>((resolve) => { resolveStart = resolve; });
    const harness = createHarness((path) => path.endsWith("/start") ? startResponse : null);
    const store = getAnalysisStore("operation-store-reset-during-start", harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));

    const sending = store.send("Review this session");
    await vi.waitFor(() => expect(harness.fetch.mock.calls.some((call) => call[1].endsWith("/start"))).toBe(true));
    const resetting = store.reset();
    await Promise.resolve();
    expect(harness.fetch.mock.calls.some((call) => call[1].endsWith("/stop"))).toBe(false);

    resolveStart(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    await resetting;
    await sending;
    const paths = harness.fetch.mock.calls.map((call) => call[1]);
    expect(paths.indexOf("analysis/operation-store-reset-during-start/stop")).toBeGreaterThan(paths.indexOf("analysis/operation-store-reset-during-start/start"));
    expect(paths.some((path) => path.endsWith("/message"))).toBe(false);
    expect(store.getSnapshot()).toMatchObject({ started: false, busy: false, phase: "idle", entries: [], artifacts: [] });
    disposeAnalysisStore("operation-store-reset-during-start");
  });

  it("reports stop failure without leaving the store busy or subscribed", async () => {
    const harness = createHarness((path) => path.endsWith("/stop")
      ? new Response(JSON.stringify({ error: { code: "analysis_stop_failed", message: "Process did not stop." } }), { status: 500, headers: { "Content-Type": "application/json" } })
      : null);
    const store = getAnalysisStore("operation-store-stop-fail", harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));
    await sendWithConnected(store, harness, "Review this session");

    await store.stop();
    expect(store.getSnapshot()).toMatchObject({
      started: false,
      busy: false,
      phase: "error",
      error: "Stop failed: Process did not stop.",
    });
    expect(harness.streamReady()).toBe(false);
    disposeAnalysisStore("operation-store-stop-fail");
  });

  it("waits for Stop to settle before starting the next fresh session", async () => {
    let resolveStop!: (response: Response) => void;
    const stopResponse = new Promise<Response>((resolve) => { resolveStop = resolve; });
    const harness = createHarness((path) => path.endsWith("/stop") ? stopResponse : null);
    const store = getAnalysisStore("operation-store-stop-then-send", harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));
    await sendWithConnected(store, harness, "First analysis");

    const stopping = store.stop();
    const restarting = store.send("Fresh analysis");
    await Promise.resolve();
    expect(harness.fetch.mock.calls.map((call) => call[1]).filter((path) => path.endsWith("/start"))).toHaveLength(1);

    resolveStop(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    await stopping;
    await vi.waitFor(() => expect(harness.streamReady()).toBe(true));
    harness.emit({ type: "connected" });
    await restarting;
    expect(harness.fetch.mock.calls.map((call) => call[1]).filter((path) => path.endsWith("/start"))).toHaveLength(2);
    harness.emit({ type: "complete" });
    disposeAnalysisStore("operation-store-stop-then-send");
  });

  it("unsubscribes after an analysis_exited stream event and restarts on the next send", async () => {
    const harness = createHarness();
    const store = getAnalysisStore("operation-store-stream-lost", harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));

    await sendWithConnected(store, harness, "First attempt");
    harness.emit({ type: "error", error: { code: "analysis_exited", message: "Process exited." } });
    expect(store.getSnapshot()).toMatchObject({ started: false, busy: false, error: "Analysis session ended — send again to restart." });
    expect(harness.streamReady()).toBe(false);
    expect(harness.unsubscribeCount()).toBe(1);

    await sendWithConnected(store, harness, "Second attempt");
    expect(harness.fetch.mock.calls.map((call) => call[1]).filter((path) => path.endsWith("/start"))).toHaveLength(2);
    harness.emit({ type: "complete" });
    disposeAnalysisStore("operation-store-stream-lost");
  });
});
