import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  CONSOLE_EXIT_RECORD_RETAIN,
  consoleExitRecordPath,
  parseConsoleExitRecord,
  parseConsoleExitRecordName,
  type ConsoleExitRecord,
  type ConsoleInstanceKey,
} from "@fleet-console/protocol/lifecycle";

const EXIT_RECORD_MODE = 0o600;
const EXIT_RECORD_STAGING = /^\.console\.exit\.[^/]*\.json\.([1-9]\d*)-[A-Za-z0-9_-]+\.tmp$/;

/** Only ESRCH means the process is gone. A live pid, EPERM, and any undecidable error all count as alive. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code !== "ESRCH";
  }
}

/**
 * Writes `record` as its instance's own exit record beside `lockFile`. Synchronous, so a Console can call it from its
 * `exit` handler. The record is staged under a fresh exclusive name and renamed into place: a reader sees no record or
 * the whole record, never a partial file, and a symlink at the record path is replaced rather than followed. Throws when
 * the slot cannot be written; the caller decides whether that matters.
 */
export function writeConsoleExitRecord(lockFile: string, record: ConsoleExitRecord): void {
  const target = consoleExitRecordPath(lockFile, record);
  const staging = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}-${crypto.randomBytes(6).toString("base64url")}.tmp`);
  const fd = fs.openSync(staging, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, EXIT_RECORD_MODE);
  try {
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
      fs.fchmodSync(fd, EXIT_RECORD_MODE);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(staging, target);
  } catch (error) {
    fs.rmSync(staging, { force: true });
    throw error;
  }
}

/**
 * The exit record `instance` left beside `lockFile`, or null when it left none, the file is a symlink or not a valid
 * record, or its content names another instance.
 */
export function readConsoleExitRecord(lockFile: string, instance: ConsoleInstanceKey): ConsoleExitRecord | null {
  const target = consoleExitRecordPath(lockFile, instance);
  try {
    if (!fs.lstatSync(target).isFile()) return null;
    const record = parseConsoleExitRecord(fs.readFileSync(target, "utf8"));
    return record && record.pid === instance.pid && record.lockStartedAt === instance.lockStartedAt ? record : null;
  } catch {
    return null;
  }
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
