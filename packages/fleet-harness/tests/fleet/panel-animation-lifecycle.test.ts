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
  registerAgentPanelShortcut,
  toggleAgentPanel,
} from "../../src/panel/ui.js";
import { getPanelRuns, getState, handleCarrierJobStreamEvent, resetPanelStateForTest } from "../../src/panel/state.js";
import { syncWidget } from "../../src/panel/widget-sync.js";
import { _bootstrapKeybind, prepareKeybindBridgeForExtensionLoad, type KeybindRegistration } from "../../src/keybinds.js";
import { AgentPanelEditor } from "../../src/panel/editor-panel.js";
import { setupCustomEditor } from "../../src/hud/editor.js";
import type { AgentCol } from "../../src/panel/types.js";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const CARRIER_JOB_HUD_WIDGET_KEY = "fleet-carrier-job-hud";
const CARRIER_BRIDGE_EXPANDED_WIDGET_KEY = "fleet-carrier-bridge-expanded";
const HUD_NOTIFICATION_WIDGET_KEY = "hud-notification";
const LEGACY_CARRIER_STATUS_WIDGET_KEY = "fleet-carrier-status";
const { CARRIER_FRAMEWORK_KEY } = admiral.carrier;
const { SPINNER_FRAMES } = admiral.constants;
const {
  acquireJobPermit,
  getActiveBackgroundJobCount,
  resetJobConcurrencyForTest,
} = infra.job;

