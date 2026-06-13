import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCursorPolicySync, createRenderScheduler } from "../src/controls/index.js";
import { FleetStatusSection } from "../src/mission-bridge/fleet-status-section.js";

const HIDDEN_CURSOR_FRAME = "\x1b[?25l";
const RENDER_THROTTLE_MS = 16;
const VISIBLE_CURSOR_FRAME = "\x1b[1;3H\x1b[?25h";

describe("app cursor policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("flushes queued render callbacks after the scheduled render", async () => {
    const renderedFrames: string[] = [];
    let cursorTarget: "visible" | undefined = "visible";
    const ui = {
      requestRender(_force = false, afterRender?: () => void): void {
        setTimeout(() => {
          renderedFrames.push(cursorTarget === undefined ? HIDDEN_CURSOR_FRAME : VISIBLE_CURSOR_FRAME);
          afterRender?.();
        }, RENDER_THROTTLE_MS);
      },
    };
    const syncCursorPolicy = () => {
      cursorTarget = "visible";
    };
    const scheduleRender = createRenderScheduler(ui, syncCursorPolicy);
    const queueHiddenFrame = () => {
      cursorTarget = undefined;
      scheduleRender(() => {
        syncCursorPolicy();
        ui.requestRender();
      });
    };

    queueHiddenFrame();
    await vi.advanceTimersByTimeAsync(RENDER_THROTTLE_MS);
    expect(renderedFrames).toEqual([]);

    await vi.advanceTimersByTimeAsync(RENDER_THROTTLE_MS);
    expect(renderedFrames).toEqual([VISIBLE_CURSOR_FRAME]);

    await vi.advanceTimersByTimeAsync(RENDER_THROTTLE_MS + 1);
    expect(renderedFrames).toEqual([VISIBLE_CURSOR_FRAME, VISIBLE_CURSOR_FRAME]);
  });

  it("clears cursor target while a Mission Control panel is active", () => {
    let cursorTarget: unknown = "visible";
    const ptyView = {};
    const syncCursorPolicy = createCursorPolicySync({
      cursorSync: true,
      fleetPty: { hasActiveOverlay: () => false },
      hasActiveMissionControlPanel: () => true,
      ptyView,
      ui: {
        setCursorAnchorTarget(target: unknown): void {
          cursorTarget = target;
        },
      },
    } as never);

    syncCursorPolicy();

    expect(cursorTarget).toBeUndefined();
  });

  it("clears cursor target for Claude Code on native Windows by default", () => {
    mockPlatform("win32");
    const ptyView = {};
    const cursorTarget = runCursorPolicy({
      getActiveAgentProfileId: () => "claude",
      ptyView,
    });

    expect(cursorTarget()).toBeUndefined();
  });

  it("keeps cursor target for Claude Code outside native Windows", () => {
    mockPlatform("linux");
    const ptyView = {};
    const cursorTarget = runCursorPolicy({
      getActiveAgentProfileId: () => "claude",
      ptyView,
    });

    expect(cursorTarget()).toBe(ptyView);
  });

  it("clears cursor target for Claude Kimi on native Windows by default", () => {
    mockPlatform("win32");
    const ptyView = {};
    const cursorTarget = runCursorPolicy({
      getActiveAgentProfileId: () => "claude-kimi",
      ptyView,
    });

    expect(cursorTarget()).toBeUndefined();
  });

  it("keeps cursor target for Codex on native Windows", () => {
    mockPlatform("win32");
    const ptyView = {};
    const cursorTarget = runCursorPolicy({
      getActiveAgentProfileId: () => "codex",
      ptyView,
    });

    expect(cursorTarget()).toBe(ptyView);
  });

  it("keeps cursor target for Claude Code on native Windows when cursor sync is explicitly enabled", () => {
    mockPlatform("win32");
    const ptyView = {};
    const cursorTarget = runCursorPolicy({
      cursorSyncExplicitlyEnabled: true,
      getActiveAgentProfileId: () => "claude",
      ptyView,
    });

    expect(cursorTarget()).toBe(ptyView);
  });

  it("renders the Fleet status section border", () => {
    const section = new FleetStatusSection();

    expect(stripAnsi(section.render(80).join("\n"))).toBe("─".repeat(80));
  });
});

function runCursorPolicy(options: {
  readonly cursorSyncExplicitlyEnabled?: boolean;
  readonly getActiveAgentProfileId?: () => "claude" | "claude-kimi" | "codex" | undefined;
  readonly ptyView: unknown;
}): () => unknown {
  let cursorTarget: unknown = "visible";
  const syncCursorPolicy = createCursorPolicySync({
    cursorSync: true,
    cursorSyncExplicitlyEnabled: options.cursorSyncExplicitlyEnabled,
    fleetPty: { hasActiveOverlay: () => false },
    getActiveAgentProfileId: options.getActiveAgentProfileId,
    hasActiveMissionControlPanel: () => false,
    ptyView: options.ptyView,
    ui: {
      setCursorAnchorTarget(target: unknown): void {
        cursorTarget = target;
      },
    },
  } as never);

  syncCursorPolicy();

  return () => cursorTarget;
}

function mockPlatform(platform: NodeJS.Platform): void {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}
