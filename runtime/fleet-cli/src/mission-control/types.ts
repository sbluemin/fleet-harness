import type { Component, PtyExitEvent, PtyHost, PtyLaunchProfile } from "../controls/index.js";

import type { DedicatedCliId, DedicatedCliProfile } from "../dedicated-cli/types.js";
import type { PtyView } from "../controls/terminal-view.js";

export type MissionControlStateKind = "idle" | "launching" | "active" | "ended" | "failed";

export interface MissionControlCliOption {
  readonly id: DedicatedCliId;
  readonly label: string;
}

export interface MissionControlStateSnapshot {
  readonly cliId: DedicatedCliId;
  readonly kind: MissionControlStateKind;
  readonly lastExit?: PtyExitEvent;
}

export interface MissionControlController {
  readonly component: Component;
  readonly ptyHost: PtyHost;
  readonly ptyView: MissionControlPtyView;
  readonly closePanel: () => void;
  readonly getActiveProfile: () => DedicatedCliProfile | undefined;
  readonly getState: () => MissionControlStateSnapshot;
  readonly hasActivePanel: () => boolean;
  readonly kill: () => void;
  readonly launchSelected: () => Promise<void>;
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
  readonly createPtyHost: (profile: PtyLaunchProfile) => PtyHost;
  readonly createPtyView?: (cols: number, rows: number) => PtyView;
  readonly defaultCliId: DedicatedCliId;
  readonly injectProfile: (profile: DedicatedCliProfile) => Promise<DedicatedCliProfile>;
  readonly onExitFleet: () => void;
  readonly onRenderRequest: () => void;
  readonly resolveProfile: (cliId: DedicatedCliId) => Promise<DedicatedCliProfile>;
}
