import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";

import { PROCESS_START_MARGIN_MS, PROCESS_TABLE_TIMEOUT_MS } from "@fleet-console/protocol/lifecycle";

import { parsePsLstartUtc } from "./process.js";

/** One process group this Console started and still answers for. Its number is its leader's pid. */
export interface OwnedProcessGroup {
  readonly pgid: number;
  /** Wall clock when spawn was called: every process of this group started at or after it. */
  readonly spawnedAt: number;
  /** When this Console saw the leader exit; its group may still hold children it started. */
  readonly leaderExitedAt: number | null;
  /** Who asked for it, for diagnostics only (`plugin:<id>` for a plugin's child). */
  readonly owner?: string;
}

export interface OwnedProcessSpawnRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  /** `ignore` gives the child no stdin, for tools that would otherwise wait for its end. Default `pipe`. */
  readonly stdin?: "pipe" | "ignore";
  readonly owner?: string;
}

/** What a watcher outside the Console must hear about the registry, as it happens. */
export interface OwnedProcessRegistryEvents {
  readonly onRegistered?: (group: OwnedProcessGroup) => void;
  readonly onLeaderExited?: (group: OwnedProcessGroup) => void;
  /** The group has no member left and was dropped. */
  readonly onRemoved?: (pgid: number) => void;
}

/**
 * One Windows owned group: a job the Console alone holds. POSIX never sees this. The host injects it; this package does
 * not load a native binding. Methods may throw; the registry treats a throw as "could not prove the job empty" and
 * leaves the handle open.
 */
export interface ProcessGroupContainment {
  /** True when the job still has a member. A failed query counts as members remaining, so a live job is never closed. */
  hasMembers(): boolean;
  /** Asks the kernel to end every member. False when the call fails; the handle stays open. */
  terminate(): boolean;
  /**
   * Closes the leader's process handle and the job handle. Does nothing while `hasMembers()` is true: a job that still
   * has members stays open so the kernel can end them when the Console itself dies.
   */
  close(): void;
}

/**
 * Windows containment, injected by the Console host (`console-lifecycle.ts` only). `contain` never throws: a failed
 * create or assign returns null, and that child stays in libuv's job instead of being registered.
 */
export interface ProcessContainmentPort {
  contain(pid: number): ProcessGroupContainment | null;
}

export interface OwnedProcessRegistryOptions extends OwnedProcessRegistryEvents {
  /**
   * Windows only. When set, each spawned leader is assigned to a job of its own and the group is registered. Absent on
   * Windows, nothing is registered and libuv's job is the whole containment, as before. Ignored on POSIX.
   */
  readonly containment?: ProcessContainmentPort;
}

export interface OwnedProcessKillInput {
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The process table to judge by. The stop deadline passes one `createProcessTableSnapshot` to every step, so the table is
   * read (and its budget spent) at most once; without it each call reads its own.
   */
  readonly table?: ProcessTableSnapshot;
  /** The process table could not be read, so nothing that needed it was signalled. */
  readonly onProcessTableUnavailable?: (error: unknown) => void;
}

/**
 * The process groups a Console started and must not outlive it (docs/console-lifecycle-contract.md, "Children"). Only what
 * is registered here is ever signalled by the Console's own deadline: a child handed off on purpose (the update worker, a
 * PTY session, a plugin's short-lived tool) is simply never registered.
 */