beforeEach(() => {
  vi.useFakeTimers();
  prepareKeybindBridgeForExtensionLoad();
  resetJobConcurrencyForTest();
  resetPanelStateForTest();
  (globalThis as any)[CARRIER_FRAMEWORK_KEY] = {
    modes: new Map([["genesis", { config: { id: "genesis", displayName: "Genesis", cliType: "codex", slot: 1, color: "" } }]]),
    registeredOrder: ["genesis"],
    offlineCarriers: new Set(),
    taskforceConfiguredCarriers: new Set(),
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

  it("registers carrier roster aboveEditor and expanded details belowEditor", async () => {
    const ctx = buildCtx();

    syncWidget(ctx);
    await Promise.resolve();

    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      CARRIER_JOB_HUD_WIDGET_KEY,
      expect.any(Function),
      { placement: "aboveEditor" },
    );
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      CARRIER_BRIDGE_EXPANDED_WIDGET_KEY,
      undefined,
      { placement: "belowEditor" },
    );
    expect(findWidgetRegistration(ctx, CARRIER_JOB_HUD_WIDGET_KEY, "belowEditor")).toBeUndefined();
    expect(findWidgetRegistration(ctx, CARRIER_BRIDGE_EXPANDED_WIDGET_KEY, "aboveEditor")).toBeUndefined();
    expect(findWidgetFactory(ctx, LEGACY_CARRIER_STATUS_WIDGET_KEY)).toBeUndefined();
  });

  it("defaults the belowEditor Streaming Widget mode to strip", () => {
    expect(getState().widgetMode).toBe("strip");
  });

  it("toggles only the belowEditor Streaming Widget mode with Alt+Shift+P", async () => {
    const registrations: KeybindRegistration[] = [];
    _bootstrapKeybind({ register: (binding) => registrations.push(binding), getBindings: () => [], getKey: () => undefined });
    registerAgentPanelShortcut();
    const binding = registrations.find((entry) => entry.action === "panel-widget-toggle");

    expect(binding).toEqual(expect.objectContaining({
      defaultKey: "alt+shift+p",
      category: "Fleet Bridge",
    }));

    await binding?.handler(buildCtx());

    expect(getState().widgetMode).toBe("expanded");
    expect(getState().expanded).toBe(false);
  });

  it("resets the belowEditor Streaming Widget mode when Alt+P opens the Agent Panel", async () => {
    const state = getState();
    const ctx = buildCtx();
    state.widgetMode = "expanded";

    expect(toggleAgentPanel(ctx)).toBe(true);
    await Promise.resolve();

    expect(state.expanded).toBe(true);
    expect(state.widgetMode).toBe("strip");
  });

  it("restores Alt+J/K full-panel resize without direction or Enter handling", () => {
    const state = getState();
    state.bodyH = 10;
    const requestRender = vi.fn();
    const close = vi.fn();
    const editor = new AgentPanelEditor({ requestRender } as any, undefined as any, { close });

    editor.handleInput("\x1bj");
    expect(state.bodyH).toBeGreaterThan(10);
    expect(requestRender).toHaveBeenCalledTimes(1);

    editor.handleInput("\x1bk");
    expect(state.bodyH).toBe(10);
    expect(requestRender).toHaveBeenCalledTimes(2);

    editor.handleInput("\x1b[B");
    editor.handleInput("\r");
    expect(state.bodyH).toBe(10);
    expect(close).not.toHaveBeenCalled();
  });

  it("renders the carrier job HUD as streaming while background jobs are active", async () => {
    const state = getState();
    state.streaming = false;
    state.frame = 0;
    state.cols = [buildCol("stream")];
    const permit = acquireJobPermit(buildRecord("sortie:active", ["genesis"]));
    expect(permit.accepted).toBe(true);
    handleCarrierJobStreamEvent({
      type: "job:registered",
      jobId: "sortie:active",
      kind: "sortie",
      ownerCarrierId: "genesis",
      label: "1 carrier",
      startedAt: Date.now(),
      tracks: [{
        trackId: "sortie:active:genesis",
        streamKey: "sortie:genesis",
        displayCli: "genesis",
        displayName: "Genesis",
        kind: "carrier",
      }],
    });
    const ctx = buildCtx();

    syncWidget(ctx);
    await Promise.resolve();
    const rendered = renderCarrierJobHudFromCtx(ctx, 80);

    expect(stripAnsi(rendered)).not.toContain("○ Genesis");
  });

  it("renders the carrier job HUD as idle when neither streaming nor background jobs are active", async () => {
    const state = getState();
    state.streaming = false;
    state.frame = 0;
    state.cols = [buildCol("stream")];
    const ctx = buildCtx();

    syncWidget(ctx);
    await Promise.resolve();
    const rendered = renderCarrierJobHudFromCtx(ctx, 80);

    expect(stripAnsi(rendered)).toContain("○ Genesis");
  });

  it("renders aboveEditor strip and belowEditor expanded detail from split widget factories", async () => {
    const state = getState();
    state.streaming = false;
    state.frame = 0;
    state.cols = [buildCol("wait")];
    state.widgetMode = "expanded";
    const permit = acquireJobPermit(buildRecord("taskforce:active", ["genesis"], "carrier_taskforce"));
    expect(permit.accepted).toBe(true);
    handleCarrierJobStreamEvent({
      type: "job:registered",
      jobId: "taskforce:active",
      kind: "taskforce",
      ownerCarrierId: "genesis",
      label: "2 backends",
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
    const stripLines = renderCarrierJobHudLinesFromCtx(ctx, 80);
    const expandedLines = renderCarrierBridgeExpandedLinesFromCtx(ctx, 80);

    expect(stripLines).toHaveLength(1);
    expect(expandedLines.length).toBeGreaterThan(stripLines.length);
    expect(expandedLines.length).toBeLessThanOrEqual(10);
    expect(stripAnsi(expandedLines.join("\n"))).toContain("Carrier Genesis");
    expect(stripAnsi(expandedLines.join("\n"))).toContain("Taskforce · 2 backends");
    expect(stripAnsi(expandedLines.join("\n"))).toContain("Codex");
  });

  it("groups same-carrier dispatches under one header without sharing run blocks", async () => {
    const state = getState();
    state.streaming = false;
    state.frame = 0;
    state.cols = [buildCol("wait")];
    state.widgetMode = "expanded";
    registerDispatchJob("carrier:first", "run:first", "Audit stream identity", 1000);
    registerDispatchJob("carrier:second", "run:second", "Patch renderer grouping", 1001);
    handleCarrierJobStreamEvent({ type: "track:text", jobId: "carrier:first", trackId: "genesis", text: "alpha preview" });
    handleCarrierJobStreamEvent({ type: "track:text", jobId: "carrier:second", trackId: "genesis", text: "beta preview" });
    const ctx = buildCtx();

    syncWidget(ctx);
    await Promise.resolve();
    const expandedText = stripAnsi(renderCarrierBridgeExpandedLinesFromCtx(ctx, 100).join("\n"));

    expect(expandedText.match(/Carrier Genesis/g)).toHaveLength(1);
    expect(expandedText).toContain("Audit stream identity");
    expect(expandedText).toContain("Patch renderer grouping");
    expect(expandedText).toContain("alpha preview");
    expect(expandedText).toContain("beta preview");
    expect(getPanelRuns().get("run:first")?.blocks).not.toBe(getPanelRuns().get("run:second")?.blocks);
  });

  it("registers only the HUD notification aboveEditor widget from HUD editor", async () => {
    vi.useRealTimers();
    const ctx = buildCtx();
    const statuses = new Map([
      ["carrier", " ○ Genesis"],
      ["notice", "[ready]"],
    ]);
    const state = {
      currentCtx: ctx,
      footerDataRef: { getExtensionStatuses: () => statuses },
      layoutCache: { timestamp: 0 },
    };

    setupCustomEditor(ctx, state as any);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    const forbiddenRosterKey = ["fleet", "carrier", "roster"].join("-");
    const notification = findWidgetFactory(ctx, HUD_NOTIFICATION_WIDGET_KEY);

    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      HUD_NOTIFICATION_WIDGET_KEY,
      expect.any(Function),
      { placement: "aboveEditor" },
    );
    expect(findWidgetFactory(ctx, forbiddenRosterKey)).toBeUndefined();
    expect(notification?.({}, undefined).render(80).join("\n")).toContain("[ready]");
    expect(notification?.({}, undefined).render(80).join("\n")).not.toContain("○ Genesis");
  });

  it("renders the carrier job HUD as animated for active taskforce jobs even when the column is wait", async () => {
    const state = getState();
    state.streaming = false;
    state.frame = 1;
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
        trackId: "taskforce:active:0",
        streamKey: "taskforce:genesis:0",
        displayCli: "genesis",
        displayName: "Backend",
        kind: "backend",
      }],
    });
    const ctx = buildCtx();

    syncWidget(ctx);
    await Promise.resolve();
    const rendered = renderCarrierJobHudFromCtx(ctx, 80);
    const plainText = stripAnsi(rendered);

    expect(plainText).toContain(`${SPINNER_FRAMES[1]} Genesis`);
    expect(plainText).not.toContain("○ Genesis");
  });

  it("renders the carrier job HUD as animated for active taskforce jobs even when the column is wait", async () => {
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
    const rendered = renderCarrierJobHudFromCtx(ctx, 80);
    const plainText = stripAnsi(rendered);

    expect(plainText).toContain(`${SPINNER_FRAMES[2]} Genesis`);
    expect(plainText).not.toContain("○ Genesis");
  });

  it("renders no aboveEditor roster lines when no carriers are registered", async () => {
    (globalThis as any)[CARRIER_FRAMEWORK_KEY].registeredOrder = [];
    (globalThis as any)[CARRIER_FRAMEWORK_KEY].modes = new Map();
    const ctx = buildCtx();

    syncWidget(ctx);
    await Promise.resolve();
    const rendered = renderCarrierJobHudLinesFromCtx(ctx, 80);

    expect(rendered).toEqual([]);
  });
});

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function findWidgetFactory(ctx: any, widgetKey: string): ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined {
  return ctx.ui.setWidget.mock.calls.find((call: any[]) => call[0] === widgetKey)?.[1];
}

