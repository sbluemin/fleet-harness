#!/usr/bin/env node
/**
 * Stop an owned development Desktop, deciding which process to signal in code.
 *
 * The macOS dev launcher hands the bundle to `open -W -n`, which lets launchd adopt it. The Electron
 * main is therefore reparented to init while the launching shell still holds only `pnpm` and `open`,
 * so signalling what you started reports success while the app and its Console child keep running and
 * the next launch collides with them. The owned main is the process whose parent is init and whose
 * executable path lies under the target worktree, and the stop counts only once that process set, the
 * Console lock's PID, and the CDP listener are all gone.
 *
 *   node stop-owned-desktop.mjs <worktree> [--console-dir <dir>] [--cdp-port <n>] [--dry-run] [--force]
 *
 * The user's own Desktop runs from the main checkout, so that target is refused outright.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 20_000;

/**
 * Pick the Desktop processes this worktree owns out of a process table.
 *
 * Kept pure so the selection rule can be checked without launching an app: choosing wrong means
 * stopping somebody else's Desktop, and that rule deserves verification by arithmetic rather than by
 * a live signal.
 *
 * @param {string} psOutput output of `ps -eo pid,ppid,command`
 * @param {string} worktree absolute path
 */
export function selectOwnedDesktop(psOutput, worktree) {
  const needle = path.join(worktree, 'runtime', 'fleet-desktop');
  const rows = [];
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, command] = match;
    if (!command.includes(needle)) continue;
    rows.push({ pid: Number(pid), ppid: Number(ppid), command });
  }
  // The app main is reparented to init; helpers and the `open` wrapper are not.
  const mains = rows.filter((row) => row.ppid === 1);
  const mainPids = new Set(mains.map((row) => row.pid));
  return { mains, helpers: rows.filter((row) => !mainPids.has(row.pid)), all: rows };
}

function ps() {
  return execFileSync('ps', ['-eo', 'pid,ppid,command'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function mainCheckoutOf(worktree) {
  // The first porcelain entry is the main checkout.
  const out = execFileSync('git', ['-C', worktree, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  const first = /^worktree (.+)$/m.exec(out);
  return first ? realpathSync(first[1]) : null;
}

function lockPid(consoleDir) {
  if (!consoleDir) return null;
  const lockPath = path.join(consoleDir, 'console.lock');
  if (!existsSync(lockPath)) return null;
  try {
    const pid = JSON.parse(readFileSync(lockPath, 'utf8')).pid;
    return typeof pid === 'number' ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cdpAnswers(port) {
  if (!port) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const [rawWorktree, ...rest] = process.argv.slice(2);
  if (!rawWorktree) {
    console.error('usage: stop-owned-desktop.mjs <worktree> [--console-dir <dir>] [--cdp-port <n>] [--dry-run] [--force]');
    return 2;
  }
  const flag = (name) => {
    const index = rest.indexOf(name);
    return index === -1 ? null : rest[index + 1] ?? null;
  };
  const dryRun = rest.includes('--dry-run');
  const force = rest.includes('--force');
  const consoleDir = flag('--console-dir');
  const cdpPort = flag('--cdp-port');

  const worktree = realpathSync(rawWorktree);
  const mainCheckout = mainCheckoutOf(worktree);
  if (mainCheckout && mainCheckout === worktree) {
    console.error(`refused: ${worktree} is the main checkout — the user's own Desktop runs there`);
    return 3;
  }

  const found = selectOwnedDesktop(ps(), worktree);
  const watchedLockPid = lockPid(consoleDir);

  console.log(`worktree     ${worktree}`);
  console.log(`main pids    ${found.mains.map((row) => row.pid).join(', ') || '(none)'}`);
  console.log(`helper pids  ${found.helpers.map((row) => row.pid).join(', ') || '(none)'}`);
  console.log(`console lock ${watchedLockPid ?? '(none)'}`);
  console.log(`cdp port     ${cdpPort ?? '(not checked)'}`);

  if (dryRun) {
    console.log('dry-run: nothing signalled');
    return 0;
  }
  if (found.mains.length === 0) {
    console.log('no owned Desktop main process found');
  }

  for (const row of found.mains) {
    try {
      process.kill(row.pid, 'SIGTERM');
    } catch {
      // A process that is already gone is the goal state.
    }
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const remaining = selectOwnedDesktop(ps(), worktree).all.map((row) => row.pid);
    const lockStanding = watchedLockPid !== null && alive(watchedLockPid);
    const cdpStanding = await cdpAnswers(cdpPort);
    if (remaining.length === 0 && !lockStanding && !cdpStanding) {
      console.log('stopped: no owned process, console child, or CDP listener remains');
      return 0;
    }
    if (Date.now() > deadline) {
      if (force) {
        for (const pid of remaining) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // ignore
          }
        }
        console.error(`timed out; SIGKILL sent to ${remaining.join(', ') || '(none)'} — re-run to verify`);
        return 4;
      }
      console.error(`timed out after ${POLL_TIMEOUT_MS}ms — still standing: pids=${remaining.join(', ') || 'none'} lock=${lockStanding} cdp=${cdpStanding}`);
      return 4;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error?.message ?? error);
      process.exit(1);
    },
  );
}