export interface OwnedProcessRegistry {
  /**
   * Spawns `command` with piped stdio as the leader of an owned group and registers that group. On POSIX the group is a
   * process group (`detached`). On Windows, when a containment port is injected, the group is a job and the child stays
   * non-detached so libuv's job remains the fallback. Without the port on Windows the child is not registered.
   */
  spawn(request: OwnedProcessSpawnRequest): ChildProcess;
  groups(): readonly OwnedProcessGroup[];
  /**
   * Ends one registered group: a process-group signal on POSIX, or the job on Windows. A child that was never registered
   * (no port, or that group's assign failed) is signalled alone. Returns whether an end was requested.
   */
  killGroup(child: ChildProcess, signal?: NodeJS.Signals): boolean;
  /**
   * SIGKILLs every registered group, synchronously, and returns how many groups were signalled. A group whose leader is
   * this process's unreaped child is signalled without a process table: an unreaped child's pid, and so its group number,
   * cannot be reused (E1). A group whose leader already exited is signalled only if the process table proves its members
   * are this group's (`proveExitedLeaderGroup`); without a readable table it is left alone.
   * On Windows, with a containment port, every job that still has members is terminated and the return counts those
   * calls that succeeded. The leader's open process handle is the pid-reuse proof (E1); there is no process table.
   * Without the port this returns 0.
   */
  killAll(input?: OwnedProcessKillInput): number;
  /**
   * The stop path's end for the selected groups (docs/console-lifecycle-contract.md, "Children"): SIGTERM now and
   * SIGKILL after `graceMs`, each to a group whose leader is still this process's unreaped child (E1), with no process
   * table. When the grace ends, a selected group whose leader has exited but which still has members (a helper that
   * ignored SIGTERM, or one a leader left before the stop, which then gets no SIGTERM) is SIGKILLed only if one
   * asynchronous process-table read proves it (`proveExitedLeaderGroup`); without a readable table it is left alone.
   * The timer never keeps the process alive. Returns how many groups got SIGTERM.
   * On Windows, with a containment port, the same `graceMs` is time to exit on their own and then the job is terminated;
   * there is no process-table read, and the return is how many jobs still had members. Without the port this returns 0.
   */
  endGroups(select: (group: OwnedProcessGroup) => boolean, graceMs: number, input?: OwnedProcessKillInput): number;
}

interface Entry {
  readonly pgid: number;
  readonly spawnedAt: number;
  readonly child: ChildProcess;
  readonly owner?: string;
  leaderExitedAt: number | null;
  /** Set only for a Windows group whose job assign succeeded. Absent on POSIX and on a degraded Windows child. */
  readonly containment?: ProcessGroupContainment;
}

