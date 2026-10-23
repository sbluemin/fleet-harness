
/**
 * The one way a plugin starts a child the Console must not outlive. A child started here leads a process group the
 * Console owns (POSIX): the Console ends it with everything it started however the Console ends — its stop deadline,
 * a crash, or an external kill. Never start a child that has to outlive the Console here.
 *
 * Spawn only: there is no way to register an existing pid, list the Console's children, or end them all; a plugin
 * signals only the child it was given, and its group only through `killGroup` (for example on a timeout). On Windows the
 * group is a job object, and `killGroup` ends that job; a direct child still ends with the Console when the job is absent.
 */
export interface OwnedProcessPort {
  /** The child is tagged with this plugin's id, which the host binds. */
  spawnOwned(request: OwnedChildRequest): OwnedChild;
}


export interface OwnedChildRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Defaults to the Console's own environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** `ignore` gives the child no stdin, for tools that would otherwise wait for its end. Default `pipe`. */
  readonly stdin?: "pipe" | "ignore";
}


/** The started child: the part of a Node `ChildProcess` a plugin needs. stdout and stderr are always piped. */
export interface OwnedChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  /**
   * Ends the child together with everything it started (its process group on POSIX, the job on Windows; default SIGTERM).
   * On POSIX, only while the child itself has not exited: after that its number may name another process, so nothing is
   * signalled and the Console ends what is left. On Windows the signal name is ignored and the job is terminated; a child
   * whose job was never assigned is signalled alone. Returns whether an end was requested.
   */
  killGroup(signal?: NodeJS.Signals): boolean;
  on(event: "close" | "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}
