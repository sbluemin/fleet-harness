import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import type { Socket } from "node:net";

import type { OwnedProcessGroup } from "./owned-processes.js";
import type { ReaperMessage } from "./reaper.js";

export interface ConsoleReaperInput {
  /** The built reaper script (`console-reaper.mjs` beside the Console's own bundle). */
  readonly script: string;
  readonly execPath?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly instance: { readonly consolePid: number; readonly lockFile: string; readonly lockStartedAt: number };
  /** The groups registered so far, sent again to a reaper that replaces one that ended. */
  readonly groups: () => readonly OwnedProcessGroup[];
  /** The reaper could not be started or kept running; containment falls back to the Console's own deadline. */
  readonly onDegraded?: (error: unknown) => void;
}

export interface ConsoleReaperLink {
  registered(group: OwnedProcessGroup): void;
  leaderExited(group: OwnedProcessGroup): void;
  removed(pgid: number): void;
}

/** A reaper that ends while its Console runs is replaced once; a second loss leaves the Console degraded. */
const REAPER_RESTARTS = 1;

/**
 * Starts the per-Console reaper and keeps it informed. Only the lock owner calls this, right after taking the lock and
 * before it starts any owned child. The reaper runs in a session of its own (it outlives the Console by design and is not
 * one of the groups the Console ends) and never keeps the Console's event loop alive: the Console's death is what closes
 * its pipe.
 */
export function startConsoleReaper(input: ConsoleReaperInput): ConsoleReaperLink {
  let child: ChildProcess | null = null;
  let restarts = 0;
  let degraded = false;

  const degrade = (error: unknown): void => {
    if (degraded) return;
    degraded = true;
    child = null;
    input.onDegraded?.(error);
  };

  const send = (message: ReaperMessage): void => {
    const stdin = child?.stdin;
    if (!stdin || stdin.destroyed) return;
    try {
      stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // The exit handler below replaces the reaper and sends everything again.
    }
  };

  const launch = (): void => {
    if (!fs.existsSync(input.script)) {
      degrade(new Error(`reaper script missing: ${input.script}`));
      return;
    }
    let spawned: ChildProcess;
    try {
      spawned = spawn(input.execPath ?? process.execPath, [input.script], {
        detached: true,
        env: input.env,
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
    } catch (error) {
      degrade(error);
      return;
    }
    child = spawned;
    spawned.unref();
    (spawned.stdin as (NodeJS.WritableStream & Partial<Pick<Socket, "unref">>) | null)?.unref?.();
    spawned.stdin?.on("error", () => { /* The exit handler decides. */ });
    spawned.once("error", (error) => {
      if (child === spawned) degrade(error);
    });
    spawned.once("exit", (code, signal) => {
      if (child !== spawned) return;
      if (restarts >= REAPER_RESTARTS) {
        degrade(new Error(`reaper exited (${code ?? signal}) and was not restarted again`));
        return;
      }
      restarts += 1;
      launch();
    });
    send({ hello: input.instance });
    for (const group of input.groups()) {
      send({ add: group });
      if (group.leaderExitedAt !== null) send({ leaderExited: { pgid: group.pgid, at: group.leaderExitedAt } });
    }
  };

  launch();
  return {
    registered: (group) => send({ add: group }),
    leaderExited: (group) => send({ leaderExited: { pgid: group.pgid, at: group.leaderExitedAt ?? Date.now() } }),
    removed: (pgid) => send({ remove: { pgid } }),
  };
}