export function createOwnedProcessRegistry(options: OwnedProcessRegistryOptions = {}): OwnedProcessRegistry {
  const entries = new Map<number, Entry>();
  const containment = process.platform === "win32" ? options.containment : undefined;
  const snapshot = (entry: Entry): OwnedProcessGroup => ({ pgid: entry.pgid, spawnedAt: entry.spawnedAt, leaderExitedAt: entry.leaderExitedAt, ...(entry.owner === undefined ? {} : { owner: entry.owner }) });
  const remove = (pgid: number): void => {
    if (entries.delete(pgid)) options.onRemoved?.(pgid);
  };

  /** A failed job query counts as members remaining: an uncertain job is never closed or dropped. */
  function entryHasMembers(entry: Entry): boolean {
    if (!entry.containment) return groupHasMembers(entry.pgid);
    try { return entry.containment.hasMembers(); }
    catch { return true; }
  }

  /** Drops a group that has no member left, closing its job only then. */
  function releaseEntry(entry: Entry): void {
    try { entry.containment?.close(); }
    catch { /* The handle dies with the process, which still runs KILL_ON_JOB_CLOSE. */ }
    remove(entry.pgid);
  }

  /** Drops groups whose leader exited and that no longer have a member. */
  function prune(): void {
    for (const entry of [...entries.values()]) {
      if (entry.leaderExitedAt !== null && !entryHasMembers(entry)) releaseEntry(entry);
    }
  }

  function watchLeader(entry: Entry): void {
    options.onRegistered?.(snapshot(entry));
    entry.child.once("exit", () => {
      entry.leaderExitedAt = Date.now();
      options.onLeaderExited?.(snapshot(entry));
      if (!entryHasMembers(entry)) releaseEntry(entry);
    });
  }

  /**
   * Assigns a Windows leader to a new job. Null means this child stays on libuv's job: no port, the assign failed, or
   * the pid still names a live group. Never throws, so a containment failure cannot take down the Console.
   */
  function adoptContainment(pgid: number): ProcessGroupContainment | null {
    if (!containment) return null;
    const existing = entries.get(pgid);
    if (existing?.containment) {
      // The held process handle makes a live collision unreachable; refusing it keeps that job from being replaced.
      if (entryHasMembers(existing)) return null;
      releaseEntry(existing);
    }
    try { return containment.contain(pgid); }
    catch { return null; }
  }

  return {
    spawn(request) {
      prune();
      const spawnedAt = Date.now();
      const child = spawn(request.command, [...request.args], {
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        env: { ...request.env },
        stdio: [request.stdin ?? "pipe", "pipe", "pipe"],
        // A group of its own lets the deadline and the watcher end the child together with everything it started.
        // Windows stays non-detached: libuv's job remains the fallback when this group's own job cannot be assigned.
        detached: process.platform !== "win32",
        windowsHide: true,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const pgid = child.pid;
      if (pgid !== undefined && (process.platform !== "win32" || containment)) {
        const held = adoptContainment(pgid);
        if (process.platform !== "win32" || held) {
          const entry: Entry = { pgid, spawnedAt, child, leaderExitedAt: null, ...(held ? { containment: held } : {}), ...(request.owner === undefined ? {} : { owner: request.owner }) };
          entries.set(pgid, entry);
          watchLeader(entry);
        }
      }
      return child;
    },
    groups() {
      // Windows drops an empty job when the groups are read, not only on the next spawn. POSIX keeps its previous timing.
      if (containment) prune();
      return [...entries.values()].map(snapshot);
    },
    killGroup(child, signal = "SIGTERM") {
      const entry = child.pid === undefined ? undefined : entries.get(child.pid);
      if (!entry?.containment) return signalChildGroup(child, signal);
      try {
        if (!entry.containment.hasMembers()) {
          releaseEntry(entry);
          return false;
        }
        const ended = entry.containment.terminate();
        if (!entry.containment.hasMembers()) releaseEntry(entry);
        return ended;
      } catch {
        return false;
      }
    },
    endGroups(select, graceMs, input = {}) {
      if (process.platform === "win32") {
        if (!containment) return 0;
        prune();
        const requested = [...entries.values()].filter((entry) => entry.containment && entryHasMembers(entry) && select(snapshot(entry)));
        if (requested.length > 0) {
          const escalate = setTimeout(() => {
            for (const entry of requested) {
              // The pid may have been freed and reused for a new group during the grace. Identity, not the key, decides.
              if (entries.get(entry.pgid) !== entry || !entry.containment) continue;
              try { if (entryHasMembers(entry)) entry.containment.terminate(); }
              catch { /* Leave the handle open. The process exit still closes it. */ }
              if (!entryHasMembers(entry)) releaseEntry(entry);
            }
          }, graceMs);
          escalate.unref?.();
        }
        return requested.length;
      }
      const unreaped = (entry: Entry) => entry.child.exitCode === null && entry.child.signalCode === null;
      const chosen = [...entries.values()].filter((entry) => isSignallableGroup(entry.pgid) && select(snapshot(entry)));
      let signalled = 0;
      for (const entry of chosen) if (unreaped(entry) && signalGroup(entry.pgid, "SIGTERM")) signalled += 1;
      if (signalled > 0 || chosen.some((entry) => groupHasMembers(entry.pgid))) {
        const escalate = setTimeout(() => {
          const leaderless: Entry[] = [];
          for (const entry of chosen) {
            if (unreaped(entry)) signalGroup(entry.pgid, "SIGKILL");
            else if (groupHasMembers(entry.pgid)) leaderless.push(entry);
          }
          // Only here does this path read the process table, once for every such group: a leader gone with members left
          // behind (a helper that ignored SIGTERM, or one left by a leader that had exited before the stop).
          if (leaderless.length === 0) return;
          void readProcessTableAsync(input.env ?? process.env).then((table) => {
            if ("error" in table) {
              input.onProcessTableUnavailable?.(table.error);
              return;
            }
            const now = Date.now();
            for (const entry of leaderless) if (proveExitedLeaderGroup(table.rows, entry, now)) signalGroup(entry.pgid, "SIGKILL");
          });
        }, graceMs);
        escalate.unref?.();
      }
      return signalled;
    },
    killAll(input = {}) {
      if (process.platform === "win32") {
        if (!containment) return 0;
        let killed = 0;
        for (const entry of [...entries.values()]) {
          if (!entry.containment) continue;
          try {
            if (!entryHasMembers(entry)) {
              releaseEntry(entry);
              continue;
            }
            if (entry.containment.terminate()) killed += 1;
            if (!entryHasMembers(entry)) releaseEntry(entry);
          } catch {
            // Leave the handle open. Process exit still runs KILL_ON_JOB_CLOSE.
          }
        }
        return killed;
      }
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
      const table = (input.table ?? createProcessTableSnapshot(input.env ?? process.env))();
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
  /** Start time, epoch ms rounded down to the second; NaN when ps gave one that cannot be read. */
  readonly startedAt: number;
}

/**
 * Whether a registered group whose leader may still run is that group, from outside the Console (R-proof): the process
 * holding the leader's pid must have started within the start-time margin of the group's spawn. A different start time
 * means the number now names another process. A group whose leader is gone falls back to `proveExitedLeaderGroup`.
 */
export function proveOwnedGroup(rows: readonly ProcessGroupRow[], group: OwnedProcessGroup, now: number): boolean {
  if (!isSignallableGroup(group.pgid)) return false;
  const leader = rows.find((row) => row.pid === group.pgid);
  if (!leader) return proveExitedLeaderGroup(rows, group, now);
  if (leader.pgid !== group.pgid) return false;
  return Math.abs(leader.startedAt - Math.floor(group.spawnedAt / 1_000) * 1_000) <= PROCESS_START_MARGIN_MS;
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

/** One row of `ps -A -o pid=,ppid=,pgid=,lstart=`: enough to prove a group and to walk descendants. */
export interface ProcessTableRow extends ProcessGroupRow, ProcessTreeRow {}

export type ProcessTable = { readonly rows: readonly ProcessTableRow[] } | { readonly error: unknown };

/** Reads the process table on its first call, within PROCESS_TABLE_TIMEOUT_MS, and answers every later call with that read. */
export type ProcessTableSnapshot = () => ProcessTable;

/**
 * One process-table read, shared. The stop deadline's steps each need the table; reading it once keeps the deadline within
 * one PROCESS_TABLE_TIMEOUT_MS of its own budget, which the external escalation margin is sized for. Synchronous, so a
 * direct child cannot be reaped (and its pid reused) between the read and a signal in the same turn.
 */
export function createProcessTableSnapshot(env: NodeJS.ProcessEnv): ProcessTableSnapshot {
  let table: ProcessTable | null = null;
  return () => (table ??= readProcessTable(env));
}

/** A fresh process-table read within PROCESS_TABLE_TIMEOUT_MS, or why it could not be read. */
export function readProcessTable(env: NodeJS.ProcessEnv): ProcessTable {
  const listing = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,lstart="], {
    env: { PATH: env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PROCESS_TABLE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (listing.error || listing.status !== 0 || typeof listing.stdout !== "string") {
    return { error: listing.error ?? new Error(`ps exited with ${listing.status ?? listing.signal}`) };
  }
  return { rows: parseProcessTable(listing.stdout, listing.pid) };
}

/**
 * The same read without blocking the event loop, for a path that judges only groups whose leader is already reaped: no
 * direct child can be reaped, and its number reused, between this read and a signal, so it need not be synchronous.
 */
export function readProcessTableAsync(env: NodeJS.ProcessEnv): Promise<ProcessTable> {
  return new Promise((resolve) => {
    const child = execFile("ps", ["-A", "-o", "pid=,ppid=,pgid=,lstart="], {
      env: { PATH: env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
      encoding: "utf8",
      timeout: PROCESS_TABLE_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) resolve({ error });
      else resolve({ rows: parseProcessTable(stdout, child.pid) });
    });
  });
}

function parseProcessTable(stdout: string, readerPid: number | undefined): ProcessTableRow[] {
  const rows: ProcessTableRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*\S)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    // ps itself was this process's child and is already reaped; its pid must not be judged or signalled.
    if (pid === readerPid) continue;
    // A start time that cannot be read proves nothing: NaN fails every start-time comparison.
    rows.push({ pid, ppid: Number(match[2]), pgid: Number(match[3]), startedAt: parsePsLstartUtc(match[4]!) ?? Number.NaN });
  }
  return rows;
}

/**
 * Signals a child this process spawned as a group leader together with everything it started, under the registry's proof
 * rule: only while the child itself is unreaped, when its pid, and so its group number, cannot name anything else (E1).
 * Once it has been reaped nothing is signalled; whatever its group still holds is left to the stop deadline and the
 * watcher, which prove it from the process table. On Windows, without process groups, it signals the child alone.
 */
export function signalChildGroup(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): boolean {
  if (process.platform === "win32") return child.kill(signal);
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return false;
  if (!isSignallableGroup(child.pid)) return false;
  return signalGroup(child.pid, signal);
}

/** Never this process's own group (a Desktop sidecar shares Desktop's), and never a group number ≤ 1. */
export function isSignallableGroup(pgid: number): boolean {
  return Number.isSafeInteger(pgid) && pgid > 1 && pgid !== process.pid;
}

export function signalGroup(pgid: number, signal: NodeJS.Signals = "SIGKILL"): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Only ESRCH means the group is empty. */
export function groupHasMembers(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code !== "ESRCH";
  }
}

/** One row of `ps -A -o pid=,ppid=,pgid=`: enough to walk a process's descendants and their process groups. */
export interface ProcessTreeRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
}

/**
 * The fallback the stop deadline runs after the owned groups: descendants of `rootPid` that stay in its process group,
 * deepest first. Those are children no one registered (a plugin's tool, a git or ripgrep call, a stdio MCP transport) that
 * would otherwise outlive the Console. A child that leads a group of its own is either registered (the registry ended
 * it) or handed off on purpose (the detached update worker, a PTY session), so it and everything under it are left alone.
 * The group itself is never signalled as a whole: a Desktop sidecar shares Desktop's. Without a row for `rootPid`
 * nothing is selected.
 */
export function selectSameGroupDescendants(rows: readonly ProcessTreeRow[], rootPid: number, excludePids: readonly number[] = []): number[] {
  const root = rows.find((row) => row.pid === rootPid);
  if (!root) return [];
  const children = new Map<number, ProcessTreeRow[]>();
  for (const row of rows) {
    if (row.pid === row.ppid) continue;
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row);
    else children.set(row.ppid, [row]);
  }
  const excluded = new Set(excludePids);
  const seen = new Set<number>([rootPid]);
  const selected: Array<{ readonly pid: number; readonly depth: number }> = [];
  const visit = (pid: number, depth: number) => {
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid) || child.pgid !== root.pgid) continue;
      seen.add(child.pid);
      if (!excluded.has(child.pid)) selected.push({ pid: child.pid, depth });
      visit(child.pid, depth + 1);
    }
  };
  visit(rootPid, 1);
  return selected.sort((left, right) => right.depth - left.depth).map((entry) => entry.pid);
}

/**
 * SIGKILLs this process's unregistered descendants that stay in its process group (see selectSameGroupDescendants) and
 * returns how many were signalled. POSIX only. Without a readable process table nothing is signalled — an orphan is
 * better than a signal to an unrelated process. Synchronous, so a direct child cannot be reaped (and its pid reused)
 * between the snapshot and its SIGKILL.
 */
export function killSameGroupDescendants(input: OwnedProcessKillInput = {}): number {
  if (process.platform === "win32") return 0;
  const table = (input.table ?? createProcessTableSnapshot(input.env ?? process.env))();
  if ("error" in table) {
    input.onProcessTableUnavailable?.(table.error);
    return 0;
  }
  let killed = 0;
  for (const pid of selectSameGroupDescendants(table.rows, process.pid)) {
    try {
      process.kill(pid, "SIGKILL");
      killed += 1;
    } catch {
      // Already gone.
    }
  }
  return killed;
}
