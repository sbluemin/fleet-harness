import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { classifyConsoleLockContent, LOCK_OBSERVE_BUDGET_MS, LOCK_REREAD_INTERVAL_MS } from "@fleet-console/protocol/lifecycle";

import { isPidAlive } from "./process.js";

/** The lock directory's and the lock file's POSIX modes. */
export const CONSOLE_LOCK_DIR_MODE = 0o700;
export const CONSOLE_LOCK_FILE_MODE = 0o600;
/** The host every lock this Console's tools trust names, unless a caller judges for another listener host. */
const LOOPBACK_HOST = "127.0.0.1";

/** The fields a lock file carries. A caller with a richer payload type passes it as `P`. */
export interface ConsoleLockFilePayload {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly endpoint: string;
  readonly startedAt: number;
  readonly token: string;
  readonly version: string;
  readonly owner?: unknown;
}

/** One published lock instance: its exact bytes identify it, its pid names its writer. */
export interface ConsoleLockFileInstance<P extends ConsoleLockFilePayload = ConsoleLockFilePayload> {
  readonly bytes: Buffer;
  readonly pid: number;
  readonly payload: P;
}

export type ConsoleLockFileObservation<P extends ConsoleLockFilePayload = ConsoleLockFilePayload> =
  | { readonly kind: "absent" }
  /** A symlink or a lock/directory owned by another user. Never followed, never reclaimed. */
  | { readonly kind: "refused"; readonly reason: string }
  /** No readable owner (empty, unparseable, invalid payload, read error, not a file). Never reclaimed. */
  | { readonly kind: "unknown"; readonly reason: string }
  /** `alive` is false only on ESRCH. `untrusted` names the first trust problem, or null for a fully trusted lock. */
  | { readonly kind: "owner"; readonly instance: ConsoleLockFileInstance<P>; readonly alive: boolean; readonly untrusted: string | null };

export interface ConsoleLockTrustOptions {
  /** The host a trusted lock must name. Defaults to the loopback host every Console publishes. */
  readonly host?: string;
}

export interface ConsoleLockTrustInput<P extends ConsoleLockFilePayload = ConsoleLockFilePayload> {
  readonly dir: string;
  readonly lockFile: string;
  readonly payload: P;
  readonly host: string;
}

/**
 * Classifies the lock once (docs/console-lifecycle-contract.md, "Observing an instance from outside"). Sends no signal,
 * asks no health endpoint, and starts no subprocess. The instance carries the exact bytes read, which the reclaim
 * protocol uses as the instance's identity.
 */
export function observeConsoleLockFile<P extends ConsoleLockFilePayload = ConsoleLockFilePayload>(lockFile: string, options: ConsoleLockTrustOptions = {}): ConsoleLockFileObservation<P> {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(lockFile);
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return { kind: "absent" };
    return { kind: "unknown", reason: `unreadable: ${errnoOf(error) ?? "error"}` };
  }
  if (stat.isSymbolicLink()) return { kind: "refused", reason: "it is a symbolic link" };
  const uid = currentUid();
  if (uid !== null) {
    if (stat.uid !== uid) return { kind: "refused", reason: `it is owned by uid ${stat.uid}` };
    let dirUid: number;
    try {
      dirUid = fs.statSync(path.dirname(lockFile)).uid;
    } catch (error) {
      return { kind: "unknown", reason: `unreadable directory: ${errnoOf(error) ?? "error"}` };
    }
    if (dirUid !== uid) return { kind: "refused", reason: `its directory is owned by uid ${dirUid}` };
  }
  if (!stat.isFile()) return { kind: "unknown", reason: "not a regular file" };
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(lockFile);
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return { kind: "absent" };
    return { kind: "unknown", reason: `unreadable: ${errnoOf(error) ?? "error"}` };
  }
  const content = classifyConsoleLockContent(bytes.toString("utf8"));
  if (content.kind === "ownerless") return { kind: "unknown", reason: content.reason };
  const payload = content.payload as unknown as P;
  return {
    kind: "owner",
    instance: { bytes, pid: payload.pid, payload },
    alive: isPidAlive(payload.pid),
    untrusted: describeConsoleLockTrustIssue(lockFile, payload, options),
  };
}

/** Re-reads a lock without a readable owner until `budgetMs` ends. Elapsed time is never evidence of death. */
export function observeConsoleLockFileWithin<P extends ConsoleLockFilePayload = ConsoleLockFilePayload>(lockFile: string, budgetMs = LOCK_OBSERVE_BUDGET_MS, options: ConsoleLockTrustOptions = {}): Promise<ConsoleLockFileObservation<P>> {
  return observeConsoleLockFileUntil<P>(lockFile, performance.now() + budgetMs, options);
}

/** The same, against a monotonic `deadline` (`performance.now()`) a caller shares with other waits. */
export async function observeConsoleLockFileUntil<P extends ConsoleLockFilePayload = ConsoleLockFilePayload>(lockFile: string, deadline: number, options: ConsoleLockTrustOptions = {}): Promise<ConsoleLockFileObservation<P>> {
  for (;;) {
    const observed = observeConsoleLockFile<P>(lockFile, options);
    if (observed.kind !== "unknown" || performance.now() >= deadline) return observed;
    await new Promise((resolve) => setTimeout(resolve, LOCK_REREAD_INTERVAL_MS));
  }
}

