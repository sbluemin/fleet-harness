import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  classifyConsoleLockContent,
  describeConsoleLockSlotQuiescenceCheck,
  describeOwnerlessConsoleLock,
  describeRefusedConsoleLock,
} from "@fleet-console/protocol/lifecycle";
import { isPidAlive } from "@fleet-console/lifecycle";

import type { ConsoleLockPayload } from "../transport/console-contract-types.js";
import type { ConsoleOwnerMetadata } from "../shell/desktop-protocol.js";

export {
  describeConsoleLockSlotQuiescenceCheck as describeSlotQuiescenceCheck,
  describeOwnerlessConsoleLock as describeOwnerlessLock,
  describeRefusedConsoleLock as describeRefusedLock,
};

export interface ConsoleLockDeps {
  readonly fs?: typeof fs;
  readonly now?: () => number;
  readonly randomToken?: () => string;
  readonly hostname?: () => string;
  /** One-line diagnostics (a reclaimed dead lock, the in-place publish fallback). Defaults to stderr. */
  readonly report?: (message: string) => void;
}

export interface ConsoleLockCreateInput {
  readonly dir: string;
  readonly lockFile: string;
  readonly pid: number;
  readonly port: number;
  readonly endpoint: string;
  readonly version: string;
  readonly owner?: ConsoleOwnerMetadata;
}

export interface ConsoleLockHandle {
  readonly payload: ConsoleLockPayload;
  release(): void;
}

export interface ConsoleLockTrustInput {
  readonly dir: string;
  readonly lockFile: string;
  readonly payload: ConsoleLockPayload;
  readonly host: string;
}

/** One published lock instance: its exact bytes identify it, its pid names its writer. */
export interface ConsoleLockInstance {
  readonly bytes: Buffer;
  readonly pid: number;
  readonly payload: ConsoleLockPayload;
}

export type ConsoleLockObservation =
  | { readonly kind: "absent" }
  /** A symlink or a lock/directory owned by another user. Never followed, never reclaimed. */
  | { readonly kind: "refused"; readonly reason: string }
  /** No readable owner (empty, unparseable, invalid payload, read error, not a file). Never reclaimed. */
  | { readonly kind: "unknown"; readonly reason: string }
  /** `alive` is false only on ESRCH. `untrusted` names the first trust problem, or null for a fully trusted lock. */
  | { readonly kind: "owner"; readonly instance: ConsoleLockInstance; readonly alive: boolean; readonly untrusted: string | null };

export type ConsoleLockReclaimResult =
  | { readonly kind: "removed" }
  /** The path no longer holds the target (absent or other bytes); nothing of anyone else was removed. */
  | { readonly kind: "gone" }
  /** The target's pid is not ESRCH now. The lock and this process's reclaim marker are left in place. */
  | { readonly kind: "alive"; readonly pid: number }
  /** Another reclaimer holds the marker and is alive, or its marker cannot be judged. Nothing was removed. */
  | { readonly kind: "busy"; readonly claimPath: string; readonly holderPid: number | null; readonly reason: string | null }
  /** The reclaim could not be finished safely. Whatever was published is left in place. */
  | { readonly kind: "failed"; readonly reason: string };

const LOCK_DIR_MODE = 0o700;
const LOCK_FILE_MODE = 0o600;
/** Monotonic budget for re-reading an ownerless lock and for waiting on another reclaimer. Not a bound on blocking file I/O. */
export const LOCK_OBSERVE_BUDGET_MS = 2_000;
const LOCK_REREAD_INTERVAL_MS = 50;
const LOCK_PUBLISH_ATTEMPTS = 3;
const CLAIM_OWNER_FILE = "owner.json";
const CLAIM_LOST_CODES = new Set(["ENOTEMPTY", "EEXIST", "ENOTDIR"]);
const STAGING_SUFFIX = /^(\d+)-[A-Za-z0-9_-]{12}$/;

