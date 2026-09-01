import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import type { ClientApiCapability, ClientSettingsCapability } from "@fleet-console/sdk/plugin";

import { resetAnalysisStreamHubForTests, subscribeAnalysis } from "./analysis-api.js";
import { disposeAnalysisStore, getAnalysisStore } from "./analysis-store.js";

const CATALOG_BODY = JSON.stringify({ clis: [{ cliId: "claude", label: "Claude", available: true, defaultModel: "sonnet", models: [{ id: "sonnet", label: "Sonnet", effortLevels: ["high"], defaultEffort: "high" }] }] });

interface StreamHarness {
  readonly api: ClientApiCapability;
  readonly fetch: ReturnType<typeof vi.fn>;
  readonly subscribe: ReturnType<typeof vi.fn>;
  readonly emitRoster: (operationIds: readonly string[]) => void;
  readonly replaceRoster: (operationIds: readonly string[]) => void;
  readonly emit: (operationId: string, payload: unknown) => void;
  readonly emitLate: (operationId: string, payload: unknown) => void;
  readonly deliverRaw: (raw: string) => void;
  readonly streamReady: () => boolean;
  readonly streamOpen: () => boolean;
  readonly unsubscribeCount: () => number;
  readonly eventSourceCount: () => number;
}

class TestEventSource {
  static instances: TestEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly url: string;
  readyState = TestEventSource.CONNECTING;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    TestEventSource.instances.push(this);
  }
  close(): void { this.readyState = TestEventSource.CLOSED; }
  open(): void { this.readyState = TestEventSource.OPEN; }
  deliver(data: string): void {
    if (this.readyState !== TestEventSource.OPEN) return;
    this.onmessage?.({ data } as MessageEvent<string>);
  }
  triggerError(): void { this.onerror?.(); }
}

