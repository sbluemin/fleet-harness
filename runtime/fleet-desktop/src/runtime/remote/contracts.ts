/** Electron-free contracts shared by the managed remote runtime lanes. */
export type RemoteRuntimePhase = "validating_target" | "connecting" | "detecting_platform" | "provisioning_node" | "provisioning_console" | "starting_service" | "opening_tunnel" | "verifying_pairing";

export type RemoteRuntimeFailureCode =
  | "pairing_target_invalid"
  | "ssh_unavailable"
  | "ssh_failed"
  | "ssh_cancelled"
  | "ssh_timeout"
  | "remote_pairing_not_ready"
  | "remote_command_invalid"
  | "remote_command_output_too_large";

/** User-facing code branches on `code`, never on stderr or Error.message. */
export class RemoteRuntimeError extends Error {
  constructor(readonly code: RemoteRuntimeFailureCode, message: string = code, options?: ErrorOptions) {
    super(message, options);
    this.name = "RemoteRuntimeError";
  }
}

export type RemoteRuntimePhaseCallback = (phase: RemoteRuntimePhase) => void;

export interface RemoteCancellation {
  readonly signal: AbortSignal;
}

/** A candidate owns only resources it created before a pairing handoff commits. */
export interface RemoteCandidateSession {
  rollback(): Promise<void>;
  dispose(): Promise<void>;
}

export interface RemoteProcessHandle {
  readonly pid: number | undefined;
  readonly exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  terminate(): void;
}

export interface RemoteCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Only this closed operation vocabulary may select a remote program. */
export type RemoteOperation =
  | "detect_platform"
  | "read_lock"
  | "remove_console_lock"
  | "check_process"
  | "prepare_staging"
  | "upload_file"
  | "extract_archive"
  | "probe_path"
  | "read_runtime_file"
  | "remove_runtime_path"
  | "promote_runtime_path"
  | "chmod_exec"
  | "normalize_console_prefix"
  | "install_console"
  | "start_console"
  | "stop_console";

/** Arguments are operation-schema validated before they become remote argv. */
export interface RemoteCommand {
  readonly operation: RemoteOperation;
  readonly args: readonly string[];
  /** Only `upload_file` accepts verified archive or marker-file bytes/a byte stream. */
  readonly stdin?: Uint8Array | NodeJS.ReadableStream;
}