export type ConsoleLockInstanceState = "held" | "released" | "unknown";

/**
 * Whether the lock still holds one instance, judged through `observeConsoleLockFile`: `released` when there is no lock
 * or it names another pid (or, when `instance.token` is given, another token); `held` when it names this one; `unknown`
 * when it cannot be judged (no readable owner, refused). A lock that cannot be judged is never taken as released.
 */
export function consoleLockInstanceState(lockFile: string, instance: { readonly pid: number; readonly token?: string }, options: ConsoleLockTrustOptions = {}): ConsoleLockInstanceState {
  const observed = observeConsoleLockFile(lockFile, options);
  if (observed.kind === "absent") return "released";
  if (observed.kind !== "owner") return "unknown";
  const held = observed.instance.payload;
  if (held.pid !== instance.pid) return "released";
  if (instance.token !== undefined && held.token !== instance.token) return "released";
  return "held";
}

/**
 * The lock's payload as written, or null when there is no lock. Throws on a symbolic link and on content that is not
 * JSON; the payload is not validated, so a caller judging identity compares its fields itself.
 */
export function readConsoleLockFile<P extends ConsoleLockFilePayload = ConsoleLockFilePayload>(lockFile: string): P | null {
  try {
    const stat = fs.lstatSync(lockFile);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symbolic console lock: ${lockFile}`);
    }
    return JSON.parse(fs.readFileSync(lockFile, "utf8")) as P;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * The first reason the lock may not be trusted, or null. Trusted means: the POSIX modes 0700/0600, this user's
 * directory and file, the expected host, a valid port, an endpoint exactly `http://<host>:<port>/`, a token, and a
 * numeric startedAt. A shell's own adoption policy (its version, its owner) is checked by that shell on top.
 */
export function describeConsoleLockTrustIssue(lockFile: string, payload: ConsoleLockFilePayload, options: ConsoleLockTrustOptions = {}): string | null {
  try {
    assertTrustedConsoleLock({ dir: path.dirname(lockFile), lockFile, payload, host: options.host ?? LOOPBACK_HOST });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (typeof payload.token !== "string" || payload.token.length === 0) return "it has no token";
  if (!Number.isFinite(payload.startedAt)) return "its startedAt is not a number";
  return null;
}

export function assertConsoleLockModes(lockFile: string): void {
  // POSIX 권한 비트(0700/0600)는 POSIX 플랫폼에서만 의미가 있다. Windows는 chmod로
  // 이 모드를 강제할 수 없어 mode가 항상 0666으로 보고되므로, 같은 환경에서 uid 검사를
  // 건너뛰는 것과 동일한 기준(getuid 부재)으로 POSIX 권한 검증도 건너뛴다.
  // Windows에서는 사용자 프로필 하위 임시 디렉터리 ACL이 보호를 대신한다.
  if (typeof process.getuid !== "function") return;
  const dir = path.dirname(lockFile);
  const dirMode = fs.statSync(dir).mode & 0o777;
  const fileMode = fs.statSync(lockFile).mode & 0o777;
  if (dirMode !== CONSOLE_LOCK_DIR_MODE) {
    throw new Error(`Console lock directory mode must be 0700, got ${dirMode.toString(8)}`);
  }
  if (fileMode !== CONSOLE_LOCK_FILE_MODE) {
    throw new Error(`Console lock file mode must be 0600, got ${fileMode.toString(8)}`);
  }
}

export function assertTrustedConsoleLock(input: ConsoleLockTrustInput): void {
  const dirStat = fs.statSync(input.dir);
  const fileStat = fs.lstatSync(input.lockFile);
  if (fileStat.isSymbolicLink()) {
    throw new Error(`Refusing symbolic console lock: ${input.lockFile}`);
  }
  assertConsoleLockModes(input.lockFile);
  const uid = currentUid();
  if (uid !== null && (dirStat.uid !== uid || fileStat.uid !== uid)) {
    throw new Error("Console lock owner does not match current user");
  }
  if (input.payload.host !== input.host) {
    throw new Error(`Console lock host must match ${input.host}: ${input.payload.host}`);
  }
  // 포트는 OS가 할당하는 랜덤 포트이므로 고정값을 강제하지 않는다.
  // 대신 유효한 TCP 포트인지와 endpoint가 host:port와 내부적으로 일관되는지만 검증한다.
  if (!Number.isInteger(input.payload.port) || input.payload.port < 1 || input.payload.port > 65535) {
    throw new Error(`Console lock port must be a valid TCP port, got ${input.payload.port}`);
  }
  const endpoint = new URL(input.payload.endpoint);
  if (endpoint.protocol !== "http:" || endpoint.pathname !== "/") {
    throw new Error("Console lock endpoint must be the loopback server root");
  }
  if (endpoint.hostname !== input.host || Number(endpoint.port) !== input.payload.port) {
    throw new Error("Console lock endpoint must use the loopback host and the lock port");
  }
  if (input.payload.endpoint !== `http://${input.host}:${input.payload.port}/`) {
    throw new Error("Console lock endpoint must match the lock host and port");
  }
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}
