#!/usr/bin/env node
/**
 * Read-only macOS check to run before asking for Desktop launch authorization. It reports the
 * current capture chain and launch conflicts without writing files, sending signals, requesting
 * permission, or connecting to or binding any port.
 *
 *   node desktop-preflight.mjs <worktree> --console-dir <dir> --cdp-port <n> --inspector-port <n> [--json]
 *
 * Exit codes: 0 = OS pixel lane candidate, 10 = pixels unavailable or unconfirmed but inspector lane
 * candidate, 20 = launch blocked (owned process, lock, or port conflict, or a failed check).
 * A candidate is neither launch nor focus authorization and does not guarantee a capture.
 * CoreGraphics cannot query an arbitrary PID's permission: the helper reports the same chain's
 * osascript probe and the ancestor executables and .app paths, and speaks for no other tool or host.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { homedir, userInfo } from 'node:os';
import { mainCheckoutOf, selectOwnedDesktop } from './stop-owned-desktop.mjs';

function exec(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
}

function canonicalPath(value) {
  let ancestor = path.resolve(value);
  const suffix = [];
  for (;;) {
    try { return path.join(realpathSync(ancestor), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT' || ancestor === path.dirname(ancestor)) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
}

function assertIsolatedConsole(consoleDir) {
  const target = canonicalPath(consoleDir);
  const roots = [
    path.join(homedir(), '.fleet'),
    path.join(userInfo().homedir, '.fleet'),
    process.env.FLEET_DATA_DIR,
    process.env.FLEET_CONSOLE_DATA_DIR,
  ].filter(Boolean);
  for (const root of roots) {
    const protectedRoot = canonicalPath(root);
    const relative = path.relative(protectedRoot, target);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('--console-dir is inside the user\'s or an inherited Fleet data root; refusing');
    }
  }
}

function options(args) {
  const [rawWorktree, ...rest] = args;
  if (!rawWorktree || rawWorktree.startsWith('--')) throw new Error('a worktree path is required');
  const result = { worktree: realpathSync(rawWorktree) };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--json' && !result.json) { result.json = true; continue; }
    if (!['--console-dir', '--cdp-port', '--inspector-port'].includes(flag) || result[flag]) {
      throw new Error(`unknown or repeated argument: ${flag}`);
    }
    const value = rest[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    result[flag] = value;
  }
  if (!path.isAbsolute(result['--console-dir'] ?? '')) throw new Error('--console-dir must be an absolute path');
  assertIsolatedConsole(result['--console-dir']);
  for (const flag of ['--cdp-port', '--inspector-port']) {
    const value = result[flag];
    if (!/^\d+$/.test(value ?? '') || Number(value) < 1 || Number(value) > 65535) {
      throw new Error(`${flag}: expected a port in 1–65535`);
    }
    result[flag] = Number(value);
  }
  if (result['--cdp-port'] === result['--inspector-port']) throw new Error('the CDP and inspector ports must differ');
  const top = realpathSync(exec('git', ['-C', result.worktree, 'rev-parse', '--show-toplevel']).trim());
  if (top !== result.worktree) throw new Error('pass the worktree root');
  if (mainCheckoutOf(result.worktree) === result.worktree) throw new Error('the main checkout belongs to the user\'s Desktop; refusing');
  return result;
}

function processTable() {
  return exec('/bin/ps', ['-eo', 'pid,ppid,comm']).split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), executable: match[3] }] : [];
  });
}

function ancestors(rows) {
  const chain = [];
  let pid = process.pid;
  while (pid && !chain.some((row) => row.pid === pid)) {
    const row = rows.find((candidate) => candidate.pid === pid);
    if (!row) break;
    chain.push({ ...row, appBundle: /^(.*?\.app)(?:\/|$)/.exec(row.executable)?.[1] ?? null });
    pid = row.ppid;
  }
  return chain;
}

function screenProbe() {
  if (process.platform !== 'darwin') return { screenLocked: null, screenRecording: null, error: 'macOS-only probe' };
  try {
    // JXA calls the system functions directly, so no Swift compile cache or temporary source is written.
    return JSON.parse(exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `
      ObjC.import('Foundation');
      ObjC.import('CoreGraphics');
      ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
      const session = ObjC.deepUnwrap($.CGSessionCopyCurrentDictionary());
      const pid = Number($.NSProcessInfo.processInfo.processIdentifier);
      let responsiblePid = null;
      let responsibilityError = null;
      try {
        ObjC.bindFunction('responsibility_get_pid_responsible_for_pid', ['int', ['int']]);
        const result = Number($.responsibility_get_pid_responsible_for_pid(pid));
        if (result > 0) responsiblePid = result;
        else responsibilityError = 'invalid responsible PID result';
      } catch (error) { responsibilityError = String(error); }
      JSON.stringify({
        pid, responsiblePid, responsibilityError,
        screenLocked: session ? Boolean(session.CGSSessionScreenIsLocked) : null,
        screenRecording: Boolean($.CGPreflightScreenCaptureAccess())
      });
    `]));
  } catch (error) {
    return { screenLocked: null, screenRecording: null, error: error.message };
  }
}

function listeners(port) {
  const result = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcn'], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !(result.status === 1 && !result.stdout && !result.stderr)) {
    throw new Error(`port ${port} check failed: ${result.stderr || result.status}`);
  }
  const found = [];
  let owner = {};
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('p')) owner = { pid: Number(line.slice(1)) };
    if (line.startsWith('c')) owner.executable = line.slice(1);
    if (line.startsWith('n')) {
      const address = line.slice(1);
      found.push({ ...owner, address, loopback: /^(127\.\d+\.\d+\.\d+|\[::1\]):/.test(address) });
    }
  }
  return { port, listeners: found };
}

function consoleLock(consoleDir, rows) {
  const lockPath = path.join(consoleDir, 'console.lock');
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { path: lockPath, state: 'absent' };
    return { path: lockPath, state: 'unknown', error: 'lock unreadable' };
  }
  if (!Number.isSafeInteger(lock?.pid) || lock.pid < 1) return { path: lockPath, state: 'unknown', error: 'lock PID missing or invalid' };
  // Not even kill(pid, 0): any live PID blocks the launch regardless of ownership.
  return { path: lockPath, pid: lock.pid, state: rows.some((row) => row.pid === lock.pid) ? 'live' : 'stale' };
}

function main() {
  const opts = options(process.argv.slice(2));
  const rows = processTable();
  const chain = ancestors(rows);
  const found = selectOwnedDesktop(exec('/bin/ps', ['-eo', 'pid,ppid,command']), opts.worktree);
  const summarize = (row) => ({ pid: row.pid, ppid: row.ppid, executable: rows.find((p) => p.pid === row.pid)?.executable ?? null });
  const ownedDesktop = { mains: found.mains.map(summarize), helpers: found.helpers.map(summarize) };
  const ports = { cdp: listeners(opts['--cdp-port']), inspector: listeners(opts['--inspector-port']) };
  const lock = consoleLock(opts['--console-dir'], rows);
  const screen = screenProbe();
  // The private libsystem SPI's responsible process can differ from the ppid ancestors; a failed diagnosis never changes the lane.
  const responsibleProcess = rows.find((row) => row.pid === screen.responsiblePid);
  const responsibility = {
    diagnosticOnly: true,
    source: 'responsibility_get_pid_responsible_for_pid (private SPI)',
    pid: screen.responsiblePid ?? null,
    executable: responsibleProcess?.executable ?? null,
    error: screen.responsibilityError ?? (responsibleProcess ? null : 'responsible process not found'),
  };
  const blockers = [];
  if (found.all.length) blockers.push('Desktop processes of the target worktree are still running');
  if (lock.state === 'live' || lock.state === 'unknown') blockers.push(`Console lock: ${lock.state}`);
  for (const [name, port] of Object.entries(ports)) {
    if (port.listeners.length) blockers.push(`${name} port ${port.port} in use`);
  }
  if (process.platform !== 'darwin') blockers.push('ownership and listener checks are macOS-only');
  const pixelReasons = [];
  if (screen.screenLocked !== false) pixelReasons.push(screen.screenLocked ? 'screen locked' : 'screen lock unknown');
  if (screen.screenRecording !== true) pixelReasons.push(screen.screenRecording === false ? 'no Screen Recording in this probe chain' : 'Screen Recording unknown');
  const exitCode = blockers.length ? 20 : pixelReasons.length ? 10 : 0;
  const report = {
    worktree: opts.worktree, observedAt: new Date().toISOString(), lane: exitCode === 20 ? 'blocked' : exitCode === 10 ? 'inspector' : 'os-pixels',
    exitCode, blockers, pixelReasons, screen: { ...screen, probeExecutable: '/usr/bin/osascript', parentPid: process.pid },
    captureContext: 'Run this in the session and host that will capture. Per-ancestor permissions are not queried. Recheck when the chain changes.',
    ancestors: chain, responsibility, ownedDesktop, consoleLock: lock, ports,
  };
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`worktree: ${report.worktree}\nlane: ${report.lane} (exit ${exitCode})`);
    console.log(`screen locked: ${screen.screenLocked} / Screen Recording: ${screen.screenRecording} (probe PID ${screen.pid ?? '?'})`);
    console.log(`pixel limits: ${pixelReasons.join('; ') || 'none'}\nlaunch blockers: ${blockers.join('; ') || 'none'}`);
    console.log(`Desktop main PID: ${ownedDesktop.mains.map((p) => p.pid).join(', ') || 'none'} / helper PID: ${ownedDesktop.helpers.map((p) => p.pid).join(', ') || 'none'}`);
    console.log(`Console lock: ${lock.state} / PID ${lock.pid ?? 'none'} / ${lock.path}`);
    for (const [name, port] of Object.entries(ports)) console.log(`${name} ${port.port}: ${JSON.stringify(port.listeners)}`);
    console.log(`capture chain: ${JSON.stringify(chain)}\n${report.captureContext}`);
    console.log(`responsible process (diagnostic only): ${JSON.stringify(responsibility)}`);
    if (screen.error) console.log(`probe error: ${screen.error}`);
  }
  return exitCode;
}

try {
  process.exitCode = main();
} catch (error) {
  const report = { lane: 'blocked', exitCode: 20, blockers: [error.message] };
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.error(`launch blocked: ${error.message}\nexit code: 20`);
  process.exitCode = 20;
}
