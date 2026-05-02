import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeWithPool: vi.fn(),
}));

vi.mock("@sbluemin/fleet-core/admiral/agent-runtime", () => ({
  executeWithPool: mocks.executeWithPool,
  getSessionStore: vi.fn(() => ({
    get: vi.fn(),
    set: vi.fn(),
    clear: vi.fn(),
    getAll: vi.fn(() => ({})),
    restore: vi.fn(),
  })),
}));

vi.mock("../../src/fleet.js", () => ({
  getFleetRuntime: () => ({}),
  withAgentRequestContext: async (_ctx: any, callback: () => Promise<unknown>) => callback(),
}));

import {
  exposeAgentApi,
  runAgentRequest,
} from "../../src/agent/runner.js";
import {
  getPanelRuns,
  getState,
  handleCarrierJobStreamEvent,
  resetPanelStateForTest,
} from "../../src/agent/ui/panel/state.js";
import { CARRIER_FRAMEWORK_KEY } from "@sbluemin/fleet-core/admiral/carrier";

beforeEach(() => {
  mocks.executeWithPool.mockReset();
  mocks.executeWithPool.mockResolvedValue(createRuntimeResult("run"));
  resetPanelGlobals();
});

describe("operation runner adapter", () => {
  it("strips ctx and delegates foreground requests to admiral agent-runtime", async () => {
    const ctx = makeCtx();

    const result = await runAgentRequest({
      cli: "codex",
      carrierId: "genesis",
      request: "work",
      ctx: ctx as any,
    });

    expect(result.responseText).toBe("run");
    expect(mocks.executeWithPool).toHaveBeenCalledWith(expect.objectContaining({
      cliType: "codex",
      carrierId: "genesis",
      request: "work",
      cwd: "/workspace",
    }));
    expect(mocks.executeWithPool).toHaveBeenCalledWith(expect.not.objectContaining({ ctx: expect.anything() }));
  });

  it("exposes the unified-agent bridge", async () => {
    const bridge = exposeAgentApi();

    expect(typeof runAgentRequest).toBe("function");
    await expect(bridge.requestUnifiedAgent({
      cli: "codex",
      carrierId: "genesis",
      request: "work",
      ctx: makeCtx() as any,
    })).resolves.toEqual(createRunnerResult("run"));
  });

  it("maps carrier job stream events to panel column lifecycle", () => {
    emitSingleTrackJob("job-1", "genesis");

    handleCarrierJobStreamEvent({ type: "track:begin", jobId: "job-1", trackId: "genesis" });
    handleCarrierJobStreamEvent({ type: "track:status", jobId: "job-1", trackId: "genesis", status: "stream" });
    handleCarrierJobStreamEvent({ type: "track:thought", jobId: "job-1", trackId: "genesis", text: "think" });
    handleCarrierJobStreamEvent({
      type: "track:tool",
      jobId: "job-1",
      trackId: "genesis",
      title: "Read",
      status: "done",
      toolCallId: "tool-1",
    });
    handleCarrierJobStreamEvent({ type: "track:text", jobId: "job-1", trackId: "genesis", text: "hello" });
    handleCarrierJobStreamEvent({
      type: "track:finalized",
      jobId: "job-1",
      trackId: "genesis",
      status: "done",
      sessionId: "session-1",
    });
    handleCarrierJobStreamEvent({ type: "job:finalized", jobId: "job-1", status: "done", finishedAt: Date.now(), summary: "" });

    const state = getState();
    expect(state.cols[0]).toMatchObject({
      cli: "genesis",
      status: "done",
      text: "hello",
      thinking: "think",
      sessionId: "session-1",
    });
    expect(state.streaming).toBe(false);
  });

  it("keeps same-carrier foreground streams isolated by request id", () => {
    const firstRunId = "run-1";
    const secondRunId = "run-2";

    emitSingleTrackJob("job-1", "genesis", firstRunId);
    emitSingleTrackJob("job-2", "genesis", secondRunId);
    handleCarrierJobStreamEvent({ type: "track:text", jobId: "job-1", trackId: "genesis", text: "first" });
    handleCarrierJobStreamEvent({ type: "track:text", jobId: "job-2", trackId: "genesis", text: "second" });
    handleCarrierJobStreamEvent({ type: "track:finalized", jobId: "job-1", trackId: "genesis", status: "done" });
    handleCarrierJobStreamEvent({ type: "track:finalized", jobId: "job-2", trackId: "genesis", status: "done" });

    expect(firstRunId).not.toBe(secondRunId);
    expect(getPanelRuns().get(firstRunId)?.text).toBe("first");
    expect(getPanelRuns().get(secondRunId)?.text).toBe("second");
    expect(getState().cols[0]).toMatchObject({
      status: "done",
      text: "second",
    });
  });

  it("short-circuits panel stream events when the carrier column is missing", () => {
    emitSingleTrackJob("job-missing", "missing");
    handleCarrierJobStreamEvent({ type: "track:text", jobId: "job-missing", trackId: "missing", text: "ignored" });
    handleCarrierJobStreamEvent({ type: "track:finalized", jobId: "job-missing", trackId: "missing", status: "done" });

    expect(getState().cols[0]?.text).toBe("");
  });

});

function createRuntimeResult(responseText: string) {
  return {
    status: "done",
    responseText,
    thoughtText: "think",
    connectionInfo: { sessionId: "session-1" },
    error: undefined,
    toolCalls: [{ title: "Read", status: "done", timestamp: 1 }],
    streamData: {
      text: responseText,
      thinking: "think",
      toolCalls: [{ title: "Read", status: "done" }],
      blocks: [{ type: "text", text: responseText }],
      lastStatus: "done",
    },
  };
}

function createRunnerResult(responseText: string) {
  return {
    status: "done",
    responseText,
    sessionId: "session-1",
    error: undefined,
    thinking: "think",
    toolCalls: [{ title: "Read", status: "done" }],
    streamData: {
      text: responseText,
      thinking: "think",
      toolCalls: [{ title: "Read", status: "done" }],
      blocks: [{ type: "text", text: responseText }],
      lastStatus: "done",
    },
  };
}

function resetPanelGlobals(): void {
  resetPanelStateForTest();
  (globalThis as any)[CARRIER_FRAMEWORK_KEY] = {
    modes: new Map(),
    registeredOrder: ["genesis"],
    statusUpdateCallbacks: [],
  };
}

function emitSingleTrackJob(jobId: string, carrierId: string, runId?: string): void {
  handleCarrierJobStreamEvent({
    type: "job:registered",
    jobId,
    kind: "sortie",
    ownerCarrierId: carrierId,
    label: carrierId,
    startedAt: Date.now(),
    tracks: [{
      trackId: carrierId,
      streamKey: `${carrierId}:${jobId}`,
      displayCli: carrierId,
      displayName: carrierId,
      kind: "carrier",
      runId,
    }],
  });
}

function makeCtx(sessionId = "session-1"): { cwd: string; sessionManager: { getSessionId: () => string }; ui: { setWidget: ReturnType<typeof vi.fn> } } {
  return {
    cwd: "/workspace",
    sessionManager: { getSessionId: () => sessionId },
    ui: { setWidget: vi.fn() },
  };
}
