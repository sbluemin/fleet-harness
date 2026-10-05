import { spawn, spawnSync, type ChildProcess } from "node:child_process";

import { PROCESS_START_MARGIN_MS, PROCESS_TABLE_TIMEOUT_MS } from "@fleet-console/protocol/lifecycle";

import { parsePsLstartUtc } from "./process.js";

/** One process group this Console started and still answers for. Its number is its leader's pid. */
export interface OwnedProcessGroup {
  readonly pgid: number;
  /** Wall clock when spawn was called: every process of this group started at or after it. */
  readonly spawnedAt: number;
  /** When this Console saw the leader exit; its group may still hold children it started. */
  readonly leaderExitedAt: number | null;
}

export interface OwnedProcessSpawnRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}

export interface OwnedProcessKillInput {
  readonly env?: NodeJS.ProcessEnv;
  /** The process table could not be read, so no group whose leader had exited was signalled. */
  readonly onProcessTableUnavailable?: (error: unknown) => void;
}

/**
 * The process groups a Console started and must not outlive it (docs/console-lifecycle-contract.md, "Children"). Only what
 * is registered here is ever signalled by the Console's own deadline: a child handed off on purpose (the update worker, a
 * PTY session, a plugin's short-lived tool) is simply never registered.
 */
export interface OwnedProcessRegistry {
  /** Spawns `command` with piped stdio as the leader of a process group of its own (POSIX) and registers that group. */
  spawn(request: OwnedProcessSpawnRequest): ChildProcess;
  groups(): readonly OwnedProcessGroup[];
  /**
   * SIGKILLs every registered group, synchronously, and returns how many groups were signalled. A group whose leader is
   * this process's unreaped child is signalled without a process table: an unreaped child's pid, and so its group number,
   * cannot be reused (E1). A group whose leader already exited is signalled only if the process table proves its members
   * are this group's (`proveExitedLeaderGroup`); without a readable table it is left alone. POSIX only.
   */
  killAll(input?: OwnedProcessKillInput): number;
}

interface Entry {
  readonly pgid: number;
  readonly spawnedAt: number;
  readonly child: ChildProcess;
  leaderExitedAt: number | null;
}

export function createOwnedProcessRegistry(): OwnedProcessRegistry {
  const entries = new Map<number, Entry>();

  /** Drops groups whose leader exited and that no longer have a member. */
  function prune(): void {
    for (const entry of [...entries.values()]) {
      if (entry.leaderExitedAt !== null && !groupHasMembers(entry.pgid)) entries.delete(entry.pgid);
    }
  }

  return {
    spawn(request) {
      prune();
      const spawnedAt = Date.now();
      const child = spawn(request.command, [...request.args], {
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        env: { ...request.env },
        stdio: ["pipe", "pipe", "pipe"],
        // A group of its own lets the deadline and the watcher end the child together with everything it started.
        // Windows has no process groups; there libuv's job object ends a direct child with the Console.
        detached: process.platform !== "win32",
        windowsHide: true,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const pgid = child.pid;
      if (pgid !== undefined && process.platform !== "win32") {
        const entry: Entry = { pgid, spawnedAt, child, leaderExitedAt: null };
        entries.set(pgid, entry);
        child.once("exit", () => {
          entry.leaderExitedAt = Date.now();
          if (!groupHasMembers(pgid)) entries.delete(pgid);
        });
      }
      return child;
    },
    groups() {
      return [...entries.values()].map((entry) => ({ pgid: entry.pgid, spawnedAt: entry.spawnedAt, leaderExitedAt: entry.leaderExitedAt }));
    },
    killAll(input = {}) {
      if (process.platform === "win32") return 0;
      let killed = 0;
      const orphaned: Entry[] = [];
      for (const entry of entries.values()) {
        if (!isSignallableGroup(entry.pgid)) continue;
        // The leader has not been reaped, so this number is still this group (E1). JavaScript runs this loop to the end
        // before libuv can reap anything.
        if (entry.child.exitCode === null && entry.child.signalCode === null) {
          if (signalGroup(entry.pgid)) killed += 1;
        } else {
          orphaned.push(entry);
        }
      }
      if (orphaned.length === 0) return killed;
      const table = readProcessGroupTable(input.env ?? process.env);
      if ("error" in table) {
        input.onProcessTableUnavailable?.(table.error);
        return killed;
      }
      const now = Date.now();
      for (const entry of orphaned) {
        if (proveExitedLeaderGroup(table.rows, entry, now) && signalGroup(entry.pgid)) killed += 1;
      }
      return killed;
    },
  };
}

/** One row of `ps -A -o pid=,pgid=,lstart=`. */
export interface ProcessGroupRow {
  readonly pid: number;
  readonly pgid: number;
  /** Start time, epoch ms rounded down to the second. */
  readonly startedAt: number;
}

/**
 * Whether the members the table shows under a registered group whose leader already exited are that group's (R-proof):
 * no process may now hold the leader's pid (its number would then lead someone else's group), and every member must have
 * started between the group's spawn (less the start-time rounding margin) and now. A group with no member is proven
 * nothing: there is nothing to signal.
 */
export function proveExitedLeaderGroup(rows: readonly ProcessGroupRow[], group: Pick<OwnedProcessGroup, "pgid" | "spawnedAt">, now: number): boolean {
  if (!isSignallableGroup(group.pgid)) return false;
  const members = rows.filter((row) => row.pgid === group.pgid);
  if (members.length === 0) return false;
  if (members.some((row) => row.pid === group.pgid)) return false;
  return members.every((row) => row.startedAt >= group.spawnedAt - PROCESS_START_MARGIN_MS && row.startedAt <= now);
}

function readProcessGroupTable(env: NodeJS.ProcessEnv): { readonly rows: readonly ProcessGroupRow[] } | { readonly error: unknown } {
  const listing = spawnSync("ps", ["-A", "-o", "pid=,pgid=,lstart="], {
    env: { PATH: env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PROCESS_TABLE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (listing.error || listing.status !== 0 || typeof listing.stdout !== "string") {
    return { error: listing.error ?? new Error(`ps exited with ${listing.status ?? listing.signal}`) };
  }
  const rows: ProcessGroupRow[] = [];
  for (const line of listing.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*\S)\s*$/.exec(line);
    if (!match) continue;
    const startedAt = parsePsLstartUtc(match[3]!);
    if (startedAt !== null) rows.push({ pid: Number(match[1]), pgid: Number(match[2]), startedAt });
  }
  return { rows };
}

/** Never this process's own group (a Desktop sidecar shares Desktop's), and never a group number ≤ 1. */
function isSignallableGroup(pgid: number): boolean {
  return Number.isSafeInteger(pgid) && pgid > 1 && pgid !== process.pid;
}

function signalGroup(pgid: number): boolean {
  try {
    process.kill(-pgid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

/** Only ESRCH means the group is empty. */
function groupHasMembers(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code !== "ESRCH";
  }
}
