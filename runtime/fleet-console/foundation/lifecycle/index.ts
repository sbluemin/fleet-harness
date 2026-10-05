import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { consoleExitRecordPath, parseConsoleExitRecord, type ConsoleExitRecord } from "@fleet-console/protocol/lifecycle";

const EXIT_RECORD_MODE = 0o600;

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
 * Replaces the exit record beside `lockFile` with `record`. Synchronous, so a Console can call it from its `exit`
 * handler. The record is staged under a fresh exclusive name and renamed into place: a reader sees the previous record
 * or this one, never a partial file, and a symlink at the record path is replaced rather than followed. Throws when the
 * slot cannot be written; the caller decides whether that matters.
 */
export function writeConsoleExitRecord(lockFile: string, record: ConsoleExitRecord): void {
  const target = consoleExitRecordPath(lockFile);
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

/** The exit record beside `lockFile`, or null when there is none, it is a symlink, or it is not a valid record. */
export function readConsoleExitRecord(lockFile: string): ConsoleExitRecord | null {
  const target = consoleExitRecordPath(lockFile);
  try {
    if (!fs.lstatSync(target).isFile()) return null;
    return parseConsoleExitRecord(fs.readFileSync(target, "utf8"));
  } catch {
    return null;
  }
}
