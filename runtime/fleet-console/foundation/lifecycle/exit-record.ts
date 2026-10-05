import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  CONSOLE_EXIT_RECORD_RETAIN,
  CONSOLE_EXIT_RECORD_VERSION,
  consoleExitRecordPath,
  parseConsoleExitRecord,
  parseConsoleExitRecordName,
  type ConsoleExitRecord,
  type ConsoleExitRecordRead,
  type ConsoleInstanceKey,
} from "@fleet-console/protocol/lifecycle";

import { isPidAlive } from "./process.js";

const EXIT_RECORD_MODE = 0o600;
const EXIT_RECORD_STAGING = /^\.console\.exit\.[^/]*\.json\.([1-9]\d*)-[A-Za-z0-9_-]+\.tmp$/;

/**
 * Writes `record` as its instance's own exit record beside `lockFile`. Synchronous, so a Console can call it from its
 * `exit` handler. The record is staged under a fresh exclusive name and renamed into place: a reader sees no record or
 * the whole record, never a partial file, and a symlink at the record path is replaced rather than followed. Throws when
 * the slot cannot be written; the caller decides whether that matters.
 *
 * Several writers can record one instance, and the one that knows most wins whatever order they write in
 * (docs/console-lifecycle-contract.md, "Exit record"): the Console's own outcome replaces anything; `forced-external`, from
 * the actor that sent SIGKILL, replaces only no record or an inferred `external`; `external`, inferred by the reaper, is
 * only ever created and never replaces a record. Returns whether this record was written.
 */
export function writeConsoleExitRecord(lockFile: string, record: ConsoleExitRecord): boolean {
  const target = consoleExitRecordPath(lockFile, record);
  if (record.outcome === "forced-external") {
    const current = readConsoleExitRecord(lockFile, record);
    if (current !== null && current.outcome !== "external") return false;
  }
  const staging = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}-${crypto.randomBytes(6).toString("base64url")}.tmp`);
  const fd = fs.openSync(staging, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, EXIT_RECORD_MODE);
  try {
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
      fs.fchmodSync(fd, EXIT_RECORD_MODE);
    } finally {
      fs.closeSync(fd);
    }
    if (record.outcome !== "external") {
      fs.renameSync(staging, target);
      return true;
    }
    // A link fails on an existing path, so an inferred ending never overwrites a record another writer already left.
    try {
      fs.linkSync(staging, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "EEXIST") return false;
      throw error;
    } finally {
      fs.rmSync(staging, { force: true });
    }
    return true;
  } catch (error) {
    fs.rmSync(staging, { force: true });
    throw error;
  }
}

/**
 * The exit record `instance` left beside `lockFile`, or null when it left none. A file that is there but cannot be read
 * as this instance's record — another version, malformed, a symlink, or naming another instance — reads as outcome
 * `unknown`, never as no record, so a reader fails closed instead of reporting a clean stop.
 */
export function readConsoleExitRecord(lockFile: string, instance: ConsoleInstanceKey): ConsoleExitRecordRead | null {
  const target = consoleExitRecordPath(lockFile, instance);
  const unknown: ConsoleExitRecordRead = { v: CONSOLE_EXIT_RECORD_VERSION, ...instance, outcome: "unknown", killed: 0, at: 0 };
  try {
    if (!fs.lstatSync(target).isFile()) return unknown;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? null : unknown;
  }
  try {
    const record = parseConsoleExitRecord(fs.readFileSync(target, "utf8"));
    return record && record.pid === instance.pid && record.lockStartedAt === instance.lockStartedAt ? record : unknown;
  } catch {
    return unknown;
  }
}

/** How an instance an actor waited for ended: its recorded outcome, or `unrecorded` when it cannot be blamed. */
export type ConsoleEndingOutcome = ConsoleExitRecordRead["outcome"] | "unrecorded";

export interface ConsoleEndingEvidence {
  /** The `lifecycleWire` its authenticated health reported when the reader asked it, if it did. */
  readonly lifecycleWire: unknown;
  /** The reader itself sent SIGTERM. On Windows that is TerminateProcess, so no shutdown ran that could write a record. */
  readonly terminatedByReader: boolean;
  readonly platform?: NodeJS.Platform;
}

/**
 * How an instance ended, read once its process is gone (docs/console-lifecycle-contract.md, "Exit record"): its own record
 * when it left one. Without one, a Console that reported `lifecycleWire` ≥ 1 knows the contract, so it was ended from
 * outside (`external`), never a clean stop; a Console from before the contract, or one this reader terminated on Windows,
 * cannot be blamed (`unrecorded`).
 */
export function readConsoleEnding(lockFile: string, instance: ConsoleInstanceKey, evidence: ConsoleEndingEvidence): { readonly outcome: ConsoleEndingOutcome; readonly killed: number } {
  const record = readConsoleExitRecord(lockFile, instance);
  if (record) return { outcome: record.outcome, killed: record.killed };
  const wire = evidence.lifecycleWire;
  const knowsContract = typeof wire === "number" && wire >= 1;
  const terminated = evidence.terminatedByReader && (evidence.platform ?? process.platform) === "win32";
  return { outcome: knowsContract && !terminated ? "external" : "unrecorded", killed: 0 };
}

/**
 * Prunes the exit records beside `lockFile`. Only the current lock owner calls this, right after it took the lock, so a
 * serve that loses the lock never touches the slot. The newest CONSOLE_EXIT_RECORD_RETAIN records stay; an older one goes
 * only once its pid is ESRCH, and an abandoned staging file only once its writer is. Best effort: an entry that cannot be
 * judged or removed stays.
 */
export function pruneConsoleExitRecords(lockFile: string): void {
  const dir = path.dirname(lockFile);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const records = names
    .map((name) => ({ name, key: parseConsoleExitRecordName(name) }))
    .filter((entry): entry is { readonly name: string; readonly key: ConsoleInstanceKey } => entry.key !== null)
    .sort((left, right) => right.key.lockStartedAt - left.key.lockStartedAt);
  for (const { name, key } of records.slice(CONSOLE_EXIT_RECORD_RETAIN)) {
    if (!isPidAlive(key.pid)) removeQuietly(path.join(dir, name));
  }
  for (const name of names) {
    const writer = EXIT_RECORD_STAGING.exec(name)?.[1];
    if (writer !== undefined && !isPidAlive(Number(writer))) removeQuietly(path.join(dir, name));
  }
}

function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Left for the next owner's prune.
  }
}
