import { describe, expect, it, vi } from "vitest";
import type { ClientApiCapability } from "@fleet-console/sdk/plugin";

import { disposeAnalysisStore, getAnalysisStore } from "./analysis-store.js";

const CATALOG_BODY = JSON.stringify({ clis: [{ cliId: "claude", label: "Claude", available: true, defaultModel: "sonnet", models: [{ id: "sonnet", label: "Sonnet", effortLevels: ["high"], defaultEffort: "high" }] }] });

interface StreamHarness {
  readonly api: ClientApiCapability;
  readonly fetch: ReturnType<typeof vi.fn>;
  readonly emit: (payload: unknown) => void;
  readonly streamReady: () => boolean;
}

function createHarness(onPath?: (path: string) => Response | null): StreamHarness {
  let stream: ((event: MessageEvent<string>) => void) | null = null;
  const fetch = vi.fn(async (_pluginId: string, path: string) => {
    const override = onPath?.(path);
    if (override) return override;
    return new Response(path === "analysis/catalog" ? CATALOG_BODY : "{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const api = {
    fetch,
    subscribe: (_pluginId: string, _path: string, listener: (event: MessageEvent<string>) => void) => {
      stream = listener;
      return vi.fn();
    },
    resync: vi.fn(),
  } satisfies ClientApiCapability;
  return {
    api,
    fetch,
    emit: (payload) => stream?.({ data: JSON.stringify(payload) } as MessageEvent<string>),
    streamReady: () => stream !== null,
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
});
