import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describeRefusedConsoleLock } from "@fleet-console/protocol/lifecycle";

import { bootSessionsDiffer, currentConsoleBootSession } from "./boot-session.js";
import { isLockAuthorReplaced, isPidAlive } from "./process.js";
import { observeConsoleLockFile, type ConsoleLockFilePayload, type ConsoleLockTrustOptions } from "./lock-file.js";

const UPDATE_PROGRESS_FILE = "update-progress.json";
const UPDATE_RUNNING_PHASES = new Set(["starting", "preflight-ok", "stopping-console", "installing", "starting-daemon"]);
/** Same bound as the update progress reader: a running record with no live worker pid this old is not an active update. */
const UPDATE_PROGRESS_STALE_MS = 10 * 60 * 1000;

export type ConsoleLockRecoverRefusalCode =
  | "live_console"
  | "active_update"
  | "symlink"
  | "foreign_owner"
  | "not_regular_file"
  | "lock_changed"
  | "unreadable";

export type ConsoleLockRecoverResult =
  | { readonly kind: "cleared"; readonly removed: readonly string[] }
  | { readonly kind: "absent" }
  | { readonly kind: "refused"; readonly code: ConsoleLockRecoverRefusalCode; readonly reason: string };

type RefusedResult = Extract<ConsoleLockRecoverResult, { readonly kind: "refused" }>;

export interface ConsoleLockRecoverDeps {
  readonly bootSession?: () => string | null;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly isLockAuthorReplaced?: (lock: ConsoleLockFilePayload) => Promise<boolean>;
  readonly now?: () => number;
}

type ExpectedLockState =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly bytes: Buffer };

/**
 * Clears one slot's lock, reclaim markers, and staging leftovers after a person asks (`fleet console start --recover`,
 * or Desktop's recover button). A symlink or another user's entry is never deleted. A live Console from this boot,
 * an update whose worker is still running, or a lock that changed before removal is refused and nothing is removed.
 */
