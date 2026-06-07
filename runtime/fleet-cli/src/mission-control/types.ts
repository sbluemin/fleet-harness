import type { AuthService } from "@dotobokuri/fleet-infra/auth";
import type { CarrierRuntime } from "@dotobokuri/fleet-carriers";

import type { AgentCliId, AgentCliProfile } from "../agent-cli/types.js";
import type { Component, PtyExitEvent, PtyHost, PtyLaunchProfile } from "../controls/index.js";
import type { PtyView } from "../controls/terminal-view.js";
import type { SessionOptions, SessionOptionsRuntime } from "./options/types.js";
import type { FleetCliRelease, MissionControlCounts } from "./loaded-counts.js";
import type { WikiProcessController } from "./menu/wiki-panel.js";

export type MissionControlStateKind = "idle" | "launching" | "active" | "ended" | "failed";

export interface MissionControlCliOption {
  readonly id: AgentCliId;
  readonly label: string;
}

export type { FleetCliRelease, MissionControlCounts };

export interface MissionControlStateSnapshot {
  readonly cliId: AgentCliId;
  readonly kind: MissionControlStateKind;
  readonly lastLaunchError?: string;
  readonly lastLaunchWarning?: string;
  readonly lastExit?: PtyExitEvent;
}

export interface MissionControlController {
  readonly component: Component;
  readonly ptyHost: PtyHost;
  readonly ptyView: MissionControlPtyView;
  readonly closePanel: () => void;
  readonly dispose: () => void;
  readonly getActiveProfile: () => AgentCliProfile | undefined;
  readonly getState: () => MissionControlStateSnapshot;
  readonly hasActivePanel: () => boolean;
  readonly kill: () => void;
  readonly launchSelected: () => Promise<void>;
  readonly openCarrierRoster: () => void;
  readonly openPanel: (panel: MissionControlPanel) => void;
  /** Programmatic input path that writes directly to the active child PTY, bypassing panel routing. */
  readonly writeChildInput: (data: string) => void;
}

export interface MissionControlPanel {
  readonly component: Component;
  readonly id: string;
  dispose?(): void;
}

export interface MissionControlPanelHost {
  readonly closePanel: () => void;
  readonly hasActivePanel: () => boolean;
  readonly openPanel: (panel: MissionControlPanel) => void;
  readonly requestRender: () => void;
}

export interface MissionControlPtyView extends Component {
  readonly maxRows: number;
  readonly isAlternateBufferActive: () => boolean;
  readonly resize: (cols: number, rows: number) => void;
  readonly scrollLines: (delta: number) => boolean;
}

export interface CreateMissionControlControllerOptions {
  readonly cliOptions: readonly MissionControlCliOption[];
  readonly authService: AuthService;
  readonly carrierRuntime?: CarrierRuntime;
  readonly createPtyHost: (profile: PtyLaunchProfile) => PtyHost;
  readonly createPtyView?: (cols: number, rows: number) => PtyView;
  readonly initialCliId: AgentCliId;
  readonly env?: NodeJS.ProcessEnv;
  readonly injectProfile: (profile: AgentCliProfile, launchOptions?: SessionOptions) => Promise<AgentCliProfile>;
  readonly invocationCwd?: string;
  readonly loadedCounts?: MissionControlCounts;
  readonly onExitFleet: () => void;
  readonly onRenderRequest: () => void;
  readonly release?: FleetCliRelease;
  readonly resolveProfile: (cliId: AgentCliId, launchOptions?: SessionOptions) => Promise<AgentCliProfile>;
  readonly sessionOptions?: SessionOptionsRuntime;
  readonly shimmer?: MissionControlShimmerOptions;
  readonly wikiController?: WikiProcessController;
}

export interface MissionControlShimmerOptions {
  readonly clearInterval?: (timer: MissionControlShimmerTimer) => void;
  readonly enabled?: boolean;
  readonly intervalMs?: number;
  readonly setInterval?: (callback: () => void, intervalMs: number) => MissionControlShimmerTimer;
}

export interface MissionControlShimmerTimer {
  unref?(): void;
}
