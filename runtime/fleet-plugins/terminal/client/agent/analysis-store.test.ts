import { describe, expect, it, vi } from "vitest";
import type { ClientApiCapability } from "@fleet-console/sdk/plugin";

import { disposeAnalysisStore, getAnalysisStore } from "./analysis-store.js";

describe("per-operation analysis store", () => {
  it("shares state and owns start, message, SSE, and unused-store stop", async () => {
    let stream: ((event: MessageEvent<string>) => void) | null = null;
    const fetch = vi.fn(async (_pluginId: string, path: string) => new Response(
      path === "analysis/catalog"
        ? JSON.stringify({ clis: [{ cliId: "claude", label: "Claude", available: true, defaultModel: "sonnet", models: [{ id: "sonnet", label: "Sonnet", effortLevels: ["high"], defaultEffort: "high" }] }] })
        : "{}",
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    const api = {
      fetch,
      subscribe: (_pluginId: string, _path: string, listener: (event: MessageEvent<string>) => void) => {
        stream = listener;
        return vi.fn();
      },
      resync: vi.fn(),
    } satisfies ClientApiCapability;
    const first = getAnalysisStore("operation-store-test", api);
    const second = getAnalysisStore("operation-store-test", api);
    const releaseChat = first.retain();
    const releaseArtifacts = second.retain();
    await vi.waitFor(() => expect(first.getSnapshot().cliId).toBe("claude"));

    expect(second).toBe(first);
    await first.send("Review this session");
    expect(fetch.mock.calls.map((call) => call[1])).toEqual([
      "analysis/catalog",
      "analysis/operation-store-test/start",
      "analysis/operation-store-test/message",
    ]);
    (stream as ((event: MessageEvent<string>) => void) | null)?.({ data: JSON.stringify({ type: "chunk", text: "Looks good" }) } as MessageEvent<string>);
    expect(second.getSnapshot().entries.at(-1)).toEqual({ role: "analyst", text: "Looks good" });

    releaseChat();
    releaseArtifacts();
    await vi.waitFor(() => expect(fetch.mock.calls.some((call) => call[1] === "analysis/operation-store-test/stop")).toBe(true));
    disposeAnalysisStore("operation-store-test");
  });
});
