import { CONSOLE_EXIT_RECORD_VERSION, KILL_CONFIRM_MS, PROCESS_TABLE_TIMEOUT_MS, STOP_POLL_MS } from "@fleet-console/protocol/lifecycle";

import { readConsoleExitRecord, writeConsoleExitRecord } from "./exit-record.js";
import { groupHasMembers, isSignallableGroup, proveOwnedGroup, readProcessTable, signalGroup, type OwnedProcessGroup, type ProcessGroupRow } from "./owned-processes.js";
import { isPidAlive } from "./process.js";

/** SIGTERM to the owned groups, then this long before SIGKILL: the SDK's own grace between its SIGTERM and SIGKILL. */
export const REAPER_TERM_GRACE_MS = 2_000;
/**
 * The longest a reaper drains after its Console is gone: a proof, the grace, a second proof, the kill confirmation, and a
 * margin. Past it the reaper exits whatever is left, so it never becomes an orphan itself.
 */
export const REAPER_DRAIN_MAX_MS = PROCESS_TABLE_TIMEOUT_MS + REAPER_TERM_GRACE_MS + PROCESS_TABLE_TIMEOUT_MS + KILL_CONFIRM_MS + 1_000;
/** How often an armed reaper checks that its Console still runs, in case its pipe never reports the end. */
export const REAPER_LIVENESS_INTERVAL_MS = 5_000;
/** A process table that cannot be read is asked again this often while the drain budget lasts. */
const PROCESS_TABLE_RETRY_MS = 300;

/** One line the Console writes to its reaper's stdin. */
export type ReaperMessage =
  | { readonly hello: { readonly consolePid: number; readonly lockFile: string; readonly lockStartedAt: number } }
  | { readonly add: OwnedProcessGroup }
  | { readonly leaderExited: { readonly pgid: number; readonly at: number } }
  | { readonly remove: { readonly pgid: number } };

export interface ReaperIo {
  /** The Console's end of the pipe: one JSON message per line; its end means the Console is gone. */
  readonly input: NodeJS.ReadableStream;
  readonly env: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly exit: (code: number) => void;
  /** One-line diagnostics; the reaper has no other output. */
  readonly log?: (message: string) => void;
}

/**
 * The per-Console watcher (docs/console-lifecycle-contract.md, "Children"). It holds the Console's registered process
 * groups and does nothing until the Console is gone — its pipe ends, or the Console's pid stops running. Then it records
 * `external` when the Console left no exit record, ends every group it can prove is still that group (SIGTERM, a grace,
 * a fresh proof, SIGKILL), and exits within REAPER_DRAIN_MAX_MS. It signals nothing it cannot prove, never its own group,
 * and nothing on Windows, where libuv's job object ends the Console's direct children.
 */
export function runReaper(io: ReaperIo): void {
  const now = io.now ?? Date.now;
  const log = io.log ?? (() => {});
  const groups = new Map<number, OwnedProcessGroup>();
  let hello: { readonly consolePid: number; readonly lockFile: string; readonly lockStartedAt: number } | null = null;
  let draining = false;
  let buffered = "";

  const accept = (line: string): void => {
    let message: ReaperMessage;
    try {
      message = JSON.parse(line) as ReaperMessage;
    } catch {
      return;
    }
    if ("hello" in message) hello = message.hello;
    else if ("add" in message) groups.set(message.add.pgid, { ...message.add });
    else if ("leaderExited" in message) {
      const group = groups.get(message.leaderExited.pgid);
      if (group) groups.set(group.pgid, { ...group, leaderExitedAt: message.leaderExited.at });
    } else if ("remove" in message) groups.delete(message.remove.pgid);
  };

  io.input.setEncoding?.("utf8");
  io.input.on("data", (chunk: string | Buffer) => {
    buffered += String(chunk);
    for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
      accept(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
    }
  });
  io.input.on("end", () => void drain("pipe closed"));
  io.input.on("error", () => void drain("pipe failed"));
  io.input.resume?.();

  // The pipe's end is the signal; this only covers a pipe whose write end leaked into another process.
  const liveness = setInterval(() => {
    if (hello && !isPidAlive(hello.consolePid)) void drain("console gone");
  }, REAPER_LIVENESS_INTERVAL_MS);

  async function drain(reason: string): Promise<void> {
    if (draining) return;
    draining = true;
    clearInterval(liveness);
    const endedAt = now();
    const cap = setTimeout(() => {
      log(`reaper_drain_timeout: ${reason}`);
      io.exit(0);
    }, REAPER_DRAIN_MAX_MS);
    try {
      if (!hello) return;
      // The pipe ends as the Console dies; its pid can linger a moment until its parent reaps it.
      const gone = now() + 1_000;
      while (isPidAlive(hello.consolePid) && now() < gone) await delay(STOP_POLL_MS);
      recordExternalEnding(hello);
      if (process.platform === "win32") return;
      const proven = await proveGroups([...groups.values()], endedAt);
      if (proven.length === 0) return;
      for (const pgid of proven) signalGroup(pgid, "SIGTERM");
      await waitForEmpty(proven, REAPER_TERM_GRACE_MS);
      const left = proven.filter(groupHasMembers);
      if (left.length === 0) return;
      // The grace let numbers be freed and reused: prove again right before SIGKILL.
      const again = await proveGroups(left.map((pgid) => groups.get(pgid)!).filter(Boolean), endedAt);
      for (const pgid of again) signalGroup(pgid, "SIGKILL");
      await waitForEmpty(again, KILL_CONFIRM_MS);
    } catch (error) {
      log(`reaper_drain_failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(cap);
      io.exit(0);
    }
  }

  /** The Console ended without its own record only when it was killed or froze; say so for whoever reads it. */
  function recordExternalEnding(instance: { readonly consolePid: number; readonly lockFile: string; readonly lockStartedAt: number }): void {
    const key = { pid: instance.consolePid, lockStartedAt: instance.lockStartedAt };
    if (readConsoleExitRecord(instance.lockFile, key)) return;
    try {
      writeConsoleExitRecord(instance.lockFile, { v: CONSOLE_EXIT_RECORD_VERSION, ...key, outcome: "external", killed: 0, at: now() });
    } catch (error) {
      log(`reaper_record_failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The groups the process table proves are still the registered ones. A table that cannot be read is asked again while
   * the budget allows (a second chance after the Console's own deadline could not read it); without one, nothing is proven.
   */
  async function proveGroups(candidates: readonly OwnedProcessGroup[], endedAt: number): Promise<number[]> {
    const live = candidates.filter((group) => isSignallableGroup(group.pgid) && group.pgid !== process.pid && groupHasMembers(group.pgid));
    if (live.length === 0) return [];
    const deadline = now() + PROCESS_TABLE_TIMEOUT_MS * 2;
    let rows: readonly ProcessGroupRow[] | null = null;
    for (;;) {
      const table = readProcessTable(io.env);
      if ("rows" in table) {
        rows = table.rows;
        break;
      }
      log(`reaper_proof_unavailable: ${table.error instanceof Error ? table.error.message : String(table.error)}`);
      if (now() >= deadline) return [];
      await delay(PROCESS_TABLE_RETRY_MS);
    }
    const until = Math.max(endedAt, now());
    return live.filter((group) => proveOwnedGroup(rows!, group, until)).map((group) => group.pgid);
  }

  async function waitForEmpty(pgids: readonly number[], budgetMs: number): Promise<void> {
    const deadline = now() + budgetMs;
    while (pgids.some(groupHasMembers) && now() < deadline) await delay(STOP_POLL_MS);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
