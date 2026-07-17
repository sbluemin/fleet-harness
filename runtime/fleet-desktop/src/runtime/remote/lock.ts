import { DESKTOP_PROTOCOL_VERSION, isCompatibleDesktopOwner, type ConsoleOwnerMetadata } from "@fleet-console/desktop-protocol";

import { RemoteRuntimeError } from "./contracts.js";
import type { OpenSshAdapter } from "./ssh.js";
import type { ValidatedSshTarget } from "./target.js";

const MAX_LOCK_BYTES = 64 * 1024;

export interface RemoteConsoleLock {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly endpoint: string;
  readonly token: string;
  readonly version: string;
  readonly owner?: ConsoleOwnerMetadata;
}

export type RemoteLockClassification =
  | { readonly kind: "absent" | "stale" }
  | { readonly kind: "same_owner"; readonly lock: RemoteConsoleLock }
  | { readonly kind: "same_owner_version_mismatch"; readonly lock: RemoteConsoleLock }
  | { readonly kind: "remote_console_owned_elsewhere" | "remote_console_lock_conflict"; readonly lock?: RemoteConsoleLock };

export interface RemoteLockOwner {
  readonly id: string;
  /** Installed Console service version, never FLEET_CONSOLE_DESKTOP_VERSION. Omitted only for an offline version-agnostic inspection. */
  readonly serviceVersion?: string;
}

export interface RemoteLockInspectionOptions { readonly versionAgnostic?: boolean; }

/** Inspect only: this never removes a lock or signals a remote pid. */
export async function inspectRemoteLock(adapter: OpenSshAdapter, target: ValidatedSshTarget, expectedOwner: RemoteLockOwner, options: RemoteLockInspectionOptions = {}): Promise<RemoteLockClassification> {
  const exists = await adapter.probe(target, { operation: "probe_path", args: [".fleet/console/console.lock"] });
  if (!exists.ok) return { kind: "absent" };
  let contents: string;
  try {
    contents = (await adapter.run(target, { operation: "read_lock", args: [] })).stdout;
  } catch (error) {
    // A successful existence probe followed by a failed read is a TOCTOU/permission conflict,
    // never evidence that it is safe to replace an unknown service.
    if (isSshFailure(error)) return { kind: "remote_console_lock_conflict" };
    throw error;
  }
  let lock: RemoteConsoleLock;
  try { lock = parseRemoteConsoleLock(contents); } catch { return { kind: "remote_console_lock_conflict" }; }
  const alive = await adapter.probe(target, { operation: "check_process", args: [String(lock.pid)] });
  if (!alive.ok) return { kind: "stale" };
  const isSameDesktop = lock.owner?.kind === "desktop" && lock.owner.id === expectedOwner.id && lock.owner.protocolVersion === DESKTOP_PROTOCOL_VERSION;
  if (options.versionAgnostic && isSameDesktop) return { kind: "same_owner", lock };
  if (expectedOwner.serviceVersion !== undefined && isCompatibleDesktopOwner(lock.owner, lock.version, { id: expectedOwner.id, version: expectedOwner.serviceVersion })) return { kind: "same_owner", lock };
  if (isSameDesktop) return { kind: "same_owner_version_mismatch", lock };
  if (lock.owner?.kind === "desktop") return { kind: "remote_console_owned_elsewhere", lock };
  return { kind: "remote_console_lock_conflict", lock };
}

export function parseRemoteConsoleLock(contents: string): RemoteConsoleLock {
  if (Buffer.byteLength(contents, "utf8") > MAX_LOCK_BYTES) throw new Error("remote_lock_too_large");
  const value: unknown = JSON.parse(contents);
  if (!isRecord(value)) throw new Error("remote_lock_invalid");
  const { pid, host, port, endpoint, token, version, owner } = value;
  if (!isPositiveSafeInteger(pid) || typeof host !== "string" || host.length === 0 || !isPositiveSafeInteger(port) || port > 65535 || typeof endpoint !== "string" || typeof token !== "string" || token.length === 0 || token.length > 4096 || /[\u0000-\u001f\u007f]/u.test(token) || typeof version !== "string" || version.length === 0 || version.length > 256 || (owner !== undefined && !isOwner(owner))) throw new Error("remote_lock_invalid");
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || Number(parsed.port) !== port || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error("remote_lock_invalid_endpoint");
  return { pid, host, port, endpoint, token, version, ...(owner === undefined ? {} : { owner }) };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function isPositiveSafeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function isOwner(value: unknown): value is ConsoleOwnerMetadata { return isRecord(value) && (value.kind === "desktop" || value.kind === "cli") && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 256 && isPositiveSafeInteger(value.protocolVersion); }
function isSshFailure(error: unknown): boolean { return error instanceof RemoteRuntimeError ? error.code === "ssh_failed" : isRecord(error) && error.code === "ssh_failed"; }
