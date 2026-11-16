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

export type ConsoleLockRecoverResult =
  | { readonly kind: "cleared"; readonly removed: readonly string[] }
  | { readonly kind: "absent" }
  | { readonly kind: "refused"; readonly reason: string };

export interface ConsoleLockRecoverDeps {
  readonly bootSession?: () => string | null;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly now?: () => number;
}

/**
 * Clears one slot's lock, reclaim markers, and staging leftovers after a person asks (`fleet console start --recover`,
 * or Desktop's recover button). A symlink or another user's entry is never deleted. A live Console from this boot,
 * or an update whose worker is still running, is refused and nothing is removed.
 */
export async function recoverConsoleLockSlot(lockFile: string, dataDir: string, deps: ConsoleLockRecoverDeps = {}): Promise<ConsoleLockRecoverResult> {
  const pidAlive = deps.isPidAlive ?? isPidAlive;
  const bootSession = deps.bootSession ?? currentConsoleBootSession;
  const trust: ConsoleLockTrustOptions = { bootSession };
  const observed = observeConsoleLockFile(lockFile, trust);
  if (observed.kind === "refused") return { kind: "refused", reason: describeRefusedConsoleLock(lockFile, observed.reason) };
  const update = activeUpdateReason(dataDir, pidAlive, (deps.now ?? Date.now)());
  if (update !== null) return { kind: "refused", reason: update };
  if (observed.kind === "owner" && observed.alive && !observed.previousBoot) {
    const replaced = await isLockAuthorReplaced(observed.instance.payload);
    if (!replaced) {
      return {
        kind: "refused",
        reason: `pid ${observed.instance.pid} is still running and was not shown to be a previous boot's process, so ${lockFile} was left in place. Stop that Fleet Console before recovering the lock.`,
      };
    }
  }
  const dir = path.dirname(lockFile);
  const names = listDir(dir);
  const foreign = foreignSlotEntry(dir, lockFile, names);
  if (foreign !== null) return { kind: "refused", reason: foreign };
  const targets = slotEntries(dir, lockFile, names, pidAlive);
  if (observed.kind === "absent" && targets.length === 0) return { kind: "absent" };
  const backup = path.join(dir, `.console.lock.recover-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(backup, { mode: 0o700 });
  const removed: string[] = [];
  try {
    for (const name of targets) {
      const entry = path.join(dir, name);
      copyOwnedEntry(entry, path.join(backup, name));
      fs.rmSync(entry, { recursive: true, force: true });
      removed.push(entry);
    }
  } catch (error) {
    return { kind: "refused", reason: `recovery stopped before the slot was cleared (${error instanceof Error ? error.message : String(error)}). Already copied entries are in ${backup}.` };
  }
  return { kind: "cleared", removed };
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
function foreignSlotEntry(dir: string, lockFile: string, names: readonly string[]): string | null {
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
    if (stat.isSymbolicLink()) return `Refusing ${entry}: it is a symbolic link. It was not removed.`;
    if (uid !== null && stat.uid !== uid) return `Refusing ${entry}: it is owned by uid ${stat.uid}. It was not removed.`;
    if (stat.isDirectory()) {
      const owner = path.join(entry, "owner.json");
      let ownerStat: fs.Stats;
      try {
        ownerStat = fs.lstatSync(owner);
      } catch {
        continue;
      }
      if (ownerStat.isSymbolicLink()) return `Refusing ${owner}: it is a symbolic link. It was not removed.`;
      if (uid !== null && ownerStat.uid !== uid) return `Refusing ${owner}: it is owned by uid ${ownerStat.uid}. It was not removed.`;
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
