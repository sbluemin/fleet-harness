import { LocalTui } from "@dotobokuri/fleet-tui/core";

import type { AgentCliId } from "../agent-cli/types.js";
import type { Component, FleetInputMode, FleetPtyApi, PtyHost, RoutedMouseInput } from "./types.js";
import { encodeSgrMouseInput } from "./input.js";

export type RenderCallback = () => void;
export type RenderScheduler = (afterRender?: RenderCallback) => void;

interface RenderSchedulerUi {
  requestRender(force?: boolean, afterRender?: RenderCallback): void;
}

interface MissionControlPtyView {
  readonly isAlternateBufferActive: () => boolean;
  readonly scrollLines: (delta: number) => boolean;
}

const RENDER_THROTTLE_MS = 16;
const CLAUDE_CODE_AGENT_IDS = new Set<AgentCliId>(["claude", "claude-zai", "claude-kimi"]);
const STANDARD_MOUSE_PROTOCOL_STATE = {
  activeEncoding: "default" as const,
  activeProtocol: "none" as const,
  mouseTrackingEnabled: false,
};
const WHEEL_SCROLL_LINES = 3;

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

export function createDedicatedMouseRouter(options: {
  readonly ptyHost: Pick<PtyHost, "getMouseProtocol" | "write">;
  readonly ptyView: MissionControlPtyView;
  readonly requestRender: () => void;
}): (event: RoutedMouseInput) => boolean {
  return (event) => {
    const mouseProtocol = options.ptyHost.getMouseProtocol?.() ?? STANDARD_MOUSE_PROTOCOL_STATE;
    if (mouseProtocol.mouseTrackingEnabled) {
      options.ptyHost.write(encodeSgrMouseInput(event, { column: event.localColumn, row: event.localRow }));
      return true;
    }

    if (event.wheelDirection === null) {
      return true;
    }

    if (options.ptyView.isAlternateBufferActive()) {
      options.ptyHost.write(event.wheelDirection === "up" ? "\x1b[A" : "\x1b[B");
      return true;
    }

    const delta = event.wheelDirection === "up" ? -WHEEL_SCROLL_LINES : WHEEL_SCROLL_LINES;
    if (options.ptyView.scrollLines(delta)) {
      options.requestRender();
    }
    return true;
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
