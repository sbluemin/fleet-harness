#!/usr/bin/env node
/**
 * Start an owned dev Desktop into one pre-claimed run's empty Console lock, so the
 * product can show its lock-recovery dialog. This is not a flag on desktop-preflight.mjs
 * or launch-owned-desktop.mjs. Those still refuse this lock with exit 20.
 *
 *   node launch-owned-lock-dialog.mjs <worktree> --run-dir <abs-run> --record-sentinel
 *   node launch-owned-lock-dialog.mjs <worktree> \
 *     --run-dir <abs-run> --cdp-port <n> --inspector-port <n> [--json] [--dry-run] \
 *     -- <env -i command...>
 *
 * The console directory is always <run-dir>/console. --record-sentinel starts the
 * owned sentinel and writes <run-dir>/owned-process.json. It does not create, delete,
 * or rewrite console.lock, and it does not signal a process it did not just spawn.
 * A launch (including --dry-run) starts nothing unless the proofs in references/desktop/native-and-package.md hold.
 */

import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callerHash } from './isolated-env.mjs';
import { isolatedLaunch } from './launch-owned-desktop.mjs';

const SENTINEL_EVAL = 'setInterval(()=>{},1e9)';
const SENTINEL_FLAG = '--owned-lock-sentinel';
const PS_ENV = { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' };

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function refuse(message) {
  console.error(`lock-dialog: refused (${message}); Electron was not started`);
  process.exitCode = 20;
}

function parse(argv) {
  const split = argv.indexOf('--');
  const args = split === -1 ? argv : argv.slice(0, split);
  const command = split === -1 ? [] : argv.slice(split + 1);
  const [worktree, ...rest] = args;
  if (!worktree || worktree.startsWith('--')) throw new Error('a worktree path is required');
  const opts = { worktree, command, json: false, dryRun: false, record: false };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--json' && !opts.json) { opts.json = true; continue; }
    if (flag === '--dry-run' && !opts.dryRun) { opts.dryRun = true; continue; }
    if (flag === '--record-sentinel' && !opts.record) { opts.record = true; continue; }
    if (!['--run-dir', '--cdp-port', '--inspector-port'].includes(flag) || opts[flag]) {
      throw new Error(`unknown or repeated argument: ${flag}`);
    }
    const value = rest[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    opts[flag] = value;
  }
  if (!path.isAbsolute(opts['--run-dir'] ?? '')) throw new Error('--run-dir must be an absolute path');
  if (/\s/.test(opts['--run-dir'])) throw new Error('--run-dir must not contain whitespace');
  opts.runDir = path.resolve(opts['--run-dir']);
  opts.consoleDir = path.join(opts.runDir, 'console');
  opts.lockPath = path.join(opts.consoleDir, 'console.lock');
  opts.ownerPath = path.join(opts.runDir, 'owner');
  opts.recordPath = path.join(opts.runDir, 'owned-process.json');
  if (opts.record) {
    if (opts.dryRun || opts.json || command.length || opts['--cdp-port'] || opts['--inspector-port']) {
      throw new Error('--record-sentinel takes only the worktree and --run-dir');
    }
    return opts;
  }
  if (!opts['--cdp-port'] || !opts['--inspector-port']) throw new Error('--cdp-port and --inspector-port are required');
  if (opts.dryRun && command.length) throw new Error('--dry-run does not take a launch command');
  if (!opts.dryRun && !command.length) throw new Error('a launch command after -- is required without --dry-run');
  if (command.some((part) => part === '')) throw new Error('the launch command has an empty argument');
  return opts;
}

function regularOwned(file, label) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${label} is missing`);
    throw new Error(`${label} is unreadable`);
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} is a symbolic link`);
  if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} is owned by uid ${stat.uid}`);
  }
  return stat;
}

function assertEmptyLock(opts) {
  const dir = lstatSync(opts.consoleDir);
  if (dir.isSymbolicLink() || !dir.isDirectory()) throw new Error('console directory is not a real directory');
  if (typeof process.getuid === 'function' && dir.uid !== process.getuid()) {
    throw new Error(`console directory is owned by uid ${dir.uid}`);
  }
  if ((dir.mode & 0o777) !== 0o700) throw new Error(`console directory mode is ${(dir.mode & 0o777).toString(8)}, expected 700`);
  const lock = regularOwned(opts.lockPath, 'console.lock');
  if (lock.size !== 0) throw new Error(`console.lock is ${lock.size} bytes, expected 0`);
  if ((lock.mode & 0o777) !== 0o600) throw new Error(`console.lock mode is ${(lock.mode & 0o777).toString(8)}, expected 600`);
  if (!(lock.birthtimeMs > 0) || !(regularOwned(opts.ownerPath, 'owner').birthtimeMs > 0)) {
    throw new Error('owner or console.lock has no birth time');
  }
  const owner = regularOwned(opts.ownerPath, 'owner');
  if (readFileSync(opts.ownerPath, 'utf8').trim() !== callerHash()) {
    throw new Error('this --run-dir owner is not the current caller');
  }
  // isolated-env claims only while the lock is absent or a dead pid. A 0-byte lock is unreadable,
  // so that claim cannot happen after this file exists. Birth time is the file evidence of that order.
  if (!(owner.birthtimeMs < lock.birthtimeMs)) {
    throw new Error('owner was not created before console.lock; claim the run before creating the empty lock, and do not replace either file');
  }
  let update;
  try {
    update = lstatSync(path.join(opts.consoleDir, 'update-progress.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('update-progress.json is unreadable');
  }
  if (update) throw new Error('update-progress.json is already present; add it only after the recovery dialog is visible');
  return { lock, owner };
}

function unusedPort(avoid) {
  for (let port = 45021; port < 45221; port += 1) {
    if (port === avoid) continue;
    const result = spawnSync('/usr/sbin/lsof', ['-w', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8', timeout: 10_000,
    });
    if (result.status === 1 && !result.stdout && !result.stderr) return port;
  }
  throw new Error('no free loopback port to prove the preflight');
}

function assertPreflight(opts) {
  const preflight = fileURLToPath(new URL('./desktop-preflight.mjs', import.meta.url));
  const cdp = opts['--cdp-port'] ?? String(unusedPort());
  const inspector = opts['--inspector-port'] ?? String(unusedPort(Number(cdp)));
  const result = spawnSync(process.execPath, [
    preflight, opts.worktree, '--console-dir', opts.consoleDir,
    '--cdp-port', cdp, '--inspector-port', inspector, '--json',
  ], { encoding: 'utf8' });
  if (result.error) throw result.error;
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error('desktop-preflight did not return JSON');
  }
  const blockers = Array.isArray(report.blockers) ? report.blockers : [];
  if (result.status !== 20 || blockers.length !== 1 || blockers[0] !== 'Console lock: unknown') {
    throw new Error(`desktop-preflight exit ${result.status ?? 'none'} blockers ${JSON.stringify(blockers)}`);
  }
  return report;
}

function assertRunCheck(opts) {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./isolated-env.mjs', import.meta.url)), '--run-dir', opts.runDir, '--check',
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('owned run directory check failed; run isolated-env.mjs --check for details');
}

function expectedTokens() {
  return [realpathSync(process.execPath), '-e', SENTINEL_EVAL, '--', SENTINEL_FLAG];
}

function psArgs(pid) {
  const result = spawnSync('/bin/ps', ['-ww', '-o', 'args=', '-p', String(pid)], {
    encoding: 'utf8', timeout: 10_000, env: PS_ENV,
  });
  if (result.status !== 0) return null;
  const line = result.stdout.trim();
  return line ? line.split(/\s+/) : null;
}

function psLstart(pid) {
  const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8', timeout: 10_000, env: PS_ENV,
  });
  if (result.status !== 0) return null;
  const line = result.stdout.trim();
  return line || null;
}

function executablePaths(pid) {
  const result = spawnSync('/usr/sbin/lsof', ['-w', '-a', '-p', String(pid), '-d', 'txt', '-Fn'], {
    encoding: 'utf8', timeout: 10_000,
  });
  if (result.status !== 0 && !result.stdout) return [];
  return result.stdout.split('\n').flatMap((line) => (line.startsWith('n') ? [line.slice(1)] : []));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function liveSentinel(opts, pid) {
  const expected = [...expectedTokens(), opts.runDir];
  const tokens = psArgs(pid);
  if (!tokens || tokens.length !== expected.length) return null;
  let executable;
  try {
    executable = realpathSync(tokens[0]);
  } catch {
    return null;
  }
  if (executable !== expected[0] || tokens.slice(1).join('\0') !== expected.slice(1).join('\0')) return null;
  const texts = executablePaths(pid).map((file) => {
    try { return realpathSync(file); } catch { return file; }
  });
  if (!texts.includes(expected[0])) return null;
  const startedAt = psLstart(pid);
  if (!startedAt) return null;
  return { pid, executable: expected[0], args: expected.slice(1), startedAt };
}

function readRecord(opts) {
  const stat = regularOwned(opts.recordPath, 'owned-process.json');
  if ((stat.mode & 0o777) !== 0o600) throw new Error('owned-process.json mode must be 600');
  let body;
  try {
    body = JSON.parse(readFileSync(opts.recordPath, 'utf8'));
  } catch {
    throw new Error('owned-process.json is not the sentinel record');
  }
  const expectedArgs = [...expectedTokens().slice(1), opts.runDir];
  const args = Array.isArray(body.args) ? body.args : [];
  if (body.executable !== expectedTokens()[0] || args.join('\0') !== expectedArgs.join('\0')) {
    throw new Error('owned-process.json is not this run\'s sentinel');
  }
  if (!Number.isSafeInteger(body.pid) || body.pid <= 0 || typeof body.startedAt !== 'string' || body.startedAt.length === 0) {
    throw new Error('owned-process.json has no sentinel pid or start identity');
  }
  return body;
}

function assertSentinel(opts) {
  const body = readRecord(opts);
  if (!pidAlive(body.pid)) throw new Error(`sentinel pid ${body.pid} is not running`);
  const live = liveSentinel(opts, body.pid);
  if (!live || live.startedAt !== body.startedAt) {
    throw new Error(`pid ${body.pid} is not the recorded sentinel (executable, arguments, and start identity must all match)`);
  }
  return live;
}

function recordSentinel(opts) {
  assertRunCheck(opts);
  assertEmptyLock(opts);
  assertPreflight(opts);
  try {
    const existing = readRecord(opts);
    if (pidAlive(existing.pid) && liveSentinel(opts, existing.pid)?.startedAt === existing.startedAt) {
      console.error(`lock-dialog: sentinel already recorded pid ${existing.pid}; lock left untouched`);
      return;
    }
    if (pidAlive(existing.pid)) throw new Error(`pid ${existing.pid} is alive but is not the recorded sentinel; it was left running`);
  } catch (error) {
    if (error.message !== 'owned-process.json is missing') throw error;
  }
  const executable = expectedTokens()[0];
  const args = [...expectedTokens().slice(1), opts.runDir];
  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    env: { PATH: '/usr/bin:/bin', HOME: path.join(opts.runDir, 'home'), TMPDIR: path.join(opts.runDir, 'tmp') },
  });
  const pid = child.pid;
  if (!pid) {
    child.kill('SIGTERM');
    throw new Error('sentinel did not start');
  }
  let live = null;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !live) live = liveSentinel(opts, pid);
  if (!live) {
    child.kill('SIGTERM');
    throw new Error('sentinel identity could not be read; the new process was signalled and nothing was recorded');
  }
  writeFileSync(opts.recordPath, `${JSON.stringify({ pid: live.pid, executable: live.executable, args: live.args, startedAt: live.startedAt })}\n`, { mode: 0o600 });
  child.unref();
  console.error(`lock-dialog: sentinel recorded pid ${live.pid}; lock left untouched`);
}

function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.record) {
    recordSentinel(opts);
    return;
  }
  assertRunCheck(opts);
  const fixture = assertEmptyLock(opts);
  assertPreflight(opts);
  const sentinel = assertSentinel(opts);
  const launchOpts = {
    worktree: opts.worktree,
    command: opts.command,
    '--console-dir': opts.consoleDir,
    '--cdp-port': opts['--cdp-port'],
    '--inspector-port': opts['--inspector-port'],
  };
  const command = opts.dryRun ? null : isolatedLaunch(launchOpts);
  const again = lstatSync(opts.lockPath);
  if (again.ino !== fixture.lock.ino || again.size !== 0 || again.birthtimeMs !== fixture.lock.birthtimeMs) {
    throw new Error('console.lock changed while it was being checked');
  }
  if (opts.json) {
    console.log(JSON.stringify({
      fixture: 'empty', bytes: 0, sentinelPid: sentinel.pid, startedAt: sentinel.startedAt, dryRun: opts.dryRun,
    }));
  }
  if (opts.dryRun) {
    console.error(`lock-dialog: not started (dry-run); fixture empty; sentinel pid ${sentinel.pid}`);
    return;
  }
  console.error(`lock-dialog: fixture empty; sentinel pid ${sentinel.pid}; starting the command after --`);
  const child = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
  if (child.error) throw child.error;
  process.exitCode = child.status === null ? 1 : child.status;
}

if (invokedDirectly()) {
  try {
    main();
  } catch (error) {
    refuse(error.message);
  }
}
