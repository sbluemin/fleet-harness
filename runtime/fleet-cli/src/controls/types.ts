import type { Component as PrimitiveComponent, TerminalSize } from "../tui/types.js";
import type { DesiredHeight, PaneSize, ResizeReason, ResizeRequest } from "../tui/layout/split-pane.js";
import type { RoutedMouseInput } from "./mouse/parser.js";

export type FleetInputMode = "MIRROR" | "DEDICATED";

export type MouseProtocolName = "none" | "x10" | "vt200" | "drag" | "any";
export type MouseEncodingName = "default" | "sgr" | "sgr-pixels";

export type { DesiredHeight, PaneSize, ResizeReason, ResizeRequest };
export type { InputRouterLayout, MouseWheelDirection, RoutedMouseInput, SgrMouseInput } from "./mouse/parser.js";

export interface KeyboardProtocolState {
  readonly outerEnabled: boolean;
  readonly childRequested: boolean;
  readonly effectiveMode: "passthrough" | "transform";
}

export interface MouseProtocolState {
  readonly activeProtocol: MouseProtocolName;
  readonly activeEncoding: MouseEncodingName;
  readonly dragTrackingEnabled?: boolean;
  readonly mouseTrackingEnabled: boolean;
}

export interface PtyStartOptions {
  readonly cols: number;
  readonly rows: number;
}

export interface PtyLaunchProfile {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly terminalName: string;
}

export interface PtyExitEvent {
  readonly exitCode: number | undefined;
  readonly signal: number | undefined;
}

export interface PtyHost {
  start(opts: PtyStartOptions): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(handler: (chunk: string) => void): void;
  onExit(handler: (event: PtyExitEvent) => void): void;
  getKeyboardProtocol?: () => KeyboardProtocolState;
  getMouseProtocol?: () => MouseProtocolState;
  kill(): void;
}

export interface PtyLaunchConfig {
  readonly profile: PtyLaunchProfile;
}

export interface DedicatedPtyView {
  readonly maxRows: number;
  resize(cols: number, rows: number): void;
}

export interface FleetPtyTheme {
  readonly accent: (text: string) => string;
  readonly bg: (name: FleetPtyBgColor, text: string) => string;
  readonly bold: (text: string) => string;
  readonly border: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly error: (text: string) => string;
  readonly fg: (name: FleetPtyFgColor, text: string) => string;
  readonly muted: (text: string) => string;
  readonly reset: (text: string) => string;
  readonly success: (text: string) => string;
  readonly warning: (text: string) => string;
}

export type FleetPtyFgColor = "accent" | "border" | "dim" | "error" | "muted" | "success" | "warning";
export type FleetPtyBgColor = "panel" | "selected";

export interface FleetPtyRegion {
  readonly component: Component;
  readonly id: string;
}

export interface FleetPtyOverlay {
  readonly component: Component;
  readonly id: string;
}

export interface FleetPtySection {
  readonly id: string;
  readonly component: Component;
}

export interface FleetPtyCustomOptions {
  readonly overlay?: boolean;
}

export interface FleetPtyKeyFacade {
  readonly matchesKey: (data: string, keyId: KeyId) => boolean;
}

export type FleetPtyCustomFactory<T> = (
  ui: FleetPtyLocalUi,
  theme: FleetPtyTheme,
  keys: FleetPtyKeyFacade,
  done: (result: T) => void,
) => Component | Promise<Component>;

export interface FleetPtyLocalUi {
  readonly addInputListener: (listener: (data: string) => void) => () => void;
  readonly getColumns: () => number;
  readonly getRows: () => number;
  readonly requestResize: () => void;
  readonly requestRender: () => void;
  readonly setFocus: (component: Component) => void;
}

export interface FleetPtyLocalUiOptions {
  readonly addInputListener: (listener: (data: string) => void) => () => void;
  readonly getColumns: () => number;
  readonly getRows: () => number;
  readonly requestResize: () => void;
  readonly requestRender: () => void;
}

export interface CreateFleetPtyApiOptions {
  readonly defaultComponent: Component;
  readonly sections?: readonly FleetPtySection[];
}

export interface FleetPtyApi {
  readonly custom: <T>(factory: FleetPtyCustomFactory<T>, opts?: FleetPtyCustomOptions) => Promise<T>;
  readonly dispatchInput: (data: string) => boolean;
  readonly dispatchMouse: (event: RoutedMouseInput) => boolean;
  readonly getCurrentRegion: () => FleetPtyRegion;
  readonly getDesiredHeight: (maxRows: number) => number | undefined;
  readonly getSections: () => FleetPtySection[];
  readonly hasActiveOverlay: () => boolean;
  readonly mountSection: (section: FleetPtySection) => void;
  readonly popOverlay: () => FleetPtyRegion;
  readonly pushOverlay: (overlay: FleetPtyOverlay) => FleetPtyRegion;
  readonly replaceRegion: (region: FleetPtyRegion) => FleetPtyRegion;
}

export interface TuiPtyManagerOptions {
  readonly fleetPty: FleetPtyApi;
  readonly ptyHost: PtyHost;
  readonly ptyView: DedicatedPtyView;
  readonly refreshSize: (size: TerminalSize) => void;
  readonly requestRender: () => void;
}

export interface TuiPtyManager {
  readonly getCurrentRequest: () => ResizeRequest;
  readonly requestResize: (reason: ResizeReason, size?: TerminalSize) => ResizeRequest;
}

export type Component = PrimitiveComponent & {
  readonly wantsKeyRelease?: boolean;
  desiredHeight?(maxRows: number): number | undefined;
  dispose?(): void;
  handleMouse?(event: RoutedMouseInput): boolean | void;
  setFocus?(focused: boolean): void;
};

export type KeyId =
  | "backspace"
  | "down"
  | "end"
  | "enter"
  | "escape"
  | "home"
  | "left"
  | "pagedown"
  | "pageup"
  | "right"
  | "t"
  | "up";
