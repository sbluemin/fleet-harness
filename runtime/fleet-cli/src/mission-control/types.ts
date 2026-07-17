import type { AgentCliId, AgentCliProfile } from "@dotobokuri/fleet-admiral";
import type { CarrierRuntime } from "@dotobokuri/fleet-carriers";
import type { AuthService } from "@dotobokuri/core-infra";

import type { Component, PtyExitEvent, PtyHost, PtyLaunchProfile } from "../controls/index.js";
import type { PtyView } from "../controls/terminal-view.js";
import type { SessionOptions, SessionOptionsRuntime } from "./options/types.js";
import type { FleetCliRelease } from "../release.js";
import type { MissionControlCounts } from "./loaded-counts.js";

export type MissionControlStateKind = "idle" | "launching" | "active" | "ended" | "failed";

export interface MissionControlCliOption {
  readonly id: AgentCliId;
  readonly label: string;
}

export interface MissionControlEmbeddedLaunch {
  readonly cleanup?: () => void;
  readonly host: PtyHost;
  readonly profile: AgentCliProfile;
  readonly view: PtyView;
}

export interface MissionControlLaunchProfileOptions {
  readonly cols: number;
  readonly createPtyHost: (profile: PtyLaunchProfile) => PtyHost;
  readonly createPtyView: (cols: number, rows: number) => PtyView;
  readonly onActive: (launch: MissionControlEmbeddedLaunch) => void;
  readonly onExit: (event: PtyExitEvent) => void;
  readonly onRenderRequest: () => void;
  readonly profile: AgentCliProfile;
  readonly rows: number;
}

export type MissionControlLaunchProfile = (options: MissionControlLaunchProfileOptions) => Promise<void> | void;

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
  readonly authService?: AuthService;
  readonly cliOptions: readonly MissionControlCliOption[];
  readonly carrierRuntime?: CarrierRuntime;
  readonly createPtyHost: (profile: PtyLaunchProfile) => PtyHost;
  readonly createPtyView?: (cols: number, rows: number) => PtyView;
  readonly initialCliId: AgentCliId;
  readonly env?: NodeJS.ProcessEnv;
  readonly injectProfile: (profile: AgentCliProfile, launchOptions?: SessionOptions) => Promise<AgentCliProfile>;
  readonly invocationCwd?: string;
  readonly launchProfile?: MissionControlLaunchProfile;
  readonly loadedCounts?: MissionControlCounts;
  readonly onExitFleet: () => void;
  readonly onRenderRequest: () => void;
  readonly release?: FleetCliRelease;
  readonly resolveProfile: (cliId: AgentCliId, launchOptions?: SessionOptions) => Promise<AgentCliProfile>;
  readonly sessionOptions?: SessionOptionsRuntime;
  readonly shimmer?: MissionControlShimmerOptions;

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
