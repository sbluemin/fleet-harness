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
});

function messageBodies(harness: StreamHarness): string[] {
  return harness.fetch.mock.calls
    .filter((call) => String(call[1]).endsWith("/message"))
    .map((call) => JSON.parse(String((call[2] as RequestInit | undefined)?.body)).text as string);
}