function createHarness(onPath?: (path: string, init?: RequestInit) => Response | Promise<Response> | null): StreamHarness {
  TestEventSource.instances = [];
  const activeOperations = new Set<string>();
  let unsubscribeCount = 0;
  const fetch = vi.fn(async (_pluginId: string, path: string, init?: RequestInit) => {
    const override = onPath?.(path, init);
    if (override) return override;
    return new Response(path === "analysis/catalog" ? CATALOG_BODY : "{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const subscribe = vi.fn((_pluginId: string, _path: string, _listener: (event: MessageEvent<string>) => void) => {
    return () => { unsubscribeCount += 1; };
  });
  const api = { fetch, subscribe, resync: vi.fn() } satisfies ClientApiCapability;
  const deliverRoster = () => {
    const source = TestEventSource.instances.at(-1);
    source?.open();
    source?.deliver(JSON.stringify({
      type: "connected",
      operationIds: [...activeOperations].sort(),
    }));
  };
  return {
    api,
    fetch,
    subscribe,
    emitRoster: (operationIds) => {
      for (const operationId of operationIds) activeOperations.add(operationId);
      deliverRoster();
    },
    replaceRoster: (operationIds) => {
      activeOperations.clear();
      for (const operationId of operationIds) activeOperations.add(operationId);
      deliverRoster();
    },
    emit: (operationId, payload) => {
      const source = TestEventSource.instances.at(-1);
      source?.open();
      source?.deliver(JSON.stringify({ type: "event", operationId, event: payload }));
    },
    emitLate: (operationId, payload) => {
      const source = TestEventSource.instances.at(-1);
      source?.open();
      source?.deliver(JSON.stringify({ type: "event", operationId, event: payload }));
    },
    deliverRaw: (raw) => {
      const source = TestEventSource.instances.at(-1);
      source?.open();
      source?.deliver(raw);
    },
    streamReady: () => TestEventSource.instances.length > 0,
    streamOpen: () => TestEventSource.instances.some((instance) => instance.readyState === TestEventSource.OPEN),
    unsubscribeCount: () => unsubscribeCount,
    eventSourceCount: () => TestEventSource.instances.length,
  };
}

afterEach(() => {
  resetAnalysisStreamHubForTests();
  TestEventSource.instances = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function sendWithConnected(store: ReturnType<typeof getAnalysisStore>, harness: StreamHarness, operationId: string, text: string): Promise<void> {
  const pending = store.send(text);
  await vi.waitFor(() => expect(harness.streamReady()).toBe(true));
  harness.emitRoster([operationId]);
  await pending;
}

describe("per-operation analysis store", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", TestEventSource);
  });

  it("shares state, gates the first message on the connected frame, and survives companion unmount", async () => {
    const harness = createHarness();
    const operationId = "operation-store-share";
    const first = getAnalysisStore(operationId, harness.api);
    const second = getAnalysisStore(operationId, harness.api);
    await vi.waitFor(() => expect(first.getSnapshot().cliId).toBe("claude"));

    expect(second).toBe(first);
    first.dispatch({ type: "set-draft", draft: "Survives panel collapse" });
    await sendWithConnected(first, harness, operationId, "Review this session");
    expect(harness.fetch.mock.calls.map((call) => call[1])).toEqual([
      "analysis/catalog",
      "analysis/operation-store-share/start",
      "analysis/operation-store-share/message",
    ]);
    expect(harness.subscribe).not.toHaveBeenCalled();
    harness.emit(operationId, { type: "chunk", text: "Looks good" });
    expect(second.getSnapshot().entries.at(-1)).toMatchObject({ role: "analyst", segments: [{ text: "Looks good", steps: [] }] });
    harness.emit(operationId, { type: "complete" });
    expect(first.getSnapshot().busy).toBe(false);

    // EXIT only unmounts companions, so the shared conversation and server session remain alive.
    await Promise.resolve();
    expect(getAnalysisStore("operation-store-share", harness.api)).toBe(first);
    expect(first.getSnapshot().draft).toBe("Survives panel collapse");
    expect(harness.fetch.mock.calls.some((call) => call[1] === "analysis/operation-store-share/stop")).toBe(false);
    expect(first.getSnapshot().entries.length).toBeGreaterThan(0);

    // Operation close owns disposal and server-session cleanup.
    disposeAnalysisStore("operation-store-share");
    await vi.waitFor(() => expect(harness.fetch.mock.calls.some((call) => call[1] === "analysis/operation-store-share/stop")).toBe(true));
  });

  it("re-reads the catalog on refresh, keeps the current selection, and stops once the session started", async () => {
    // 설정에서 모델을 추가한 뒤 돌아온 상황 — 두 번째 읽기부터 새 모델이 실린다.
    let models = [{ id: "sonnet", label: "Claude Sonnet", effortLevels: ["low"], defaultEffort: "low" }];
    const harness = createHarness((path) => path === "analysis/catalog"
      ? new Response(
        JSON.stringify({ clis: [{ cliId: "claude", label: "AI Gateway", available: true, defaultModel: "sonnet", models }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
      : null);
    const operationId = "operation-store-catalog-refresh";
    const store = getAnalysisStore(operationId, harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().catalog?.clis[0]?.models).toHaveLength(1));

    models = [...models, { id: "claude-gateway--cursor--auto", label: "Cursor-Auto", effortLevels: ["low"], defaultEffort: "low" }];
    store.refreshCatalog();
    await vi.waitFor(() => expect(store.getSnapshot().catalog?.clis[0]?.models).toHaveLength(2));
    // 갱신이 사용자의 현재 선택을 갈아끼우지 않는다.
    expect(store.getSnapshot()).toMatchObject({ cliId: "claude", model: "sonnet", effort: "low" });

    const readsBeforeStart = harness.fetch.mock.calls.filter((call) => call[1] === "analysis/catalog").length;
    store.dispatch({ type: "sending", started: true, text: "go", now: Date.now() });
    store.refreshCatalog();
    await Promise.resolve();
    // 선택이 잠긴 뒤에는 읽지 않는다 — 진행 중 세션의 표시 선택을 뒤에서 갈아끼우게 된다.
    expect(harness.fetch.mock.calls.filter((call) => call[1] === "analysis/catalog")).toHaveLength(readsBeforeStart);
    disposeAnalysisStore(operationId);
  });

  it("folds a first-mount refresh into the initial hydration instead of racing it", async () => {
    const harness = createHarness();
    const operationId = "operation-store-catalog-first-mount";
    const store = getAnalysisStore(operationId, harness.api);
    // 첫 마운트의 효과는 하이드레이션이 아직 비행 중일 때 돈다 — 여기서 두 번째 읽기를 띄우면
    // 늦게 도착한 하이드레이션이 그 사이 사용자가 고른 선택을 저장본으로 덮어쓴다.
    store.refreshCatalog();
    await vi.waitFor(() => expect(store.getSnapshot().catalog).not.toBeNull());
    expect(harness.fetch.mock.calls.filter((call) => call[1] === "analysis/catalog")).toHaveLength(1);

    // 하이드레이션이 끝난 뒤의 재마운트는 정상적으로 다시 읽는다.
    store.refreshCatalog();
    await vi.waitFor(() => expect(harness.fetch.mock.calls.filter((call) => call[1] === "analysis/catalog")).toHaveLength(2));
    disposeAnalysisStore(operationId);
  });

  it("re-reads the catalog on reset so a started session picks up a newly added model", async () => {
    // started는 complete 뒤에도 참이라 마운트 갱신이 막힌다 — 그 세션이 새 모델을 만나는 자리는 reset뿐이다.
    let models = [{ id: "sonnet", label: "Claude Sonnet", effortLevels: ["low"], defaultEffort: "low" }];
    const harness = createHarness((path) => path === "analysis/catalog"
      ? new Response(
        JSON.stringify({ clis: [{ cliId: "claude", label: "AI Gateway", available: true, defaultModel: "sonnet", models }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
      : null);
    const operationId = "operation-store-catalog-reset";
    const store = getAnalysisStore(operationId, harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().catalog?.clis[0]?.models).toHaveLength(1));

    store.dispatch({ type: "sending", started: true, text: "go", now: Date.now() });
    models = [...models, { id: "claude-gateway--cursor--auto", label: "Cursor-Auto", effortLevels: ["low"], defaultEffort: "low" }];
    store.refreshCatalog();
    await Promise.resolve();
    expect(store.getSnapshot().catalog?.clis[0]?.models).toHaveLength(1);

    await store.reset();
    await vi.waitFor(() => expect(store.getSnapshot().catalog?.clis[0]?.models).toHaveLength(2));
    expect(store.getSnapshot().started).toBe(false);
    disposeAnalysisStore(operationId);
  });

  it("migrates a persisted bare Fable selection before catalog hydration", async () => {
    const catalogBody = JSON.stringify({ clis: [{ cliId: "claude", label: "AI Gateway", available: true, defaultModel: "sonnet", models: [
      { id: "sonnet", label: "Claude Sonnet", effortLevels: ["low"], defaultEffort: "low" },
      { id: "fable[1m]", label: "Claude Fable", effortLevels: ["max"] },
    ] }] });
    const harness = createHarness((path) => path === "analysis/catalog"
      ? new Response(catalogBody, { status: 200, headers: { "Content-Type": "application/json" } })
      : null);
    let terminalRecord: Record<string, unknown> = {
      font: { source: "curated", id: "jetbrains", customName: "", size: 16 },
      analyst: { selection: { cliId: "claude", model: "fable", effort: "max" } },
    };
    const settings: ClientSettingsCapability = {
      read: vi.fn(async () => terminalRecord),
      write: vi.fn(async (_pluginId, value) => { terminalRecord = value; }),
    };
    const operationId = "operation-store-fable-selection-migration";
    const store = getAnalysisStore(operationId, harness.api, settings);

    await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({ cliId: "claude", model: "fable[1m]", effort: "max" }));
    expect(settings.write).toHaveBeenCalledWith("terminal", {
      font: { source: "curated", id: "jetbrains", customName: "", size: 16 },
      analyst: { selection: { cliId: "claude", model: "fable[1m]", effort: "max" } },
    });
    disposeAnalysisStore(operationId);
  });

  it("hydrates, auto-saves with terminal sibling preservation, confirms the save, and resets to persisted selection", async () => {
    const catalogBody = JSON.stringify({ clis: [{ cliId: "claude", label: "Claude", available: true, defaultModel: "sonnet", models: [
      { id: "sonnet", label: "Sonnet", effortLevels: ["medium"], defaultEffort: "medium" },
      { id: "opus", label: "Opus", effortLevels: ["high"], defaultEffort: "high" },
    ] }] });
    const harness = createHarness((path) => path === "analysis/catalog"
      ? new Response(catalogBody, { status: 200, headers: { "Content-Type": "application/json" } })
      : null);
    let terminalRecord: Record<string, unknown> = {
      font: { source: "curated", id: "jetbrains", customName: "", size: 16 },
      analyst: { selection: { cliId: "claude", model: "opus", effort: "high" } },
    };
    const settings: ClientSettingsCapability = {
      read: vi.fn(async () => terminalRecord),
      write: vi.fn(async (_pluginId, value) => { terminalRecord = value; }),
    };
    const operationId = "operation-store-persisted-selection";
    const store = getAnalysisStore(operationId, harness.api, settings, "ko");

    await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({ cliId: "claude", model: "opus", effort: "high" }));
    store.dispatch({ type: "select-model", model: "sonnet" });
    await vi.waitFor(() => expect(settings.write).toHaveBeenCalledOnce());
    expect(settings.write).toHaveBeenCalledWith("terminal", {
      font: { source: "curated", id: "jetbrains", customName: "", size: 16 },
      analyst: { selection: { cliId: "claude", model: "sonnet", effort: "medium" } },
    });
    expect(store.getSnapshot().selectionSaved).toBe(true);

    store.dispatch({ type: "select-model", model: "opus" });
    await vi.waitFor(() => expect(settings.write).toHaveBeenCalledTimes(2));
    await store.reset();
    expect(store.getSnapshot()).toMatchObject({ cliId: "claude", model: "opus", effort: "high", phase: "idle" });
    disposeAnalysisStore(operationId);
  });

  it("ignores selection changes during reset and restores the completed persisted write", async () => {
    const catalogBody = JSON.stringify({ clis: [{ cliId: "claude", label: "Claude", available: true, defaultModel: "sonnet", models: [
      { id: "sonnet", label: "Sonnet", effortLevels: ["medium"], defaultEffort: "medium" },
      { id: "opus", label: "Opus", effortLevels: ["high"], defaultEffort: "high" },
    ] }] });
    const harness = createHarness((path) => path === "analysis/catalog"
      ? new Response(catalogBody, { status: 200, headers: { "Content-Type": "application/json" } })
      : null);
    let terminalRecord: Record<string, unknown> = {
      analyst: { selection: { cliId: "claude", model: "opus", effort: "high" } },
    };
    let completeWrite!: () => void;
    const settings: ClientSettingsCapability = {
      read: vi.fn(async () => terminalRecord),
      write: vi.fn((_pluginId, value) => new Promise<void>((resolve) => {
        completeWrite = () => {
          terminalRecord = value;
          resolve();
        };
      })),
    };
    const operationId = "operation-store-reset-selection-fence";
    const store = getAnalysisStore(operationId, harness.api, settings);
    await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({ model: "opus", effort: "high" }));

    store.dispatch({ type: "select-model", model: "sonnet" });
    await vi.waitFor(() => expect(settings.write).toHaveBeenCalledOnce());
    const resetting = store.reset();
    expect(store.getSnapshot().selectionLocked).toBe(true);
    store.dispatch({ type: "select-model", model: "opus" });
    expect(store.getSnapshot()).toMatchObject({ model: "sonnet", effort: "medium" });

    completeWrite();
    await resetting;
    expect(terminalRecord).toMatchObject({
      analyst: { selection: { cliId: "claude", model: "sonnet", effort: "medium" } },
    });
    expect(store.getSnapshot()).toMatchObject({ model: "sonnet", effort: "medium", phase: "idle", selectionLocked: false });
    disposeAnalysisStore(operationId);
  });

  it("hydrates a replacement only after the disposed store's selection write settles", async () => {
    const catalogBody = JSON.stringify({ clis: [{ cliId: "claude", label: "Claude", available: true, defaultModel: "sonnet", models: [
      { id: "sonnet", label: "Sonnet", effortLevels: ["medium"], defaultEffort: "medium" },
      { id: "opus", label: "Opus", effortLevels: ["high"], defaultEffort: "high" },
    ] }] });
    const harness = createHarness((path) => path === "analysis/catalog"
      ? new Response(catalogBody, { status: 200, headers: { "Content-Type": "application/json" } })
      : null);
    let terminalRecord: Record<string, unknown> = {
      analyst: { selection: { cliId: "claude", model: "opus", effort: "high" } },
    };
    let completeWrite!: () => void;
    const settings: ClientSettingsCapability = {
      read: vi.fn(async () => terminalRecord),
      write: vi.fn((_pluginId, value) => new Promise<void>((resolve) => {
        completeWrite = () => {
          terminalRecord = value;
          resolve();
        };
      })),
    };
    const operationId = "operation-store-dispose-selection-fence";
    const first = getAnalysisStore(operationId, harness.api, settings);
    await vi.waitFor(() => expect(first.getSnapshot()).toMatchObject({ model: "opus", effort: "high" }));
    first.dispatch({ type: "select-model", model: "sonnet" });
    await vi.waitFor(() => expect(settings.write).toHaveBeenCalledOnce());

    disposeAnalysisStore(operationId);
    const replacement = getAnalysisStore(operationId, harness.api, settings);
    expect(replacement).not.toBe(first);
    expect(replacement.getSnapshot().catalog).toBeNull();

    completeWrite();
    await vi.waitFor(() => expect(replacement.getSnapshot()).toMatchObject({ model: "sonnet", effort: "medium" }));
    expect(terminalRecord).toMatchObject({
      analyst: { selection: { cliId: "claude", model: "sonnet", effort: "medium" } },
    });
    disposeAnalysisStore(operationId);
  });

  it("captures the resolved language in the start request", async () => {
    const harness = createHarness();
    const operationId = "operation-store-language";
    const store = getAnalysisStore(operationId, harness.api, undefined, "ko");
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));

    await sendWithConnected(store, harness, operationId, "세션을 검토해 줘");
    const start = harness.fetch.mock.calls.find((call) => String(call[1]).endsWith("/start"));
    expect(JSON.parse(String((start?.[2] as RequestInit | undefined)?.body))).toEqual({
      cliId: "claude",
      model: "sonnet",
      effort: "high",
      language: "ko",
    });
    harness.emit(operationId, { type: "complete" });
    disposeAnalysisStore(operationId);
  });

  it("automatically sends queued questions in FIFO order after each completion", async () => {
    const harness = createHarness();
    const operationId = "operation-store-queue";
    const store = getAnalysisStore(operationId, harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));
    await sendWithConnected(store, harness, operationId, "Initial question");
    store.dispatch({ type: "queue-push", text: "First queued" });
    store.dispatch({ type: "queue-push", text: "Second queued" });

    harness.emit(operationId, { type: "complete" });
    await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({ busy: true, queue: ["Second queued"] }));
    expect(messageBodies(harness)).toEqual(["Initial question", "First queued"]);

    harness.emit(operationId, { type: "complete" });
    await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({ busy: true, queue: [] }));
    expect(messageBodies(harness)).toEqual(["Initial question", "First queued", "Second queued"]);

    harness.emit(operationId, { type: "complete" });
    disposeAnalysisStore(operationId);
  });

  it("clears queued questions on stop and never fires them from late completion", async () => {
    const harness = createHarness();
    const operationId = "operation-store-queue-stop";
    const store = getAnalysisStore(operationId, harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));
    await sendWithConnected(store, harness, operationId, "Initial question");
    store.dispatch({ type: "queue-push", text: "Must not fire" });

    await store.stop();
    expect(store.getSnapshot().queue).toEqual([]);
    harness.emitLate(operationId, { type: "complete" });
    await Promise.resolve();
    expect(messageBodies(harness)).toEqual(["Initial question"]);
    disposeAnalysisStore(operationId);
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
    const operationId = "operation-store-adopt";
    const store = getAnalysisStore(operationId, harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));

    await sendWithConnected(store, harness, operationId, "Continue the analysis");
    expect(store.getSnapshot().error).toBeNull();
    expect(store.getSnapshot().started).toBe(true);
    expect(harness.fetch.mock.calls.some((call) => call[1] === `analysis/${operationId}/message`)).toBe(true);
    harness.emit(operationId, { type: "complete" });
    disposeAnalysisStore(operationId);
  });

  it("drops a missing session after message failure and restarts from start on the next send", async () => {
    let messageCount = 0;
    const harness = createHarness((path) => {
      if (!path.endsWith("/message") || messageCount++ > 0) return null;
      return new Response(JSON.stringify({ error: { code: "analysis_session_not_found", message: "Analysis session was not found." } }), { status: 404, headers: { "Content-Type": "application/json" } });
    });
    const operationId = "operation-store-message-lost";
    const store = getAnalysisStore(operationId, harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));

    await sendWithConnected(store, harness, operationId, "First attempt");
    expect(store.getSnapshot()).toMatchObject({ started: false, busy: false, error: "Analysis session ended — send again to restart." });
    expect(harness.streamOpen()).toBe(false);

    await sendWithConnected(store, harness, operationId, "Second attempt");
    const paths = harness.fetch.mock.calls.map((call) => call[1]);
    expect(paths.filter((path) => path.endsWith("/start"))).toHaveLength(2);
    expect(paths.filter((path) => path.endsWith("/message"))).toHaveLength(2);
    expect(store.getSnapshot().started).toBe(true);
    harness.emit(operationId, { type: "complete" });
    disposeAnalysisStore(operationId);
  });

  it("stops through the endpoint, preserves output, rejects late events, and starts fresh on the next send", async () => {
    const harness = createHarness();
    const operationId = "operation-store-stop";
    const store = getAnalysisStore(operationId, harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));

    await sendWithConnected(store, harness, operationId, "First analysis");
    harness.emit(operationId, { type: "tool", title: "wiki_read", status: "running" });
    harness.emit(operationId, { type: "chunk", text: "Confirmed answer" });
    harness.emit(operationId, { type: "artifact", artifact: { id: "artifact-1", title: "Evidence", html: "<p>evidence</p>", createdAt: 1 } });
    const beforeStop = store.getSnapshot();

    await store.stop();
    expect(harness.fetch.mock.calls.map((call) => call[1])).toContain(`analysis/${operationId}/stop`);
    expect(harness.streamOpen()).toBe(false);
    expect(store.getSnapshot()).toMatchObject({
      started: false,
      busy: false,
      phase: "stopped",
      entries: beforeStop.entries,
      artifacts: beforeStop.artifacts,
      latestActivity: { kind: "writing" },
    });

    harness.emitLate(operationId, { type: "chunk", text: " late output" });
    harness.emitLate(operationId, { type: "artifact", artifact: { id: "late", title: "Late", html: "<p>late</p>", createdAt: 2 } });
    harness.emitLate(operationId, { type: "complete" });
    expect(store.getSnapshot()).toMatchObject({ phase: "stopped", entries: beforeStop.entries, artifacts: beforeStop.artifacts });

    await sendWithConnected(store, harness, operationId, "Fresh analysis");
    const paths = harness.fetch.mock.calls.map((call) => call[1]);
    expect(paths.filter((path) => path.endsWith("/start"))).toHaveLength(2);
    expect(paths.filter((path) => path.endsWith("/message"))).toHaveLength(2);
    expect(store.getSnapshot()).toMatchObject({ started: true, busy: true, phase: "starting" });
    harness.emit(operationId, { type: "complete" });
    disposeAnalysisStore(operationId);
  });

  it("stops the server before reset, clears shared history and artifacts, and rejects late events", async () => {
    const harness = createHarness();
    const operationId = "operation-store-reset";
    const store = getAnalysisStore(operationId, harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));

    await sendWithConnected(store, harness, operationId, "Review this session");
    harness.emit(operationId, { type: "chunk", text: "Confirmed answer" });
    harness.emit(operationId, { type: "artifact", artifact: { id: "artifact-1", title: "Evidence", html: "<p>evidence</p>", createdAt: 1 } });
    harness.emit(operationId, { type: "complete" });

    await store.reset();
    const resetPaths = harness.fetch.mock.calls.map((call) => call[1]);
    expect(resetPaths).toContain(`analysis/${operationId}/stop`);
    expect(resetPaths).toContain(`analysis/${operationId}/artifacts`);
    expect(resetPaths.indexOf(`analysis/${operationId}/artifacts`)).toBeGreaterThan(resetPaths.indexOf(`analysis/${operationId}/stop`));
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

    harness.emitLate(operationId, { type: "chunk", text: "late output" });
    harness.emitLate(operationId, { type: "artifact", artifact: { id: "late", title: "Late", html: "<p>late</p>", createdAt: 2 } });
    expect(store.getSnapshot()).toMatchObject({ phase: "idle", entries: [], artifacts: [] });
    disposeAnalysisStore(operationId);
  });

  it("clears server artifacts on idle reset and completes when the clear fails", async () => {
    const harness = createHarness((path) => path.endsWith("/artifacts")
      ? new Response(JSON.stringify({ error: { code: "analysis_clear_failed", message: "Artifacts did not clear." } }), { status: 500, headers: { "Content-Type": "application/json" } })
      : null);
    const store = getAnalysisStore("operation-store-idle-reset", harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));

    await expect(store.reset()).resolves.toBeUndefined();
    const paths = harness.fetch.mock.calls.map((call) => call[1]);
    expect(paths).toContain("analysis/operation-store-idle-reset/artifacts");
    expect(paths.some((path) => path.endsWith("/stop"))).toBe(false);
    expect(store.getSnapshot()).toMatchObject({ phase: "idle", entries: [], artifacts: [], error: null });
    disposeAnalysisStore("operation-store-idle-reset");
  });

  it("preserves history and artifacts when reset cannot stop the server", async () => {
    const harness = createHarness((path) => path.endsWith("/stop")
      ? new Response(JSON.stringify({ error: { code: "analysis_stop_failed", message: "Process did not stop." } }), { status: 500, headers: { "Content-Type": "application/json" } })
      : null);
    const store = getAnalysisStore("operation-store-reset-fail", harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));
    const operationId = "operation-store-reset-fail";
    await sendWithConnected(store, harness, operationId, "Review this session");
    harness.emit(operationId, { type: "chunk", text: "Keep this answer" });
    harness.emit(operationId, { type: "artifact", artifact: { id: "artifact-1", title: "Keep this", html: "<p>keep</p>", createdAt: 1 } });

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

  it("aborts a stalled start before disposal stops it and orders a replacement start after teardown", async () => {
    let startCount = 0;
    let firstStartSignal: AbortSignal | undefined;
    const requestOrder: string[] = [];
    const harness = createHarness((path, init) => {
      if (path.endsWith("/stop")) {
        requestOrder.push("stop");
        return null;
      }
      if (!path.endsWith("/start")) return null;
      startCount += 1;
      if (startCount > 1) {
        requestOrder.push("start-2");
        return null;
      }
      requestOrder.push("start-1");
      firstStartSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        firstStartSignal?.addEventListener("abort", () => {
          requestOrder.push("abort-1");
          reject(new DOMException("Analysis start aborted.", "AbortError"));
        }, { once: true });
      });
    });
    const first = getAnalysisStore("operation-store-dispose-during-start", harness.api);
    const operationId = "operation-store-dispose-during-start";
    await vi.waitFor(() => expect(first.getSnapshot().cliId).toBe("claude"));

    const firstSend = first.send("Review this session");
    await vi.waitFor(() => expect(harness.fetch.mock.calls.some((call) => call[1].endsWith("/start"))).toBe(true));
    disposeAnalysisStore(operationId);
    expect(firstStartSignal?.aborted).toBe(true);
    const replacement = getAnalysisStore(operationId, harness.api);
    expect(replacement).not.toBe(first);
    await vi.waitFor(() => expect(replacement.getSnapshot().cliId).toBe("claude"));
    const replacementSend = replacement.send("Start fresh");
    await firstSend;
    await vi.waitFor(() => expect(harness.streamReady()).toBe(true));
    harness.emitRoster([operationId]);
    await replacementSend;

    const paths = harness.fetch.mock.calls.map((call) => call[1]);
    const stopIndex = paths.indexOf(`analysis/${operationId}/stop`);
    expect(paths.filter((path) => path.endsWith("/start"))).toHaveLength(2);
    expect(stopIndex).toBeGreaterThan(paths.indexOf(`analysis/${operationId}/start`));
    expect(stopIndex).toBeLessThan(paths.lastIndexOf(`analysis/${operationId}/start`));
    expect(paths.filter((path) => path.endsWith("/message"))).toHaveLength(1);
    expect(requestOrder).toEqual(["start-1", "abort-1", "stop", "start-2"]);
    harness.emit(operationId, { type: "complete" });
    disposeAnalysisStore(operationId);
  });

  it("reports stop failure without leaving the store busy or subscribed", async () => {
    const harness = createHarness((path) => path.endsWith("/stop")
      ? new Response(JSON.stringify({ error: { code: "analysis_stop_failed", message: "Process did not stop." } }), { status: 500, headers: { "Content-Type": "application/json" } })
      : null);
    const operationId = "operation-store-stop-fail";
    const store = getAnalysisStore(operationId, harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));
    await sendWithConnected(store, harness, operationId, "Review this session");

    await store.stop();
    expect(store.getSnapshot()).toMatchObject({
      started: false,
      busy: false,
      phase: "error",
      error: "Stop failed: Process did not stop.",
    });
    expect(harness.streamOpen()).toBe(false);
    disposeAnalysisStore(operationId);
  });

  it("waits for Stop to settle before starting the next fresh session", async () => {
    let resolveStop!: (response: Response) => void;
    const stopResponse = new Promise<Response>((resolve) => { resolveStop = resolve; });
    const harness = createHarness((path) => path.endsWith("/stop") ? stopResponse : null);
    const operationId = "operation-store-stop-then-send";
    const store = getAnalysisStore(operationId, harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));
    await sendWithConnected(store, harness, operationId, "First analysis");

    const stopping = store.stop();
    const restarting = store.send("Fresh analysis");
    await Promise.resolve();
    expect(harness.fetch.mock.calls.map((call) => call[1]).filter((path) => path.endsWith("/start"))).toHaveLength(1);

    resolveStop(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    await stopping;
    await vi.waitFor(() => expect(harness.streamReady()).toBe(true));
    harness.emitRoster([operationId]);
    await restarting;
    expect(harness.fetch.mock.calls.map((call) => call[1]).filter((path) => path.endsWith("/start"))).toHaveLength(2);
    harness.emit(operationId, { type: "complete" });
    disposeAnalysisStore(operationId);
  });

  it("unsubscribes after an analysis_exited stream event and restarts on the next send", async () => {
    const harness = createHarness();
    const operationId = "operation-store-stream-lost";
    const store = getAnalysisStore(operationId, harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));

    await sendWithConnected(store, harness, operationId, "First attempt");
    harness.emit(operationId, { type: "error", error: { code: "analysis_exited", message: "Process exited." } });
    expect(store.getSnapshot()).toMatchObject({ started: false, busy: false, error: "Analysis session ended — send again to restart." });
    expect(harness.streamOpen()).toBe(false);

    await sendWithConnected(store, harness, operationId, "Second attempt");
    expect(harness.fetch.mock.calls.map((call) => call[1]).filter((path) => path.endsWith("/start"))).toHaveLength(2);
    harness.emit(operationId, { type: "complete" });
    disposeAnalysisStore(operationId);
  });

  it("shares one physical EventSource across six capability-distinct stores", async () => {
    const harness = createHarness();
    const operationIds = Array.from({ length: 6 }, (_value, index) => `operation-store-multiplex-${index}`);
    const apis = operationIds.map((_operationId, index) => ({ ...harness.api, marker: index }));
    const stores = operationIds.map((operationId, index) => getAnalysisStore(operationId, apis[index]!));
    await Promise.all(stores.map((store) => vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"))));
    await Promise.all(stores.map((store, index) => sendWithConnected(store, harness, operationIds[index]!, `Question ${index}`)));
    expect(harness.eventSourceCount()).toBe(1);
    expect(TestEventSource.instances[0]?.url).toBe("/plugins/terminal/analysis/stream");
    expect(harness.subscribe).not.toHaveBeenCalled();
    harness.emit(operationIds[0]!, { type: "chunk", text: "alpha" });
    harness.emit(operationIds[5]!, { type: "chunk", text: "zeta" });
    expect(stores[0]!.getSnapshot().entries.at(-1)).toMatchObject({ role: "analyst", segments: [{ text: "alpha", steps: [] }] });
    expect(stores[5]!.getSnapshot().entries.at(-1)).toMatchObject({ role: "analyst", segments: [{ text: "zeta", steps: [] }] });
    expect(stores[1]!.getSnapshot().entries.filter((entry) => entry.role === "analyst")).toHaveLength(0);
    disposeAnalysisStore(operationIds[0]!);
    expect(harness.streamOpen()).toBe(true);
    for (const operationId of operationIds.slice(1)) disposeAnalysisStore(operationId);
    expect(harness.streamOpen()).toBe(false);
  });

  it("rejects only confirmed subscriptions missing from a reconnect roster", async () => {
    const harness = createHarness();
    const kept = "operation-store-reconnect-kept";
    const lost = "operation-store-reconnect-lost";
    const pending = "operation-store-reconnect-pending";
    const keptStore = getAnalysisStore(kept, harness.api);
    const lostStore = getAnalysisStore(lost, harness.api);
    await vi.waitFor(() => expect(keptStore.getSnapshot().cliId).toBe("claude"));
    await sendWithConnected(keptStore, harness, kept, "Keep me");
    await sendWithConnected(lostStore, harness, lost, "Lose me");
    const pendingEvents: unknown[] = [];
    const unsubscribePending = subscribeAnalysis(harness.api, pending, (event) => { pendingEvents.push(event); });
    harness.replaceRoster([kept]);
    expect(lostStore.getSnapshot().error).toBe("Analysis session ended — send again to restart.");
    expect(keptStore.getSnapshot().error).toBeNull();
    expect(pendingEvents.some((event) => (event as { type?: string }).type === "error")).toBe(false);
    unsubscribePending();
    disposeAnalysisStore(kept);
    disposeAnalysisStore(lost);
  });

  it("ignores malformed connected frames without evicting confirmed sessions", async () => {
    const harness = createHarness();
    const operationId = "operation-store-malformed-roster";
    const store = getAnalysisStore(operationId, harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));
    await sendWithConnected(store, harness, operationId, "Stay connected");
    harness.deliverRaw(JSON.stringify({ type: "connected", operationIds: [operationId, 1] }));
    expect(store.getSnapshot()).toMatchObject({ started: true, error: null });
    disposeAnalysisStore(operationId);
  });

  it("does not infer session loss from CONNECTING transport errors", async () => {
    const harness = createHarness();
    const operationId = "operation-store-connecting-error";
    const store = getAnalysisStore(operationId, harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));
    const pending = store.send("Hold connection");
    await vi.waitFor(() => expect(harness.streamReady()).toBe(true));
    const source = TestEventSource.instances[0]!;
    expect(source.readyState).toBe(TestEventSource.CONNECTING);
    source.triggerError();
    expect(harness.eventSourceCount()).toBe(1);
    harness.emitRoster([operationId]);
    await pending;
    expect(store.getSnapshot().error).toBeNull();
    harness.emit(operationId, { type: "complete" });
    disposeAnalysisStore(operationId);
  });

  it("recovers from fatal CLOSED sources with one pending timer per close and identity-safe callbacks", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const operationId = "operation-store-fatal-reconnect";
    const store = getAnalysisStore(operationId, harness.api);
    await vi.waitFor(() => expect(store.getSnapshot().cliId).toBe("claude"));
    const pending = store.send("Need stream");
    await vi.waitFor(() => expect(harness.streamReady()).toBe(true));

    const first = TestEventSource.instances[0]!;
    first.readyState = TestEventSource.CLOSED;
    first.triggerError();
    first.triggerError();
    expect(harness.eventSourceCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(250);
    expect(harness.eventSourceCount()).toBe(2);

    const staleCallback = first.onmessage;
    first.open();
    staleCallback?.({ data: JSON.stringify({ type: "connected", operationIds: ["wrong-operation"] }) } as MessageEvent<string>);
    expect(store.getSnapshot().error).toBeNull();

    const second = TestEventSource.instances[1]!;
    second.open();
    harness.emitRoster([operationId]);
    await pending;

    second.readyState = TestEventSource.CLOSED;
    second.triggerError();
    expect(harness.eventSourceCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(harness.eventSourceCount()).toBe(3);

    const third = TestEventSource.instances[2]!;
    third.open();
    harness.emit(operationId, { type: "complete" });
    disposeAnalysisStore(operationId);
    vi.useRealTimers();
  });
});

