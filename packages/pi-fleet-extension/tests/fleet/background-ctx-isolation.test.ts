import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeWithPool: vi.fn(async (_options: any) => ({
    status: "done",
    responseText: "ok",
    thoughtText: "thinking",
    toolCalls: [{ title: "Read", status: "done" }],
    streamData: {
      text: "ok",
      thinking: "thinking",
      toolCalls: [{ title: "Read", status: "done" }],
      blocks: [{ type: "text", text: "ok" }],
      lastStatus: "done",
    },
    connectionInfo: { sessionId: "session-1" },
  })),
}));

import {
  getState,
  handleCarrierJobStreamEvent,
  resetPanelStateForTest,
  syncColsWithRegisteredOrder,
} from "../../src/panel/state.js";
import * as panelState from "../../src/panel/state.js";
import { CARRIER_FRAMEWORK_KEY } from "@sbluemin/fleet-core/admiral/carrier";
import { syncCurrentWidget, syncWidget } from "../../src/panel/widget-sync.js";

function isStaleExtensionContextError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (message.includes("agent listener invoked outside active run")) return true;
  const mentionsExtensionCtx =
    message.includes("extensioncontext") ||
    message.includes("extension ctx") ||
    message.includes("extension context");
  const mentionsStaleSession =
    message.includes("stale") ||
    message.includes("session") ||
    message.includes("replacement") ||
    message.includes("reload");
  return mentionsExtensionCtx && mentionsStaleSession;
}

describe("background ctx isolation", () => {
  it("runs background carrier requests through agent-runtime with explicit cwd and no ExtensionContext", async () => {
    resetPanelGlobals();

    const result = await mocks.executeWithPool({
      cliType: "codex",
      carrierId: "genesis",
      request: "work",
      cwd: "/tmp/background",
    });

    expect(result.status).toBe("done");
    expect(mocks.executeWithPool).toHaveBeenCalledWith(expect.objectContaining({
      cliType: "codex",
      carrierId: "genesis",
      cwd: "/tmp/background",
    }));
    expect(mocks.executeWithPool).toHaveBeenCalledWith(expect.not.objectContaining({ ctx: expect.anything() }));
    expect(result.toolCalls).toEqual([{ title: "Read", status: "done" }]);
  });

  it("classifies outside-active-run and stale context errors only", () => {
    expect(isStaleExtensionContextError(new Error("Agent listener invoked outside active run"))).toBe(true);
    expect(isStaleExtensionContextError(new Error("stale extension context after session replacement"))).toBe(true);
    expect(isStaleExtensionContextError(new Error("ordinary renderer failure"))).toBe(false);
  });

  it("detaches stale widget ctx without crashing background-safe updates", async () => {
    resetPanelGlobals();
    const staleCtx = makeCtx(new Error("Agent listener invoked outside active run"));
    syncWidget(staleCtx as any);
    syncCurrentWidget();
    await Promise.resolve();
  });

  it("resolves foreground request ctx for panel lifecycle after ctx-less runtime initialization", async () => {
    resetPanelGlobals();
    const ctx = {
      sessionManager: { getSessionId: () => "session-1" },
      ui: { setWidget: vi.fn() },
    };

    syncColsWithRegisteredOrder();
    getState().cols = [{ cli: "genesis", text: "", blocks: [], thinking: "", toolCalls: [], status: "wait", scroll: 0 }];
    expect(panelState.findColIndex("genesis")).toBe(0);
    syncWidget(ctx as any);
    emitSingleTrackJob("job-1");
    handleCarrierJobStreamEvent({ type: "track:begin", jobId: "job-1", trackId: "genesis" });
    handleCarrierJobStreamEvent({ type: "track:finalized", jobId: "job-1", trackId: "genesis", status: "done" });
    handleCarrierJobStreamEvent({ type: "job:finalized", jobId: "job-1", status: "done", finishedAt: Date.now(), summary: "" });
    syncCurrentWidget();
    await Promise.resolve();

    expect(ctx.ui.setWidget).toHaveBeenCalled();
    expect(getState().streaming).toBe(false);
  });

  it("uses the current widget ctx when processing stream events", async () => {
    resetPanelGlobals();
    const ctxA = makeCtx();

    syncColsWithRegisteredOrder();
    getState().cols = [{ cli: "genesis", text: "", blocks: [], thinking: "", toolCalls: [], status: "wait", scroll: 0 }];
    syncWidget(ctxA as any);
    emitSingleTrackJob("job-2");
    handleCarrierJobStreamEvent({ type: "track:begin", jobId: "job-2", trackId: "genesis" });
    handleCarrierJobStreamEvent({ type: "track:finalized", jobId: "job-2", trackId: "genesis", status: "done" });
    handleCarrierJobStreamEvent({ type: "job:finalized", jobId: "job-2", status: "done", finishedAt: Date.now(), summary: "" });
    syncCurrentWidget();
    await Promise.resolve();

    expect(ctxA.ui.setWidget).toHaveBeenCalled();
    expect(getState().streaming).toBe(false);
  });
});

function resetPanelGlobals(): void {
  resetPanelStateForTest();
  (globalThis as any)[CARRIER_FRAMEWORK_KEY] = {
    modes: new Map(),
    registeredOrder: ["genesis"],
    statusUpdateCallbacks: [],
    offlineCarriers: new Set(),
    taskforceConfiguredCarriers: new Set(),
    squadronEnabledCarriers: new Set(),
  };
}

function emitSingleTrackJob(jobId: string): void {
  handleCarrierJobStreamEvent({
    type: "job:registered",
    jobId,
    kind: "sortie",
    ownerCarrierId: "genesis",
    label: "Genesis",
    startedAt: Date.now(),
    tracks: [{
      trackId: "genesis",
      streamKey: `genesis:${jobId}`,
      displayCli: "genesis",
      displayName: "Genesis",
      kind: "carrier",
    }],
  });
}

function makeCtx(error?: Error): { sessionManager: { getSessionId: () => string }; ui: { setWidget: ReturnType<typeof vi.fn> } } {
  const setWidget = vi.fn(() => {
    if (error) throw error;
  });
  return {
    sessionManager: { getSessionId: () => "session-1" },
    ui: { setWidget },
  };
}
