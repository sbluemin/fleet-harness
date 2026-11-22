import type { ComputerUsePermission } from "../shared/status.js";
import type { FleetHelperClient } from "./fleet-helper.js";

export interface ComputerUseWindowIdentity {
  readonly pid: number;
  readonly windowId: number;
  readonly processStartedAt: number;
  readonly title: string;
}

/** 공유 창을 식별하지 못한 이유 중 사람이 고칠 수 있는 것. 비민감 코드만 둔다. */
export type ComputerUseCaptureFailure = "accessibility_permission_required";
export interface ComputerUseResult {
  /** Host-side refusal before native dispatch; never inferred from app text. */
  readonly dispatchBlocked?: true;
  readonly captureWindow?: ComputerUseWindowIdentity | null;
  /** captureWindow가 null일 때만 — 식별 실패가 사람이 고칠 수 있는 권한 문제였는가. */
  readonly captureFailure?: ComputerUseCaptureFailure;
  readonly content: readonly Record<string, unknown>[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}
export interface ComputerUseOpenResult {
  readonly requestDispatched: boolean;
  readonly windowReady: boolean;
  readonly error?: string;
}

export type ResolvedApp = { readonly app: string } | {
  readonly error: "exact_target_required" | "unambiguous_target_required" | "installed_target_required";
};
export interface ComputerUsePermissions {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
  readonly holder?: string;
}
export type WindowIdentityResult = "matches" | "mismatch" | "unknown";
export type ClipboardRestoration = "restored" | "preserved_newer_contents" | "failed";
export interface ClipboardLease { finish(): Promise<ClipboardRestoration> }

export interface ComputerUsePlatform {
  supported(): boolean;
  inspectInstallation(): Promise<boolean>;
  createClient(): FleetHelperClient;
  readPermissions(): Promise<ComputerUsePermissions | null>;
  verifyWindow(target: ComputerUseWindowIdentity): Promise<WindowIdentityResult>;
  resolveApp(target: string, signal: AbortSignal): Promise<ResolvedApp>;
  openApp(app: string, signal: AbortSignal, activate: boolean): Promise<ComputerUseOpenResult>;
  openPrivacySettings(permissions: readonly ComputerUsePermission[]): Promise<boolean>;
  preparePaste(payload: { readonly text: string; readonly html?: string }, signal: AbortSignal): Promise<ClipboardLease>;
}

export function permissionHolderName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return name && name.length <= 120 && !/[\u0000-\u001f\u007f]/u.test(name) ? name : undefined;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
