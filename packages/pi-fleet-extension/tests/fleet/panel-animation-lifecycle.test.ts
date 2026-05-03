import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  admiral,
  infra,
  type CarrierJobRecord,
} from "@sbluemin/fleet-core";
import {
  bindPanelBackgroundJobAnimation,
  detachAgentPanelUi,
  endColStreaming,
  ensureAnimTimer,
} from "../../src/panel/ui.js";
import { getState, handleCarrierJobStreamEvent, resetPanelStateForTest } from "../../src/panel/state.js";
import { syncWidget } from "../../src/panel/widget-sync.js";
import type { AgentCol } from "../../src/panel/types.js";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const { CARRIER_FRAMEWORK_KEY } = admiral.carrier;
const { SPINNER_FRAMES } = admiral.constants;
const {
  acquireJobPermit,
  getActiveBackgroundJobCount,
  resetJobConcurrencyForTest,
} = infra.job;

beforeEach(() => {
  vi.useFakeTimers();
  resetJobConcurrencyForTest();
  resetPanelStateForTest();
  (globalThis as any)[CARRIER_FRAMEWORK_KEY] = {
    modes: new Map([["genesis", { config: { id: "genesis", displayName: "Genesis", cliType: "codex", slot: 1, color: "" } }]]),
    registeredOrder: ["genesis"],
    offlineCarriers: new Set(),
    taskforceConfiguredCarriers: new Set(),
    squadronEnabledCarriers: new Set(),
    statusUpdateCallbacks: [],
  };
});

afterEach(() => {
  detachAgentPanelUi();
  resetJobConcurrencyForTest();
  vi.useRealTimers();
});

