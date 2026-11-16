import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  describeConsoleLockSlotQuiescenceCheck,
  describeOwnerlessConsoleLock,
  describeRefusedConsoleLock,
  LOCK_OBSERVE_BUDGET_MS,
  LOCK_REREAD_INTERVAL_MS,
} from "@fleet-console/protocol/lifecycle";
import {
  CONSOLE_LOCK_DIR_MODE,
  CONSOLE_LOCK_FILE_MODE,
  bootSessionsDiffer,
  currentConsoleBootSession,
  isPidAlive,
  observeConsoleLockFileUntil,
  readConsoleLockFile,
  type ConsoleLockFileInstance,
  type ConsoleLockFileObservation,
} from "@fleet-console/lifecycle";

import type { ConsoleLockPayload } from "../transport/console-contract-types.js";
import type { ConsoleOwnerMetadata } from "../shell/desktop-protocol.js";

export interface ConsoleLockDeps {
  readonly now?: () => number;
  readonly randomToken?: () => string;
  readonly hostname?: () => string;
  /** One-line diagnostics (a reclaimed dead lock, the in-place publish fallback). Defaults to stderr. */
  readonly report?: (message: string) => void;
  /** Current OS boot session. Defaults to the process cache. Null omits the field and keeps the ESRCH rules. */
  readonly bootSession?: () => string | null;
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

/** One published lock instance, as `observeConsoleLockFile` read it: its exact bytes identify it. */
export type ConsoleLockInstance = ConsoleLockFileInstance<ConsoleLockPayload>;
export type ConsoleLockObservation = ConsoleLockFileObservation<ConsoleLockPayload>;

export type ConsoleLockReclaimResult =
  | { readonly kind: "removed" }
  /** The path no longer holds the target (absent or other bytes); nothing of anyone else was removed. */
  | { readonly kind: "gone" }
  /** The target's author is not gone (not ESRCH, and not a previous boot). The lock and this process's reclaim marker stay. */
  | { readonly kind: "alive"; readonly pid: number }
  /** Another reclaimer holds the marker and is alive, or its marker cannot be judged. Nothing was removed. */
  | { readonly kind: "busy"; readonly claimPath: string; readonly holderPid: number | null; readonly reason: string | null }
  /** The reclaim could not be finished safely. Whatever was published is left in place. */
  | { readonly kind: "failed"; readonly reason: string };

const LOCK_PUBLISH_ATTEMPTS = 3;
const CLAIM_OWNER_FILE = "owner.json";
const CLAIM_LOST_CODES = new Set(["ENOTEMPTY", "EEXIST", "ENOTDIR"]);
const STAGING_SUFFIX = /^(\d+)-[A-Za-z0-9_-]{12}$/;

export function createConsoleLock(deps: ConsoleLockDeps = {}) {
  const now = deps.now ?? Date.now;
  const randomToken = deps.randomToken ?? (() => crypto.randomBytes(32).toString("base64url"));
  const hostname = deps.hostname ?? (() => "127.0.0.1");
  const report = deps.report ?? ((message: string) => { process.stderr.write(`${message}\n`); });
  const bootSession = deps.bootSession ?? currentConsoleBootSession;
  let linkFallbackReported = false;

  function ensureLockDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true, mode: CONSOLE_LOCK_DIR_MODE });
    fs.chmodSync(dir, CONSOLE_LOCK_DIR_MODE);
  }

  /**
   * Publishes this process's lock, reclaiming a dead instance on the way. Every attempt uses a fresh token, so a
   * published payload never reappears once removed. A lock is reclaimed only when its pid is ESRCH or its boot session is
   * a previous boot, and only through the reclaim-marker protocol; anything else stays and the call throws EEXIST.
   */
  async function acquireLock(input: ConsoleLockCreateInput): Promise<ConsoleLockHandle> {
    ensureLockDir(input.dir);
    const deadline = performance.now() + LOCK_OBSERVE_BUDGET_MS;
    const recordedBoot = bootSession();
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
        ...(recordedBoot ? { bootSession: recordedBoot } : {}),
      };
      const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
      if (publishLockBytes(input.lockFile, bytes) === "published") {
        sweepLeftovers(input.lockFile, sha256(bytes));
        return { payload, release: () => removeOwnLock(input.lockFile, payload.pid) };
      }
      const observed = await observeConsoleLockFileUntil<ConsoleLockPayload>(input.lockFile, deadline, { host: hostname(), bootSession });
      if (observed.kind === "absent") continue;
      if (observed.kind === "refused") throw lockHeldError(input.lockFile, describeRefusedConsoleLock(input.lockFile, observed.reason));
      if (observed.kind === "unknown") throw lockHeldError(input.lockFile, describeOwnerlessConsoleLock(input.lockFile, observed.reason));
      if (observed.alive && !observed.previousBoot) throw lockHeldError(input.lockFile, `Fleet Console lock ${input.lockFile} is held by running pid ${observed.instance.pid}.`);
      const result = await reclaimUntil(input.lockFile, observed.instance, deadline);
      if (result.kind === "removed") {
        const untrusted = observed.untrusted ? ` (the lock was also untrusted: ${observed.untrusted})` : "";
        const why = observed.previousBoot ? "which belongs to a previous boot" : "which is no longer running";
        report(`Fleet Console lock: reclaimed the lock left by pid ${observed.instance.pid}, ${why} (${input.lockFile}).${untrusted}`);
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
    const current = readConsoleLockFile<ConsoleLockPayload>(lockFile);
    // The pid guard also treats "no lock yet" as do-not-delete, so a lock another owner published in between survives.
    if (!current || current.pid !== pid) return;
    try {
      fs.rmSync(lockFile, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /**
   * Stages the complete lock, fsyncs it, then hard-links it into place, so the path never shows a partial lock and a
   * published lock survives power loss. A volume without hard links falls back to an exclusive write of the same bytes;
   * a failed fallback deletes the file it created, so a 0-byte or torn lock is not left behind by that error.
   */
  function publishLockBytes(lockFile: string, bytes: Buffer): "published" | "exists" {
    const staging = stagingPath(lockFile, "tmp");
    writeExclusiveFile(staging, bytes);
    try {
      try {
        fs.linkSync(staging, lockFile);
      } catch (error) {
        const code = errnoOf(error);
        if (code === "EEXIST") return "exists";
        if (!linkFallbackReported) {
          linkFallbackReported = true;
          report(`Fleet Console lock: hard links are not available in ${path.dirname(lockFile)} (${code ?? "error"}); publishing the lock in place.`);
        }
        try {
          writeExclusiveFile(lockFile, bytes);
        } catch (fallbackError) {
          if (errnoOf(fallbackError) === "EEXIST") return "exists";
          throw fallbackError;
        }
      }
      fsyncDirectory(path.dirname(lockFile));
      return "published";
    } finally {
      removeQuietly(staging);
    }
  }

  function writeExclusiveFile(filePath: string, bytes: Buffer): void {
    const fd = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, CONSOLE_LOCK_FILE_MODE);
    let durable = false;
    try {
      fs.writeFileSync(fd, bytes);
      fs.fchmodSync(fd, CONSOLE_LOCK_FILE_MODE);
      fs.fsyncSync(fd);
      durable = true;
    } finally {
      fs.closeSync(fd);
      if (!durable) removeQuietly(filePath);
    }
  }

  /** Best-effort: a directory fsync makes the new name durable. Volumes that cannot fsync a directory still published. */
  function fsyncDirectory(dir: string): void {
    if (process.platform === "win32") return;
    let fd: number | null = null;
    try {
      fd = fs.openSync(dir, "r");
      fs.fsyncSync(fd);
    } catch {
      // The file data is already durable. A directory fsync is the extra step, not a reason to fail the publish.
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
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
   * bytes on the path, and a dead author right now: ESRCH, or a boot session that is not the current one. On any other
   * outcome while the target may still be on the path, this process's marker stays complete.
   */
  function finalizeReclaim(lockFile: string, target: ConsoleLockInstance, h: string): ConsoleLockReclaimResult {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(lockFile);
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
      current = fs.readFileSync(lockFile);
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return goneAfterCleanup(lockFile, h);
      return { kind: "failed", reason: `the lock could not be read (${errnoOf(error) ?? "error"})` };
    }
    if (!current.equals(target.bytes)) return goneAfterCleanup(lockFile, h);
    if (isPidAlive(target.pid) && !bootSessionsDiffer(target.payload.bootSession, bootSession())) return { kind: "alive", pid: target.pid };
    try {
      fs.unlinkSync(lockFile);
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
    const recordedBoot = bootSession();
    const owner = Buffer.from(`${JSON.stringify({ v: 1, pid: process.pid, h, ...(recordedBoot ? { bootSession: recordedBoot } : {}) })}\n`, "utf8");
    const staging = stagingPath(lockFile, "ctmp");
    if (process.platform === "win32") {
      writeExclusiveFile(staging, owner);
      try {
        fs.linkSync(staging, claimPath);
        fsyncDirectory(path.dirname(claimPath));
        return "won";
      } catch (error) {
        if (errnoOf(error) === "EEXIST") return "lost";
        throw new Error(`hard links are not available in ${path.dirname(lockFile)}, so a dead lock cannot be reclaimed safely there (${errnoOf(error) ?? "error"})`);
      } finally {
        removeQuietly(staging);
      }
    }
    fs.mkdirSync(staging, { mode: CONSOLE_LOCK_DIR_MODE });
    try {
      writeExclusiveFile(path.join(staging, CLAIM_OWNER_FILE), owner);
    } catch (error) {
      removeQuietly(staging);
      throw error;
    }
    try {
      fs.renameSync(staging, claimPath);
    } catch (error) {
      removeQuietly(staging);
      if (CLAIM_LOST_CODES.has(errnoOf(error) ?? "")) return "lost";
      throw error;
    }
    fsyncDirectory(path.dirname(claimPath));
    return "won";
  }

  type ClaimState =
    | { readonly kind: "absent" }
    | { readonly kind: "foreign"; readonly reason: string }
    | { readonly kind: "unreadable"; readonly reason: string }
    | { readonly kind: "corrupt" }
    | { readonly kind: "alive"; readonly pid: number }
    | { readonly kind: "dead" };

  /** Read errors are not evidence. An incomplete marker, ESRCH, or a previous boot hands a generation over. */
  function classifyClaim(claimPath: string, h: string): ClaimState {
    const uid = currentUid();
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(claimPath);
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
        ownerStat = fs.lstatSync(ownerPath);
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
      bytes = fs.readFileSync(ownerPath);
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
    if (bootSessionsDiffer(record.bootSession, bootSession())) return { kind: "dead" };
    return isPidAlive(record.pid) ? { kind: "alive", pid: record.pid } : { kind: "dead" };
  }

  function newestClaimGeneration(lockFile: string, h: string): number {
    const prefix = `${claimPrefix(lockFile)}${h}-`;
    let newest = 0;
    for (const name of fs.readdirSync(path.dirname(lockFile))) {
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
      names = fs.readdirSync(dir);
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
      names = fs.readdirSync(dir);
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
      const stat = fs.lstatSync(entryPath);
      const uid = currentUid();
      return !stat.isSymbolicLink() && (uid === null || stat.uid === uid);
    } catch {
      return false;
    }
  }

  function removeQuietly(entryPath: string): void {
    try {
      fs.rmSync(entryPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of entries no one depends on.
    }
  }

  return { ensureLockDir, acquireLock, reclaimLock };
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
