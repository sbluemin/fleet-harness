import { LocalTui } from "../tui/renderer.js";

import type { AgentCliId } from "../agent-cli/types.js";
import type { Component, FleetInputMode, FleetPtyApi } from "./types.js";

export type RenderCallback = () => void;
export type RenderScheduler = (afterRender?: RenderCallback) => void;

interface RenderSchedulerUi {
  requestRender(force?: boolean, afterRender?: RenderCallback): void;
}

const RENDER_THROTTLE_MS = 16;
const CLAUDE_CODE_AGENT_IDS = new Set<AgentCliId>(["claude", "claude-kimi"]);

export function createRenderScheduler(ui: RenderSchedulerUi, beforeRender: () => void): RenderScheduler {
  let renderPending = false;
  let afterRenderCallbacks: RenderCallback[] = [];
  return (afterRender?: RenderCallback) => {
    if (afterRender !== undefined) {
      afterRenderCallbacks.push(afterRender);
    }

    if (renderPending) {
      return;
    }

    renderPending = true;
    setTimeout(() => {
      renderPending = false;
      const callbacks = afterRenderCallbacks;
      afterRenderCallbacks = [];
      beforeRender();
      ui.requestRender(false, () => {
        for (const callback of callbacks) {
          callback();
        }
      });
    }, RENDER_THROTTLE_MS);
  };
}

export function createFleetPtyViewport(fleetPty: FleetPtyApi): Component {
  return {
    handleInput(data: string): void {
      fleetPty.dispatchInput(data);
    },
    invalidate(): void {
      fleetPty.getCurrentRegion().component.invalidate();
    },
    render(width: number): string[] {
      return fleetPty.getCurrentRegion().component.render(width);
    },
  };
}

export function createCursorPolicySync(options: {
  readonly cursorSync: boolean;
  readonly cursorSyncExplicitlyEnabled?: boolean;
  readonly fleetPty: FleetPtyApi;
  readonly getActiveAgentProfileId?: () => AgentCliId | undefined;
  readonly getMode: () => FleetInputMode;
  readonly hasActiveMissionControlPanel: () => boolean;
  readonly isModeToggleSuppressed: () => boolean;
  readonly ptyView: Component;
  readonly ui: LocalTui;
}): () => void {
  return () => {
    if (
      !options.cursorSync
      || options.isModeToggleSuppressed()
      || options.hasActiveMissionControlPanel()
      || options.fleetPty.hasActiveOverlay()
      || shouldAutoDisableCursorSync(options.getActiveAgentProfileId?.(), options.cursorSyncExplicitlyEnabled === true)
    ) {
      options.ui.setCursorAnchorTarget(undefined);
      return;
    }

    const mode = options.getMode();
    options.ui.setCursorAnchorTarget(mode === "MIRROR" || mode === "DEDICATED" ? options.ptyView : undefined);
  };
}

export function shouldAutoDisableCursorSync(
  profileId: AgentCliId | undefined,
  cursorSyncExplicitlyEnabled = false,
): boolean {
  return process.platform === "win32" && !cursorSyncExplicitlyEnabled && profileId !== undefined && CLAUDE_CODE_AGENT_IDS.has(profileId);
}