describe("panel animation lifecycle", () => {
  it("stops the timer when no column is streaming and no background job is active", () => {
    const state = getState();
    state.cols = [buildCol("done")];
    ensureAnimTimer();
    expect(state.animTimer).not.toBeNull();

    endColStreaming(buildCtx(), 0);

    expect(state.animTimer).toBeNull();
  });

  it("keeps the timer when streaming ends while a background job is active", () => {
    const state = getState();
    state.cols = [buildCol("done")];
    const permit = acquireJobPermit(buildRecord("sortie:active", ["genesis"]));
    expect(permit.accepted).toBe(true);
    ensureAnimTimer();

    endColStreaming(buildCtx(), 0);

    expect(state.animTimer).not.toBeNull();
  });

  it("restarts the timer on the idle to active background job transition", () => {
    const state = getState();
    bindPanelBackgroundJobAnimation();
    expect(state.animTimer).toBeNull();

    const permit = acquireJobPermit(buildRecord("sortie:active", ["genesis"]));

    expect(permit.accepted).toBe(true);
    expect(getActiveBackgroundJobCount()).toBe(1);
    expect(state.animTimer).not.toBeNull();
  });

  it("stops the timer after active background jobs reach zero", () => {
    const state = getState();
    bindPanelBackgroundJobAnimation();
    const permit = acquireJobPermit(buildRecord("sortie:active", ["genesis"]));
    if (!permit.accepted) throw new Error("expected permit");
    expect(state.animTimer).not.toBeNull();

    permit.release({ status: "done", finishedAt: 2000 });
    vi.advanceTimersByTime(100);

    expect(getActiveBackgroundJobCount()).toBe(0);
    expect(state.animTimer).toBeNull();
  });

  it("renders carrier status as streaming while background jobs are active", async () => {
    const state = getState();
    state.streaming = false;
    state.frame = 0;
    state.cols = [buildCol("stream")];
    const permit = acquireJobPermit(buildRecord("sortie:active", ["genesis"]));
    expect(permit.accepted).toBe(true);
    const ctx = buildCtx();

    syncWidget(ctx);
    await Promise.resolve();
    const statusFactory = ctx.ui.setWidget.mock.calls.find((call: any[]) => call[0] === "fleet-carrier-status")?.[1];
    const rendered = statusFactory({}, {}).render(80).join("\n");

    expect(stripAnsi(rendered)).not.toContain("○ Genesis");
  });

  it("renders carrier status as idle when neither streaming nor background jobs are active", async () => {
    const state = getState();
    state.streaming = false;
    state.frame = 0;
    state.cols = [buildCol("stream")];
    const ctx = buildCtx();

    syncWidget(ctx);
    await Promise.resolve();
    const statusFactory = ctx.ui.setWidget.mock.calls.find((call: any[]) => call[0] === "fleet-carrier-status")?.[1];
    const rendered = statusFactory({}, {}).render(80).join("\n");

    expect(stripAnsi(rendered)).toContain("○");
  });

  it("renders carrier status as animated for active squadron jobs even when the column is wait", async () => {
    const state = getState();
    state.streaming = false;
    state.frame = 1;
    state.cols = [buildCol("wait")];
    const permit = acquireJobPermit(buildRecord("squadron:active", ["genesis"], "carrier_squadron"));
    expect(permit.accepted).toBe(true);
    handleCarrierJobStreamEvent({
      type: "job:registered",
      jobId: "squadron:active",
      kind: "squadron",
      ownerCarrierId: "genesis",
      label: "1 subtask",
      startedAt: Date.now(),
      tracks: [{
        trackId: "squadron:active:0",
        streamKey: "squadron:genesis:0",
        displayCli: "genesis",
        displayName: "Subtask",
        kind: "subtask",
      }],
    });
    const ctx = buildCtx();

    syncWidget(ctx);
    await Promise.resolve();
    const statusFactory = ctx.ui.setWidget.mock.calls.find((call: any[]) => call[0] === "fleet-carrier-status")?.[1];
    const rendered = statusFactory({}, {}).render(80).join("\n");
    const plainText = stripAnsi(rendered);

    expect(plainText).toContain(`${SPINNER_FRAMES[1]} Genesis`);
    expect(plainText).not.toContain("○ Genesis");
  });

  it("renders carrier status as animated for active taskforce jobs even when the column is wait", async () => {
    const state = getState();
    state.streaming = false;
    state.frame = 2;
    state.cols = [buildCol("wait")];
    const permit = acquireJobPermit(buildRecord("taskforce:active", ["genesis"], "carrier_taskforce"));
    expect(permit.accepted).toBe(true);
    handleCarrierJobStreamEvent({
      type: "job:registered",
      jobId: "taskforce:active",
      kind: "taskforce",
      ownerCarrierId: "genesis",
      label: "1 backend",
      startedAt: Date.now(),
      tracks: [{
        trackId: "taskforce:active:codex",
        streamKey: "taskforce:genesis:codex",
        displayCli: "codex",
        displayName: "Codex",
        kind: "backend",
      }],
    });
    const ctx = buildCtx();

    syncWidget(ctx);
    await Promise.resolve();
    const statusFactory = ctx.ui.setWidget.mock.calls.find((call: any[]) => call[0] === "fleet-carrier-status")?.[1];
    const rendered = statusFactory({}, {}).render(80).join("\n");
    const plainText = stripAnsi(rendered);

    expect(plainText).toContain(`${SPINNER_FRAMES[2]} Genesis`);
    expect(plainText).not.toContain("○ Genesis");
  });
});

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function buildRecord(
  jobId: string,
  carriers: string[],
  tool: CarrierJobRecord["tool"] = "carrier_genesis",
): CarrierJobRecord {
  return {
    jobId,
    tool,
    status: "active",
    startedAt: 1000,
    carriers,
  };
}

function buildCol(status: AgentCol["status"]): AgentCol {
  return {
    cli: "genesis",
    text: "",
    blocks: [],
    thinking: "",
    toolCalls: [],
    status,
    scroll: 0,
  };
}

function buildCtx(): any {
  return {
    ui: { setWidget: vi.fn() },
    sessionManager: { getSessionId: () => "test-session" },
  };
}