function findWidgetRegistration(ctx: any, widgetKey: string, placement: "aboveEditor" | "belowEditor"): any[] | undefined {
  return ctx.ui.setWidget.mock.calls.find((call: any[]) => call[0] === widgetKey && call[2]?.placement === placement);
}

function renderCarrierJobHudFromCtx(ctx: any, width: number): string {
  return renderCarrierJobHudLinesFromCtx(ctx, width).join("\n");
}

function renderCarrierJobHudLinesFromCtx(ctx: any, width: number): string[] {
  const hudFactory = findWidgetFactory(ctx, CARRIER_JOB_HUD_WIDGET_KEY);
  if (!hudFactory) throw new Error("expected carrier job HUD widget");
  return hudFactory({}, undefined).render(width);
}

function renderCarrierBridgeExpandedLinesFromCtx(ctx: any, width: number): string[] {
  const expandedFactory = findWidgetFactory(ctx, CARRIER_BRIDGE_EXPANDED_WIDGET_KEY);
  if (!expandedFactory) throw new Error("expected carrier bridge expanded widget");
  return expandedFactory({}, undefined).render(width);
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

function registerDispatchJob(jobId: string, runId: string, label: string, startedAt: number): void {
  handleCarrierJobStreamEvent({
    type: "job:registered",
    jobId,
    kind: "carrier",
    ownerCarrierId: "genesis",
    label,
    startedAt,
    tracks: [{
      trackId: "genesis",
      streamKey: "genesis",
      displayCli: "genesis",
      displayName: "Genesis",
      kind: "carrier",
      runId,
    }],
  });
}

function buildCtx(): any {
  return {
    hasUI: true,
    ui: {
      custom: vi.fn(() => new Promise<void>(() => {})),
      setEditorComponent: vi.fn(),
      setWidget: vi.fn(),
    },
    sessionManager: { getSessionId: () => "test-session" },
  };
}
