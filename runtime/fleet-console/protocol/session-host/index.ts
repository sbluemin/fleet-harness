/** Private local execution protocol. Never forward these server-side records to a browser. */
export const SESSION_HOST_WIRE = 1;
export const SESSION_RUNNER_WIRE = 1;
export const SESSION_OWNER_LOSS_MS = 2_000;
export const SESSION_HOST_START_MS = 15_000;
export const SESSION_KEEPER_HEARTBEAT_MS = 10_000;
export const SESSION_KEEPER_LOSS_MS = 30_000;
/** Installs have no existing stop-budget bound; preservation still has a hard ceiling. */
export const SESSION_UPDATE_MAX_MS = 15 * 60_000;
export const SESSION_RPC_TIMEOUT_MS = 30 * 60_000;
export const SESSION_HOST_POLL_MS = 250;
export const SESSION_ATTACH_POLL_MS = 25;
export const SESSION_HOOK_INPUT_MS = 500;
export const SESSION_HOOK_POLICY_MS = 5_000;
export const SESSION_HOOK_OBSERVATION_MS = 1_500;
export const SESSION_FRAME_MAX_BYTES = 16 * 1024 * 1024;
export const SESSION_REPLAY_MAX_BYTES = 4 * 1024 * 1024;
export const SESSION_COMMAND_MAX = 4_096;
export const SESSION_BUSINESS_MAX = 256;
export type SessionLaunchFingerprint = Readonly<Record<string, unknown>>;
export type SessionKind = "sdk" | "pty" | "gateway";
export interface SessionOwner {
  readonly pid: number;
  readonly startedAt: number;
  readonly token: string;
}
export interface SessionHostManifest {
  readonly v: typeof SESSION_HOST_WIRE;
  readonly hostId: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly slotKey: string;
  readonly socket: string;
  readonly capability: string;
}
export interface SessionHostEvent {
  readonly sessionKey: string;
  readonly seq: number;
  readonly at: number;
  readonly kind: string;
  readonly data: unknown;
}
export interface SessionSnapshot {
  readonly sessionKey: string;
  readonly kind: SessionKind;
  readonly generation: string;
  readonly startedAt: number;
  readonly seq: number;
  readonly state: "starting" | "live" | "ended" | "lost";
  readonly launchFingerprint: SessionLaunchFingerprint | null;
  readonly runtime: Readonly<Record<string, unknown>>;
  /** Consumer-owned live orchestration state, not a second product-state writer. */
  readonly checkpoint: unknown;
  readonly lastCommandSequence: number;
  readonly commands: readonly SessionCommandRecord[];
}
export interface SessionCommandRecord {
  readonly commandId: string;
  readonly sequence: number;
  readonly state: "accepted" | "completed" | "failed";
  readonly value?: unknown;
  readonly error?: string;
}
export interface SessionHostSnapshot {
  readonly hostId: string;
  readonly slotKey: string;
  readonly epoch: number;
  readonly state: "attached" | "updating" | "stopping";
  readonly sessions: readonly SessionSnapshot[];
}
export interface SessionReplay {
  readonly snapshot: SessionSnapshot;
  readonly events: readonly SessionHostEvent[];
  readonly gap: boolean;
}
export interface SessionCommand {
  readonly sessionKey: string;
  readonly commandId: string;
  /** Monotonic per-session admission sequence; retired IDs can never be admitted again. */
  readonly sequence: number;
  readonly epoch: number;
  readonly kind: string;
  readonly body?: unknown;
}
export interface SessionUpdateRef {
  readonly updateId: string;
  readonly keeperCapability: string;
  readonly host: Omit<SessionHostManifest, "capability">;
  readonly expiresAt: number;
}
export interface SessionGeneration {
  readonly id: string;
  readonly root: string;
  readonly node: string;
  readonly broker: string;
  readonly runner: string;
  readonly reaper: string;
  readonly hook: string;
}
export type SessionDeferredBusiness = {
  readonly $sessionHostDeferred: true;
  readonly turnId: string;
  readonly permissionEpoch: number;
  readonly presentation: unknown;
} & (
  /** 제품의 무기한 질문은 턴·철회·dispose만 끝낸다. 재접속이 새 타이머를 만들지 않는다. */
  | { readonly lifetime: "turn"; readonly expiresAt: null }
  /** 기존 요청의 실제 만료 시각이다. Console Use의 idle 제한과는 다른 축이다. */
  | { readonly lifetime: "deadline"; readonly expiresAt: number }
);
export interface SessionBusinessCall {
  readonly requestId: string;
  readonly sessionKey: string;
  readonly port: string;
  readonly body: unknown;
}
export function assertSessionKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/.test(value)) throw new Error("invalid_session_key");
}
