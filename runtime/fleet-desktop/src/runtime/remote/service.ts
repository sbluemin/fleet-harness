import { RemoteRuntimeError } from "./contracts.js";
import { inspectRemoteLock, type RemoteConsoleLock, type RemoteLockOwner } from "./lock.js";
import type { OpenSshAdapter } from "./ssh.js";
import type { ValidatedSshTarget } from "./contracts.js";

export interface RemoteServiceLaunch {
  readonly serviceRootRel: string;
  readonly nodeBinRel: string;
  readonly cliRel: string;
  readonly ownerId: string;
  readonly protocolVersion: number;
  readonly desktopVersion: string;
  /** Installed Console service version used only for lock ownership matching. */
  readonly serviceVersion: string;
  readonly consoleDirRel: string;
}
export interface RemoteServiceOptions { readonly wait?: (ms: number) => Promise<void>; readonly readinessAttempts?: number; }

/** Starts only a Desktop-owned service and returns the lock's actual random port/token. */
export async function startRemoteService(adapter: OpenSshAdapter, target: ValidatedSshTarget, launch: RemoteServiceLaunch, options: RemoteServiceOptions = {}): Promise<RemoteConsoleLock> {
  const result = await adapter.run(target, { operation: "start_console", args: [launch.serviceRootRel, launch.nodeBinRel, launch.cliRel, launch.ownerId, String(launch.protocolVersion), launch.desktopVersion, launch.consoleDirRel] });
  if (!/^[1-9]\d*$/u.test(result.stdout.trim())) throw new Error("remote_console_start_invalid_pid");
  const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = options.readinessAttempts ?? 10;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await wait(Math.min(100 * (attempt + 1), 500));
    const inspected = await inspectRemoteLock(adapter, target, { id: launch.ownerId, serviceVersion: launch.serviceVersion });
    if (inspected.kind === "same_owner") return inspected.lock;
    if (inspected.kind === "remote_console_owned_elsewhere" || inspected.kind === "remote_console_lock_conflict") throw new Error(inspected.kind);
  }
  throw new Error("remote_console_readiness_timeout");
}

/** Never accept a foreign pid: callers must pass the lock just classified as same-owner. */
export async function stopOwnedRemoteService(adapter: OpenSshAdapter, target: ValidatedSshTarget, lock: RemoteConsoleLock, owner: RemoteLockOwner, options: RemoteServiceOptions = {}): Promise<void> {
  const current = await inspectRemoteLock(adapter, target, owner);
  if (current.kind !== "same_owner" || current.lock.pid !== lock.pid) throw new Error("remote_console_stop_not_owned");
  await adapter.run(target, { operation: "stop_console", args: [String(lock.pid)] });
  const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < (options.readinessAttempts ?? 10); attempt += 1) {
    if (!(await adapter.probe(target, { operation: "check_process", args: [String(lock.pid)] })).ok) return;
    await wait(100);
  }
  throw new RemoteRuntimeError("ssh_failed", "remote_console_stop_timeout");
}