export async function recoverConsoleLockSlot(lockFile: string, dataDir: string, deps: ConsoleLockRecoverDeps = {}): Promise<ConsoleLockRecoverResult> {
  const pidAlive = deps.isPidAlive ?? isPidAlive;
  const bootSession = deps.bootSession ?? currentConsoleBootSession;
  const checkAuthorReplaced = deps.isLockAuthorReplaced ?? isLockAuthorReplaced;
  const now = deps.now ?? Date.now;
  const trust: ConsoleLockTrustOptions = { bootSession };
  const observed = observeConsoleLockFile(lockFile, trust);
  if (observed.kind === "refused") {
    return {
      kind: "refused",
      code: observed.reason === "it is a symbolic link" ? "symlink" : "foreign_owner",
      reason: describeRefusedConsoleLock(lockFile, observed.reason),
    };
  }
  let expectedLock: ExpectedLockState;
  if (observed.kind === "absent") {
    expectedLock = { kind: "absent" };
  } else if (observed.kind === "owner") {
    expectedLock = { kind: "present", bytes: observed.instance.bytes };
  } else {
    const read = readOwnedRegularLockBytes(lockFile);
    if (read.kind === "refused") return read;
    expectedLock = { kind: "present", bytes: read.bytes };
  }
  const update = activeUpdateReason(dataDir, pidAlive, now());
  if (update !== null) return { kind: "refused", code: "active_update", reason: update };
  if (observed.kind === "owner" && observed.alive && !observed.previousBoot) {
    const replaced = await checkAuthorReplaced(observed.instance.payload);
    if (!replaced) {
      return {
        kind: "refused",
        code: "live_console",
        reason: `pid ${observed.instance.pid} is still running and was not shown to be a previous boot's process, so ${lockFile} was left in place. Stop that Fleet Console before recovering the lock.`,
      };
    }
  }
  const dir = path.dirname(lockFile);
  const names = listDir(dir);
  const foreign = foreignSlotEntry(dir, lockFile, names);
  if (foreign !== null) return foreign;
  const preCheck = verifyExpectedLock(lockFile, expectedLock);
  if (preCheck !== null) return preCheck;
  const targets = slotEntries(dir, lockFile, names, pidAlive);
  if (observed.kind === "absent" && targets.length === 0) return { kind: "absent" };
  const backup = path.join(dir, `.console.lock.recover-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(backup, { mode: 0o700 });
  const removed: string[] = [];
  try {
    for (const name of targets) {
      copyOwnedEntry(path.join(dir, name), path.join(backup, name));
    }
    const updateBeforeRemove = activeUpdateReason(dataDir, pidAlive, now());
    if (updateBeforeRemove !== null) {
      removeBackupQuietly(backup);
      return { kind: "refused", code: "active_update", reason: updateBeforeRemove };
    }
    const lockBeforeRemove = verifyExpectedLock(lockFile, expectedLock);
    if (lockBeforeRemove !== null) {
      removeBackupQuietly(backup);
      return lockBeforeRemove;
    }
    const lockBase = path.basename(lockFile);
    for (const name of targets) {
      const entry = path.join(dir, name);
      if (name === lockBase) {
        const finalCheck = verifyExpectedLock(lockFile, expectedLock);
        if (finalCheck !== null) {
          if (removed.length === 0) removeBackupQuietly(backup);
          return finalCheck;
        }
      } else if (!isOwnedNonSymlink(entry)) {
        continue;
      }
      fs.rmSync(entry, { recursive: true, force: true });
      removed.push(entry);
    }
  } catch (error) {
    if (removed.length === 0) removeBackupQuietly(backup);
    return { kind: "refused", code: "unreadable", reason: `recovery stopped before the slot was cleared (${error instanceof Error ? error.message : String(error)}). Already copied entries are in ${backup}.` };
  }
  return { kind: "cleared", removed };
}

function readOwnedRegularLockBytes(lockFile: string): { readonly kind: "present"; readonly bytes: Buffer } | RefusedResult {
  const uid = currentUid();
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(lockFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "refused", code: "lock_changed", reason: "the lock changed while recovery was checking it; nothing was removed." };
    }
    return { kind: "refused", code: "unreadable", reason: `the lock could not be read (${(error as NodeJS.ErrnoException).code ?? "error"}); nothing was removed.` };
  }
  if (stat.isSymbolicLink()) return { kind: "refused", code: "symlink", reason: describeRefusedConsoleLock(lockFile, "it is a symbolic link") };
  if (uid !== null && stat.uid !== uid) return { kind: "refused", code: "foreign_owner", reason: describeRefusedConsoleLock(lockFile, `it is owned by uid ${stat.uid}`) };
  if (!stat.isFile()) return { kind: "refused", code: "not_regular_file", reason: `the lock ${lockFile} is not a regular file; nothing was removed.` };
  try {
    return { kind: "present", bytes: fs.readFileSync(lockFile) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      kind: "refused",
      code: code === "ENOENT" ? "lock_changed" : "unreadable",
      reason: code === "ENOENT"
        ? "the lock changed while recovery was checking it; nothing was removed."
        : `the lock could not be read (${code ?? "error"}); nothing was removed.`,
    };
  }
}

function verifyExpectedLock(lockFile: string, expected: ExpectedLockState): RefusedResult | null {
  const uid = currentUid();
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(lockFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return expected.kind === "absent"
        ? null
        : { kind: "refused", code: "lock_changed", reason: "the lock changed while recovery was checking it; nothing was removed." };
    }
    return { kind: "refused", code: "unreadable", reason: `the lock could not be verified (${(error as NodeJS.ErrnoException).code ?? "error"}); nothing was removed.` };
  }
  if (expected.kind === "absent") {
    return { kind: "refused", code: "lock_changed", reason: "a new lock appeared while recovery was checking the slot; nothing was removed." };
  }
  if (stat.isSymbolicLink()) return { kind: "refused", code: "symlink", reason: describeRefusedConsoleLock(lockFile, "it is a symbolic link") };
  if (uid !== null && stat.uid !== uid) return { kind: "refused", code: "foreign_owner", reason: describeRefusedConsoleLock(lockFile, `it is owned by uid ${stat.uid}`) };
  if (!stat.isFile()) return { kind: "refused", code: "not_regular_file", reason: "the lock changed into something that is not a regular lock file; nothing was removed." };
  let currentBytes: Buffer;
  try {
    currentBytes = fs.readFileSync(lockFile);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      kind: "refused",
      code: code === "ENOENT" ? "lock_changed" : "unreadable",
      reason: code === "ENOENT"
        ? "the lock changed while recovery was checking it; nothing was removed."
        : `the lock could not be verified (${code ?? "error"}); nothing was removed.`,
    };
  }
  if (!currentBytes.equals(expected.bytes)) {
    return { kind: "refused", code: "lock_changed", reason: "the lock changed while recovery was checking it; nothing was removed." };
  }
  return null;
}

function isOwnedNonSymlink(entry: string): boolean {
  try {
    const stat = fs.lstatSync(entry);
    const uid = currentUid();
    return !stat.isSymbolicLink() && (uid === null || stat.uid === uid);
  } catch {
    return false;
  }
}

function removeBackupQuietly(backup: string): void {
  try {
    fs.rmSync(backup, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup when recovery refused before deleting anything.
  }
}

function activeUpdateReason(dataDir: string, pidAlive: (pid: number) => boolean, now: number): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dataDir, UPDATE_PROGRESS_FILE), "utf8");
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as { phase?: unknown; workerPid?: unknown; updatedAt?: unknown };
  if (typeof record.phase !== "string" || !UPDATE_RUNNING_PHASES.has(record.phase)) return null;
  if (typeof record.workerPid === "number" && Number.isSafeInteger(record.workerPid) && record.workerPid > 0) {
    if (!pidAlive(record.workerPid)) return null;
    return `an update is still running (worker pid ${record.workerPid}); the lock was left in place.`;
  }
  const updatedAt = typeof record.updatedAt === "string" ? Date.parse(record.updatedAt) : Number.NaN;
  if (Number.isFinite(updatedAt) && now - updatedAt > UPDATE_PROGRESS_STALE_MS) return null;
  return "an update progress record is still running and its worker could not be shown to have exited; the lock was left in place.";
}

function listDir(dir: string): readonly string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** A symlink or another user's lock, claim, or staging entry. Recovery never deletes one, and will not clear around it. */
function foreignSlotEntry(dir: string, lockFile: string, names: readonly string[]): RefusedResult | null {
  const base = path.basename(lockFile);
  const uid = currentUid();
  for (const name of names) {
    if (!isSlotName(base, name)) continue;
    const entry = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(entry);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) return { kind: "refused", code: "symlink", reason: `Refusing ${entry}: it is a symbolic link. It was not removed.` };
    if (uid !== null && stat.uid !== uid) return { kind: "refused", code: "foreign_owner", reason: `Refusing ${entry}: it is owned by uid ${stat.uid}. It was not removed.` };
    if (stat.isDirectory()) {
      const owner = path.join(entry, "owner.json");
      let ownerStat: fs.Stats;
      try {
        ownerStat = fs.lstatSync(owner);
      } catch {
        continue;
      }
      if (ownerStat.isSymbolicLink()) return { kind: "refused", code: "symlink", reason: `Refusing ${owner}: it is a symbolic link. It was not removed.` };
      if (uid !== null && ownerStat.uid !== uid) return { kind: "refused", code: "foreign_owner", reason: `Refusing ${owner}: it is owned by uid ${ownerStat.uid}. It was not removed.` };
    }
  }
  return null;
}

function slotEntries(dir: string, lockFile: string, names: readonly string[], pidAlive: (pid: number) => boolean): string[] {
  const base = path.basename(lockFile);
  const selected: string[] = [];
  if (names.includes(base)) selected.push(base);
  for (const name of names) {
    if (name === base) continue;
    if (!isSlotName(base, name)) continue;
    if (isLiveStaging(name, base, pidAlive)) continue;
    selected.push(name);
  }
  return selected;
}

function isSlotName(base: string, name: string): boolean {
  return name === base || name.startsWith(`.${base}.claim-`) || name.startsWith(`.${base}.tmp-`) || name.startsWith(`.${base}.ctmp-`);
}

/** Staging whose writer is still alive stays: it may be a publish in progress. A dead writer's leftover goes. */
function isLiveStaging(name: string, base: string, pidAlive: (pid: number) => boolean): boolean {
  const tmp = `.${base}.tmp-`;
  const ctmp = `.${base}.ctmp-`;
  const rest = name.startsWith(tmp) ? name.slice(tmp.length) : name.startsWith(ctmp) ? name.slice(ctmp.length) : null;
  if (rest === null) return false;
  const match = /^(\d+)-/.exec(rest);
  if (!match) return false;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 && pidAlive(pid);
}

function copyOwnedEntry(from: string, to: string): void {
  const stat = fs.lstatSync(from);
  if (stat.isSymbolicLink()) throw new Error(`refusing to copy symbolic link ${from}`);
  fs.cpSync(from, to, { recursive: true, dereference: false });
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/** The boot session a lock payload recorded, when it has one. Shared so callers do not re-parse the file. */
export function recordedBootSession(payload: ConsoleLockFilePayload): string | undefined {
  return typeof payload.bootSession === "string" ? payload.bootSession : undefined;
}

export function lockAuthorFromPreviousBoot(payload: ConsoleLockFilePayload, current: string | null = currentConsoleBootSession()): boolean {
  return bootSessionsDiffer(payload.bootSession, current);
}
