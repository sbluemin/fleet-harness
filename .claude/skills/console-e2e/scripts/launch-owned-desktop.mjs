#!/usr/bin/env node
/**
 * Launch gate for an owned dev Desktop. Re-runs desktop-preflight.mjs and does not
 * start the command after `--` when that preflight exits 20. The preflight's own
 * flags, exit codes, and output are unchanged; this script only adds the gate.
 *
 *   node launch-owned-desktop.mjs <worktree> \
 *     --console-dir <dir> --cdp-port <n> --inspector-port <n> [--json] \
 *     -- <launch command...>
 *   node launch-owned-desktop.mjs <worktree> \
 *     --console-dir <dir> --cdp-port <n> --inspector-port <n> [--json] --dry-run
 *
 * --dry-run runs the preflight, prints whether a launch would start, and exits
 * with the preflight's code. It takes no launch command and never spawns one.
 * Without --dry-run, a preflight exit of 0 or 10 is followed by the launch
 * command, and this process's exit code is then the command's. Exit 20 always
 * means the preflight blocked and nothing was spawned.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const preflight = fileURLToPath(new URL('./desktop-preflight.mjs', import.meta.url));

function parse(argv) {
  const split = argv.indexOf('--');
  const args = split === -1 ? argv : argv.slice(0, split);
  const command = split === -1 ? [] : argv.slice(split + 1);
  const [worktree, ...rest] = args;
  if (!worktree || worktree.startsWith('--')) throw new Error('a worktree path is required');
  const opts = { worktree, command, json: false, dryRun: false };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--json' && !opts.json) { opts.json = true; continue; }
    if (flag === '--dry-run' && !opts.dryRun) { opts.dryRun = true; continue; }
    if (!['--console-dir', '--cdp-port', '--inspector-port'].includes(flag) || opts[flag]) {
      throw new Error(`unknown or repeated argument: ${flag}`);
    }
    const value = rest[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    opts[flag] = value;
  }
  if (!opts['--console-dir'] || !opts['--cdp-port'] || !opts['--inspector-port']) {
    throw new Error('--console-dir, --cdp-port, and --inspector-port are required');
  }
  if (opts.dryRun && command.length) throw new Error('--dry-run does not take a launch command');
  if (!opts.dryRun && !command.length) throw new Error('a launch command after -- is required without --dry-run');
  if (command.some((part) => part === '')) throw new Error('the launch command has an empty argument');
  return opts;
}

function preflightArgs(opts) {
  return [
    preflight,
    opts.worktree,
    '--console-dir', opts['--console-dir'],
    '--cdp-port', opts['--cdp-port'],
    '--inspector-port', opts['--inspector-port'],
    ...(opts.json ? ['--json'] : []),
  ];
}

function main() {
  const opts = parse(process.argv.slice(2));
  const checked = spawnSync(process.execPath, preflightArgs(opts), { stdio: 'inherit' });
  if (checked.error) throw checked.error;
  const code = checked.status;
  if (code !== 0 && code !== 10) {
    console.error('launch: refused (preflight exit 20); Electron was not started');
    process.exitCode = 20;
    return;
  }
  if (opts.dryRun) {
    console.error(`launch: not started (dry-run); preflight exit ${code}`);
    process.exitCode = code;
    return;
  }
  console.error(`launch: preflight exit ${code}; starting the command after --`);
  const child = spawnSync(opts.command[0], opts.command.slice(1), { stdio: 'inherit' });
  if (child.error) throw child.error;
  process.exitCode = child.status === null ? 1 : child.status;
}

try {
  main();
} catch (error) {
  console.error(`launch: refused (${error.message}); Electron was not started`);
  process.exitCode = 20;
}
