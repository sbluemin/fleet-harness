#!/usr/bin/env node
/**
 * Launch gate for an owned dev Desktop. Re-runs desktop-preflight.mjs and does not
 * start the command after `--` when that preflight exits 20. The preflight's own
 * flags, exit codes, and output are unchanged. The command must use env -i with
 * FLEET_CONSOLE_DATA_DIR matching --console-dir. TMPDIR is forced to its sibling
 * tmp directory so local discovery cannot scan the user's stable Console slot.
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
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
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

function isolatedLaunch(opts) {
  const [envCommand, clear, ...args] = opts.command;
  if (!['env', '/usr/bin/env'].includes(envCommand) || clear !== '-i') {
    throw new Error('the launch command must start with env -i (references/desktop/setup.md)');
  }
  const consoleDir = path.resolve(opts['--console-dir']);
  const runDir = path.dirname(consoleDir);
  const tmpDir = path.join(runDir, 'tmp');
  const assignments = [];
  while (args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])) assignments.push(args.shift());
  if (!args.length) throw new Error('env -i needs a launch executable');
  const values = (name) => assignments.filter((entry) => entry.startsWith(`${name}=`)).map((entry) => entry.slice(name.length + 1));
  if (values('FLEET_CONSOLE_DATA_DIR').length !== 1 || values('FLEET_CONSOLE_DATA_DIR')[0] !== consoleDir) {
    throw new Error('FLEET_CONSOLE_DATA_DIR must equal --console-dir');
  }
  if (values('TMPDIR').some((value) => value !== tmpDir)) throw new Error('TMPDIR must be <owned-run>/tmp');
  const check = spawnSync(process.execPath, [
    fileURLToPath(new URL('./isolated-env.mjs', import.meta.url)), '--run-dir', runDir, '--check',
  ], { encoding: 'utf8' });
  if (check.status !== 0) throw new Error('owned run directory check failed; run isolated-env.mjs --check for details');
  if (existsSync(tmpDir) && realpathSync(tmpDir) !== path.join(realpathSync(runDir), 'tmp')) {
    throw new Error('TMPDIR must not resolve outside the owned run');
  }
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  return [envCommand, '-i', ...assignments.filter((entry) => !entry.startsWith('TMPDIR=')), `TMPDIR=${tmpDir}`, ...args];
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
  const command = isolatedLaunch(opts);
  console.error(`launch: preflight exit ${code}; starting the command after -- with owned TMPDIR`);
  const child = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
  if (child.error) throw child.error;
  process.exitCode = child.status === null ? 1 : child.status;
}

try {
  main();
} catch (error) {
  console.error(`launch: refused (${error.message}); Electron was not started`);
  process.exitCode = 20;
}
