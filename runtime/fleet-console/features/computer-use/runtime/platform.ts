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
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