describe("analysis stream hub reconnect delays", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", TestEventSource);
  });

  it("uses bounded exponential recreation delays for consecutive CLOSED failures without roster frames", async () => {
    vi.useFakeTimers();
    const api = { fetch: vi.fn(), subscribe: vi.fn(), resync: vi.fn() } satisfies ClientApiCapability;
    const expectedDelays = [250, 500, 1000, 2000, 4000, 4000] as const;
    const unsubscribe = subscribeAnalysis(api, "operation-hub-backoff", () => {});

    expect(TestEventSource.instances).toHaveLength(1);
    expect(TestEventSource.instances[0]?.readyState).toBe(TestEventSource.CONNECTING);

    let sourceCount = 1;
    for (const [index, delay] of expectedDelays.entries()) {
      const source = TestEventSource.instances.at(-1)!;
      source.readyState = TestEventSource.CLOSED;
      source.triggerError();
      if (index === 0) source.triggerError();
      expect(TestEventSource.instances).toHaveLength(sourceCount);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(TestEventSource.instances).toHaveLength(sourceCount);
      await vi.advanceTimersByTimeAsync(1);
      sourceCount += 1;
      expect(TestEventSource.instances).toHaveLength(sourceCount);
      expect(TestEventSource.instances.at(-1)?.readyState).toBe(TestEventSource.CONNECTING);
    }

    const pending = TestEventSource.instances.at(-1)!;
    pending.readyState = TestEventSource.CLOSED;
    pending.triggerError();
    await vi.advanceTimersByTimeAsync(3999);
    expect(TestEventSource.instances).toHaveLength(sourceCount);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(TestEventSource.instances).toHaveLength(sourceCount);

    vi.useRealTimers();
  });
});

function messageBodies(harness: StreamHarness): string[] {
  return harness.fetch.mock.calls
    .filter((call) => String(call[1]).endsWith("/message"))
    .map((call) => JSON.parse(String((call[2] as RequestInit | undefined)?.body)).text as string);
}
