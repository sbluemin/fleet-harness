export interface ComputerUseWindowIdentity {
  readonly pid: number;
  readonly windowId: number;
  readonly processStartedAt: number;
  readonly title: string;
}

export interface ComputerUseResult {
  /** Host-side refusal before native dispatch; never inferred from app text. */
  readonly dispatchBlocked?: true;
  readonly captureWindow?: ComputerUseWindowIdentity | null;
  readonly content: readonly Record<string, unknown>[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}
export interface ComputerUseTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}
export const COMPUTER_USE_ACTIONS = ["click", "perform_secondary_action", "set_value", "select_text", "scroll", "drag", "press_key", "type_text"] as const;
export type ComputerUseAction = typeof COMPUTER_USE_ACTIONS[number];
export interface ComputerUseAppTarget { readonly name: string; readonly app: string; readonly bundleId: string | null }
export interface ComputerUseWindowState {
  readonly app: string;
  readonly status: "not_running" | "no_window" | "minimized" | "available" | "unknown";
  readonly pid: number | null;
  readonly frontmost: boolean | null;
  readonly hidden: boolean | null;
  readonly windowCount: number | null;
  readonly reason?: string;
}
export interface ComputerUseOpenResult {
  readonly requestDispatched: boolean;
  readonly windowReady: boolean;
  readonly windowState: ComputerUseWindowState;
  readonly error?: string;
}
export interface ComputerUseBackend {
  readonly tools: ReadonlyMap<string, ComputerUseTool>;
  readonly cleanupStatus: "not_requested" | "not_needed" | "notified" | "failed";
  readonly threadReleaseStatus: "not_requested" | "not_needed" | "released" | "failed";
  readonly cleanupFailure: "timeout" | "client_unavailable" | "client_exit" | null;
  start(): Promise<void>;
  call(tool: string, args: Record<string, unknown>, options?: { readonly allowActivation: boolean }): Promise<ComputerUseResult>;
  stop(): Promise<void>;
}
export interface ComputerUseBackendOptions {
  readonly directory: string;
  readonly onStage?: (stage: string) => void;
  readonly approve: (request: Record<string, unknown>) => Promise<boolean>;
}
export interface ComputerUsePlatform {
  readonly supported: () => boolean;
  readonly appTargetSchema: Record<string, unknown>;
  readonly endHint: string;
  readonly unavailableError: string;
  inspectInstallation(): Promise<boolean>;
  createBroker(options: ComputerUseBackendOptions): Promise<ComputerUseBackend | null>;
  resolveTarget(app: string): Promise<string>;
  preflight(app: string, allowActivation: boolean): Promise<void>;
  inspectWindows(apps: readonly string[]): Promise<ComputerUseWindowState[]>;
  openApp(app: string, signal: AbortSignal, activate: boolean): Promise<ComputerUseOpenResult>;
  displayTarget(app: string): string;
  captureTarget?(value: ComputerUseResult): ComputerUseWindowIdentity | null;
  verifyCaptureTarget?(target: ComputerUseWindowIdentity): Promise<boolean>;
  appTargets(value: ComputerUseResult): ComputerUseAppTarget[];
  appCandidates(value: ComputerUseResult, app: unknown, targets: readonly ComputerUseAppTarget[]): ComputerUseAppTarget[];
  prepareAction(action: string, args: Record<string, unknown>): Record<string, unknown>;
  actionSchemas(tools: ReadonlyMap<string, ComputerUseTool>): Record<string, unknown>;
  hasActionObservation(value: ComputerUseResult): boolean;
  hasFullObservation(value: ComputerUseResult): boolean;
  interactionHints(value: ComputerUseResult): string[];
  classifyFailure(value: ComputerUseResult): string;
  failureHint(error: string): string;
}
export class ComputerUseInputError extends Error {
  constructor(code: string, readonly hint: string) { super(code); }
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function computerUseText(value: ComputerUseResult): string {
  return value.content.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}

export interface ComputerUseRuntimeDependencies {
  readonly resolveCodex: () => { bin: string; prefixArgs: readonly string[] } | null;
  readonly childEnv: () => NodeJS.ProcessEnv;
}