export function createConsoleLock(deps: ConsoleLockDeps = {}) {
  const fsImpl = deps.fs ?? fs;
  const now = deps.now ?? Date.now;
  const randomToken = deps.randomToken ?? (() => crypto.randomBytes(32).toString("base64url"));
  const hostname = deps.hostname ?? (() => "127.0.0.1");
  const report = deps.report ?? ((message: string) => { process.stderr.write(`${message}\n`); });
  let linkFallbackReported = false;

  function ensureLockDir(dir: string): void {
    fsImpl.mkdirSync(dir, { recursive: true, mode: LOCK_DIR_MODE });
    fsImpl.chmodSync(dir, LOCK_DIR_MODE);
  }

  function readLock(lockFile: string): ConsoleLockPayload | null {
    try {
      const stat = fsImpl.lstatSync(lockFile);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing symbolic console lock: ${lockFile}`);
      }
      return JSON.parse(fsImpl.readFileSync(lockFile, "utf8")) as ConsoleLockPayload;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * Publishes this process's lock, reclaiming a dead instance on the way. Every attempt uses a fresh token, so a
   * published payload never reappears once removed. Only a lock whose readable pid is ESRCH is reclaimed, and only
   * through the reclaim-marker protocol; anything else stays in place and the call throws an EEXIST error.
   */
  async function acquireLock(input: ConsoleLockCreateInput): Promise<ConsoleLockHandle> {
    ensureLockDir(input.dir);
    const deadline = performance.now() + LOCK_OBSERVE_BUDGET_MS;
    for (let attempt = 0; attempt < LOCK_PUBLISH_ATTEMPTS; attempt += 1) {
      const payload: ConsoleLockPayload = {
        pid: input.pid,
        host: hostname(),
        port: input.port,
        endpoint: input.endpoint,
        startedAt: now(),
        token: randomToken(),
        version: input.version,
        ...(input.owner ? { owner: input.owner } : {}),
      };
      const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
      if (publishLockBytes(input.lockFile, bytes) === "published") {
        sweepLeftovers(input.lockFile, sha256(bytes));
        return { payload, release: () => removeOwnLock(input.lockFile, payload.pid) };
      }
      const observed = await observeLockUntil(input.lockFile, deadline);
      if (observed.kind === "absent") continue;
      if (observed.kind === "refused") throw lockHeldError(input.lockFile, describeRefusedConsoleLock(input.lockFile, observed.reason));
      if (observed.kind === "unknown") throw lockHeldError(input.lockFile, describeOwnerlessConsoleLock(input.lockFile, observed.reason));
      if (observed.alive) throw lockHeldError(input.lockFile, `Fleet Console lock ${input.lockFile} is held by running pid ${observed.instance.pid}.`);
      const result = await reclaimUntil(input.lockFile, observed.instance, deadline);
      if (result.kind === "removed") {
        const untrusted = observed.untrusted ? ` (the lock was also untrusted: ${observed.untrusted})` : "";
        report(`Fleet Console lock: reclaimed the lock left by pid ${observed.instance.pid}, which is no longer running (${input.lockFile}).${untrusted}`);
        continue;
      }
      if (result.kind === "gone") continue;
      if (result.kind === "alive") throw lockHeldError(input.lockFile, `Fleet Console lock ${input.lockFile} is held by running pid ${result.pid}.`);
      throw lockHeldError(input.lockFile, describeReclaimResult(input.lockFile, result));
    }
    throw lockHeldError(input.lockFile, `Fleet Console lock ${input.lockFile} kept changing while this Console tried to take it.`);
  }

  /** Self-release: removes the lock only while it still names this pid. */
  function removeOwnLock(lockFile: string, pid: number): void {
    const current = readLock(lockFile);
    // The pid guard also treats "no lock yet" as do-not-delete, so a lock another owner published in between survives.
    if (!current || current.pid !== pid) return;
    try {
      fsImpl.rmSync(lockFile, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /**
   * Stages the complete lock beside the target and hard-links it into place, so the path never shows a partial lock.
   * A volume without hard links falls back to an exclusive in-place write; that write's short empty window is safe only
   * because no participant ever removes a lock without a readable owner.
   */
  function publishLockBytes(lockFile: string, bytes: Buffer): "published" | "exists" {
    const staging = stagingPath(lockFile, "tmp");
    writeExclusiveFile(staging, bytes);
    try {
      fsImpl.linkSync(staging, lockFile);
      return "published";
    } catch (error) {
      const code = errnoOf(error);
      if (code === "EEXIST") return "exists";
      if (!linkFallbackReported) {
        linkFallbackReported = true;
        report(`Fleet Console lock: hard links are not available in ${path.dirname(lockFile)} (${code ?? "error"}); publishing the lock in place.`);
      }
      try {
        writeExclusiveFile(lockFile, bytes);
        return "published";
      } catch (fallbackError) {
        if (errnoOf(fallbackError) === "EEXIST") return "exists";
        throw fallbackError;
      }
    } finally {
      removeQuietly(staging);
    }
  }

  function writeExclusiveFile(filePath: string, bytes: Buffer): void {
    const fd = fsImpl.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, LOCK_FILE_MODE);
    try {
      fsImpl.writeFileSync(fd, bytes);
      fsImpl.fchmodSync(fd, LOCK_FILE_MODE);
    } finally {
      fsImpl.closeSync(fd);
    }
  }

  /** Classifies the lock once. Sends no signal, asks no health endpoint, and starts no subprocess. */
  function observeLock(lockFile: string): ConsoleLockObservation {
    let stat: fs.Stats;
    try {
      stat = fsImpl.lstatSync(lockFile);
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
        dirUid = fsImpl.statSync(path.dirname(lockFile)).uid;
      } catch (error) {
        return { kind: "unknown", reason: `unreadable directory: ${errnoOf(error) ?? "error"}` };
      }
      if (dirUid !== uid) return { kind: "refused", reason: `its directory is owned by uid ${dirUid}` };
    }
    if (!stat.isFile()) return { kind: "unknown", reason: "not a regular file" };
    let bytes: Buffer;
    try {
      bytes = fsImpl.readFileSync(lockFile);
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return { kind: "absent" };
      return { kind: "unknown", reason: `unreadable: ${errnoOf(error) ?? "error"}` };
    }
    const parsed = parseLockBytes(bytes);
    if ("reason" in parsed) return { kind: "unknown", reason: parsed.reason };
    return {
      kind: "owner",
      instance: { bytes, pid: parsed.payload.pid, payload: parsed.payload },
      alive: isPidAlive(parsed.payload.pid),
      untrusted: describeTrustIssue(lockFile, parsed.payload),
    };
  }

  /** Re-reads an ownerless lock until the budget ends. Elapsed time is never evidence of death. */
  function observeLockWithin(lockFile: string, budgetMs = LOCK_OBSERVE_BUDGET_MS): Promise<ConsoleLockObservation> {
    return observeLockUntil(lockFile, performance.now() + budgetMs);
  }

  async function observeLockUntil(lockFile: string, deadline: number): Promise<ConsoleLockObservation> {
    for (;;) {
      const observed = observeLock(lockFile);
      if (observed.kind !== "unknown" || performance.now() >= deadline) return observed;
      await delay(LOCK_REREAD_INTERVAL_MS);
    }
  }

  function describeTrustIssue(lockFile: string, payload: ConsoleLockPayload): string | null {
    try {
      assertTrustedLock({ dir: path.dirname(lockFile), lockFile, payload, host: hostname() });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    if (typeof payload.token !== "string" || payload.token.length === 0) return "it has no token";
    if (!Number.isFinite(payload.startedAt)) return "its startedAt is not a number";
    return null;
  }

  /**
   * Removes the dead lock instance `target` under the reclaim-marker protocol. The caller's own evidence (an exited
   * child, a stop's earlier checks) only decides whether to call this; the deletion right is decided here.
   */
  function reclaimLock(lockFile: string, target: ConsoleLockInstance, budgetMs = LOCK_OBSERVE_BUDGET_MS): Promise<ConsoleLockReclaimResult> {
    return reclaimUntil(lockFile, target, performance.now() + budgetMs);
  }

  /**
   * Generation chain of reclaim markers per target instance: `.<lock>.claim-<sha256 of target bytes>-<k>`. Generation
   * k+1 is published only when the holder of k is ESRCH (or its marker is not a complete marker), and publication is
   * exclusive, so at most one live process believes it holds the newest marker; only that process may unlink the target.
   * Markers are never removed on a timeout.
   */
  async function reclaimUntil(lockFile: string, target: ConsoleLockInstance, deadline: number): Promise<ConsoleLockReclaimResult> {
    const h = sha256(target.bytes);
    let blocker: Extract<ConsoleLockReclaimResult, { kind: "busy" }> | null = null;
    for (let first = true; ; first = false) {
      if (!first && performance.now() >= deadline) {
        return blocker ?? { kind: "failed", reason: "other reclaimers kept taking the reclaim marker" };
      }
      let generation: number;
      try {
        generation = newestClaimGeneration(lockFile, h);
      } catch (error) {
        return { kind: "failed", reason: `the lock directory could not be listed (${errnoOf(error) ?? "error"})` };
      }
      if (generation > 0) {
        const claimPath = claimPathOf(lockFile, h, generation);
        const holder = classifyClaim(claimPath, h);
        if (holder.kind === "absent") continue;
        if (holder.kind === "alive" || holder.kind === "foreign" || holder.kind === "unreadable") {
          blocker = {
            kind: "busy",
            claimPath,
            holderPid: holder.kind === "alive" ? holder.pid : null,
            reason: holder.kind === "alive" ? null : holder.reason,
          };
          await delay(LOCK_REREAD_INTERVAL_MS);
          continue;
        }
        // The holder is ESRCH or its marker is incomplete: the next generation takes over.
      }
      let published: "won" | "lost";
      try {
        published = publishClaim(lockFile, claimPathOf(lockFile, h, generation + 1), h);
      } catch (error) {
        return { kind: "failed", reason: `the reclaim marker could not be published (${describeError(error)})` };
      }
      if (published === "lost") continue;
      return finalizeReclaim(lockFile, target, h);
    }
  }

  /**
   * The only place a participant unlinks someone else's lock. Requires holding the newest marker, the exact target
   * bytes on the path, and ESRCH for the target pid right now. On any other outcome while the target may still be on
   * the path, this process's marker stays complete so no one else can take the same generation while it lives.
   */
  function finalizeReclaim(lockFile: string, target: ConsoleLockInstance, h: string): ConsoleLockReclaimResult {
    let stat: fs.Stats;
    try {
      stat = fsImpl.lstatSync(lockFile);
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return goneAfterCleanup(lockFile, h);
      return { kind: "failed", reason: `the lock could not be read (${errnoOf(error) ?? "error"})` };
    }
    const uid = currentUid();
    if (stat.isSymbolicLink() || !stat.isFile() || (uid !== null && stat.uid !== uid)) {
      return { kind: "failed", reason: "the lock path changed into something that is not this user's lock file" };
    }
    let current: Buffer;
    try {
      current = fsImpl.readFileSync(lockFile);
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return goneAfterCleanup(lockFile, h);
      return { kind: "failed", reason: `the lock could not be read (${errnoOf(error) ?? "error"})` };
    }
    if (!current.equals(target.bytes)) return goneAfterCleanup(lockFile, h);
    if (isPidAlive(target.pid)) return { kind: "alive", pid: target.pid };
    try {
      fsImpl.unlinkSync(lockFile);
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return goneAfterCleanup(lockFile, h);
      return { kind: "failed", reason: `the lock could not be removed (${errnoOf(error) ?? "error"})` };
    }
    removeClaims(lockFile, (claimHash) => claimHash === h);
    return { kind: "removed" };
  }

  function goneAfterCleanup(lockFile: string, h: string): ConsoleLockReclaimResult {
    removeClaims(lockFile, (claimHash) => claimHash === h);
    return { kind: "gone" };
  }

  /**
   * A marker is published whole: the owner record is written into a private staging entry that is then renamed (POSIX:
   * a directory, which cannot replace a non-empty directory) or hard-linked (Windows: a file, since a directory rename
   * there is not verified to refuse an existing target). A lost publication never touches the existing marker.
   */
  function publishClaim(lockFile: string, claimPath: string, h: string): "won" | "lost" {
    const owner = Buffer.from(`${JSON.stringify({ v: 1, pid: process.pid, h })}\n`, "utf8");
    const staging = stagingPath(lockFile, "ctmp");
    if (process.platform === "win32") {
      writeExclusiveFile(staging, owner);
      try {
        fsImpl.linkSync(staging, claimPath);
        return "won";
      } catch (error) {
        if (errnoOf(error) === "EEXIST") return "lost";
        throw new Error(`hard links are not available in ${path.dirname(lockFile)}, so a dead lock cannot be reclaimed safely there (${errnoOf(error) ?? "error"})`);
      } finally {
        removeQuietly(staging);
      }
    }
    fsImpl.mkdirSync(staging, { mode: LOCK_DIR_MODE });
    try {
      writeExclusiveFile(path.join(staging, CLAIM_OWNER_FILE), owner);
    } catch (error) {
      removeQuietly(staging);
      throw error;
    }
    try {
      fsImpl.renameSync(staging, claimPath);
    } catch (error) {
      removeQuietly(staging);
      if (CLAIM_LOST_CODES.has(errnoOf(error) ?? "")) return "lost";
      throw error;
    }
    return "won";
  }

  type ClaimState =
    | { readonly kind: "absent" }
    | { readonly kind: "foreign"; readonly reason: string }
    | { readonly kind: "unreadable"; readonly reason: string }
    | { readonly kind: "corrupt" }
    | { readonly kind: "alive"; readonly pid: number }
    | { readonly kind: "dead" };

  /** Read errors are not evidence; only an incomplete marker (which no participant publishes) or ESRCH hands a generation over. */
  function classifyClaim(claimPath: string, h: string): ClaimState {
    const uid = currentUid();
    let stat: fs.Stats;
    try {
      stat = fsImpl.lstatSync(claimPath);
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return { kind: "absent" };
      return { kind: "unreadable", reason: `unreadable: ${errnoOf(error) ?? "error"}` };
    }
    if (stat.isSymbolicLink()) return { kind: "foreign", reason: "it is a symbolic link" };
    if (uid !== null && stat.uid !== uid) return { kind: "foreign", reason: `it is owned by uid ${stat.uid}` };
    let ownerPath = claimPath;
    if (stat.isDirectory()) {
      ownerPath = path.join(claimPath, CLAIM_OWNER_FILE);
      let ownerStat: fs.Stats;
      try {
        ownerStat = fsImpl.lstatSync(ownerPath);
      } catch (error) {
        const code = errnoOf(error);
        if (code === "ENOENT" || code === "ENOTDIR") return { kind: "corrupt" };
        return { kind: "unreadable", reason: `unreadable: ${code ?? "error"}` };
      }
      if (ownerStat.isSymbolicLink()) return { kind: "foreign", reason: "its owner record is a symbolic link" };
      if (uid !== null && ownerStat.uid !== uid) return { kind: "foreign", reason: `its owner record is owned by uid ${ownerStat.uid}` };
      if (!ownerStat.isFile()) return { kind: "corrupt" };
    } else if (!stat.isFile()) {
      return { kind: "corrupt" };
    }
    let bytes: Buffer;
    try {
      bytes = fsImpl.readFileSync(ownerPath);
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return { kind: "absent" };
      return { kind: "unreadable", reason: `unreadable: ${errnoOf(error) ?? "error"}` };
    }
    let record: unknown;
    try {
      record = JSON.parse(bytes.toString("utf8"));
    } catch {
      return { kind: "corrupt" };
    }
    if (!isPlainObject(record) || record.v !== 1 || !isPositiveSafeInteger(record.pid) || record.h !== h) return { kind: "corrupt" };
    return isPidAlive(record.pid) ? { kind: "alive", pid: record.pid } : { kind: "dead" };
  }

  function newestClaimGeneration(lockFile: string, h: string): number {
    const prefix = `${claimPrefix(lockFile)}${h}-`;
    let newest = 0;
    for (const name of fsImpl.readdirSync(path.dirname(lockFile))) {
      if (!name.startsWith(prefix)) continue;
      const suffix = name.slice(prefix.length);
      if (!/^[1-9]\d{0,14}$/.test(suffix)) continue;
      newest = Math.max(newest, Number(suffix));
    }
    return newest;
  }

  /** Best-effort: removes this user's markers whose target hash matches. A failure only leaves a stale marker behind. */
  function removeClaims(lockFile: string, matches: (claimHash: string) => boolean): void {
    const dir = path.dirname(lockFile);
    const pattern = new RegExp(`^${escapeRegExp(claimPrefix(lockFile))}([0-9a-f]{64})-[1-9]\\d{0,14}$`);
    let names: string[];
    try {
      names = fsImpl.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const match = pattern.exec(name);
      if (!match || !matches(match[1]!)) continue;
      if (!isOwnEntry(path.join(dir, name))) continue;
      removeQuietly(path.join(dir, name));
    }
  }

  /**
   * After this process published its own lock: drop staging entries of exited processes and markers of instances that
   * are no longer on the path. Never touches the lock itself, live or undecidable staging entries, or other users' files.
   */
  function sweepLeftovers(lockFile: string, ownHash: string): void {
    removeClaims(lockFile, (claimHash) => claimHash !== ownHash);
    const dir = path.dirname(lockFile);
    let names: string[];
    try {
      names = fsImpl.readdirSync(dir);
    } catch {
      return;
    }
    for (const kind of ["tmp", "ctmp"] as const) {
      const prefix = `.${path.basename(lockFile)}.${kind}-`;
      for (const name of names) {
        if (!name.startsWith(prefix)) continue;
        const match = STAGING_SUFFIX.exec(name.slice(prefix.length));
        if (!match) continue;
        const pid = Number(match[1]);
        if (!isPositiveSafeInteger(pid) || isPidAlive(pid)) continue;
        if (!isOwnEntry(path.join(dir, name))) continue;
        removeQuietly(path.join(dir, name));
      }
    }
  }

  function isOwnEntry(entryPath: string): boolean {
    try {
      const stat = fsImpl.lstatSync(entryPath);
      const uid = currentUid();
      return !stat.isSymbolicLink() && (uid === null || stat.uid === uid);
    } catch {
      return false;
    }
  }

  function removeQuietly(entryPath: string): void {
    try {
      fsImpl.rmSync(entryPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of entries no one depends on.
    }
  }

  function assertLockModes(lockFile: string): void {
    // POSIX 권한 비트(0700/0600)는 POSIX 플랫폼에서만 의미가 있다. Windows는 chmod로
    // 이 모드를 강제할 수 없어 mode가 항상 0666으로 보고되므로, 같은 환경에서 uid 검사를
    // 건너뛰는 것과 동일한 기준(getuid 부재)으로 POSIX 권한 검증도 건너뛴다.
    // Windows에서는 사용자 프로필 하위 임시 디렉터리 ACL이 보호를 대신한다.
    if (typeof process.getuid !== "function") return;
    const dir = path.dirname(lockFile);
    const dirMode = fsImpl.statSync(dir).mode & 0o777;
    const fileMode = fsImpl.statSync(lockFile).mode & 0o777;
    if (dirMode !== LOCK_DIR_MODE) {
      throw new Error(`Console lock directory mode must be 0700, got ${dirMode.toString(8)}`);
    }
    if (fileMode !== LOCK_FILE_MODE) {
      throw new Error(`Console lock file mode must be 0600, got ${fileMode.toString(8)}`);
    }
  }

  function assertTrustedLock(input: ConsoleLockTrustInput): void {
    const dirStat = fsImpl.statSync(input.dir);
    const fileStat = fsImpl.lstatSync(input.lockFile);
    if (fileStat.isSymbolicLink()) {
      throw new Error(`Refusing symbolic console lock: ${input.lockFile}`);
    }
    assertLockModes(input.lockFile);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (currentUid != null && (dirStat.uid !== currentUid || fileStat.uid !== currentUid)) {
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

  return { ensureLockDir, readLock, acquireLock, observeLock, observeLockWithin, reclaimLock, assertLockModes, assertTrustedLock };
}

/** Text for a reclaim that ended without removing the lock for a reason other than a live lock pid. */
export function describeReclaimResult(lockFile: string, result: Exclude<ConsoleLockReclaimResult, { kind: "removed" | "gone" | "alive" }>): string {
  if (result.kind === "failed") return `Fleet Console lock ${lockFile} could not be reclaimed (${result.reason}); it was left in place`;
  if (result.holderPid !== null) {
    return [
      `Fleet Console lock ${lockFile} is being reclaimed by pid ${result.holderPid} (${result.claimPath}). Nothing was removed. If that process is a Fleet command that is still running, let it finish; if it is not a Fleet process, follow the check below and then delete ${result.claimPath}.`,
      describeConsoleLockSlotQuiescenceCheck(lockFile),
    ].join("\n");
  }
  return [
    `Fleet Console lock ${lockFile} has a reclaim marker whose owner cannot be read or is not yours (${result.claimPath}: ${result.reason ?? "unknown"}). Nothing was removed.`,
    describeConsoleLockSlotQuiescenceCheck(lockFile),
    `Then delete ${result.claimPath}.`,
  ].join("\n");
}

/**
 * True for the error acquireLock throws when this process did not take the lock. A serve ending on it exits with
 * CONSOLE_SERVE_EXIT_LOCK_HELD so a host can tell it from other failed starts. A property, not a class, because
 * bundles may carry separate copies of this module.
 */
export function isConsoleLockHeldError(error: unknown): boolean {
  return error instanceof Error && (error as { consoleLockHeld?: unknown }).consoleLockHeld === true;
}

function lockHeldError(lockFile: string, detail: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException & { consoleLockHeld?: true } = new Error(`EEXIST: Fleet Console lock ${lockFile} is already held.\n${detail}`);
  error.code = "EEXIST";
  error.consoleLockHeld = true;
  return error;
}

function parseLockBytes(bytes: Buffer): { readonly payload: ConsoleLockPayload } | { readonly reason: string } {
  const content = classifyConsoleLockContent(bytes.toString("utf8"));
  if (content.kind === "ownerless") return { reason: content.reason };
  return { payload: content.payload as unknown as ConsoleLockPayload };
}

function claimPrefix(lockFile: string): string {
  return `.${path.basename(lockFile)}.claim-`;
}

function claimPathOf(lockFile: string, h: string, generation: number): string {
  return path.join(path.dirname(lockFile), `${claimPrefix(lockFile)}${h}-${generation}`);
}

function stagingPath(lockFile: string, kind: "tmp" | "ctmp"): string {
  const suffix = crypto.randomBytes(9).toString("base64url");
  return path.join(path.dirname(lockFile), `.${path.basename(lockFile)}.${kind}-${process.pid}-${suffix}`);
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
