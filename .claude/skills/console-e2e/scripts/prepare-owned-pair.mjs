#!/usr/bin/env node
/**
 * Prepare or remove one owned home Console and one owned remote-role Console.
 * Composes isolated-env.mjs, issue-access-link.mjs, and add-remote-host.mjs.
 * Does not join, launch Desktop, or pass --canonical-console-dir.
 *
 *   node prepare-owned-pair.mjs prepare --worktree <abs> --home <abs> --remote <abs>
 *   node prepare-owned-pair.mjs stop --worktree <abs> --home <abs> --remote <abs>
 *
 * prepare stdout is one JSON line
 * {homePort,remotePort,listenerOrigin,register,evidence}.
 * evidence "remote-host-register" is add-remote-host's helper result, not an
 * on-screen host, a certificate result, or /api/v1/local-consoles discovery.
 * Never prints link.txt or a lock token.
 *
 * stop deletes a directory only when pair-created and owner match this caller
 * and the lock is not live. A missing owner is allowed only when this run
 * created the directory and never started a live Console.
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function fail(message) {
  const error = new Error(message);
  error.pairFailure = true;
  throw error;
}

function callerHash() {
  const id = process.env.FLEET_CONSOLE_WORKSPACE_SESSION_ID
    ? `fleet:${process.env.FLEET_CONSOLE_WORKSPACE_SESSION_ID}`
    : process.env.CLAUDE_CODE_SESSION_ID
      ? `claude:${process.env.CLAUDE_CODE_SESSION_ID}`
      : '';
  if (!id) fail('refusing to prepare or remove a run without a session id');
  return createHash('sha256').update(id).digest('hex').slice(0, 16);
}

function readTrim(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (error) {
    return error.code === 'ENOENT' ? null : '';
  }
}

function lockPortPid(file) {
  try {
    const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
    const port = Number(lock?.port);
    const pid = Number(lock?.pid);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null;
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { port, pid };
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function userConsolePorts() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const ports = new Set();
  for (const file of [
    path.join(os.tmpdir(), `fleet-console-${uid}-stable`, 'console.lock'),
    path.join(os.homedir(), '.fleet', 'console', 'console.lock'),
  ]) {
    const lock = lockPortPid(file);
    if (lock) ports.add(lock.port);
  }
  return ports;
}

function userFleetReal() {
  const homeFleet = path.join(os.homedir(), '.fleet');
  try {
    if (fs.existsSync(homeFleet)) return fs.realpathSync(homeFleet);
  } catch {
    // Compare the unresolved path below.
  }
  return homeFleet;
}

function underUserFleet(real) {
  const root = userFleetReal();
  return real === root || real.startsWith(root + path.sep);
}

function assertE2eDir(dir) {
  if (!dir || !path.isAbsolute(dir)) fail('home and remote must be absolute <repo>/.fleet/e2e-<id> paths');
  const parent = path.dirname(dir);
  const base = path.basename(dir);
  if (path.basename(parent) !== '.fleet' || !/^e2e-[A-Za-z0-9._-]+$/.test(base)) {
    fail('path must be <repo>/.fleet/e2e-<id>');
  }
  let parentReal;
  try {
    parentReal = fs.realpathSync(parent);
  } catch {
    fail('parent .fleet is not readable');
  }
  const real = path.join(parentReal, base);
  if (underUserFleet(real) || underUserFleet(parentReal)) fail('refusing a path under the user ~/.fleet');
  return real;
}

function assertWorktree(dir) {
  if (!dir || !path.isAbsolute(dir)) fail('--worktree must be an absolute path');
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    fail('worktree is not readable');
  }
  if (underUserFleet(real)) fail('refusing a worktree under the user ~/.fleet');
  const scripts = {
    real,
    cli: path.join(real, 'runtime/fleet-console/dist/cli.mjs'),
    fake: path.join(real, '.claude/skills/console-e2e/scripts/fake-claude.mjs'),
    isolated: path.join(real, '.claude/skills/console-e2e/scripts/isolated-env.mjs'),
    issue: path.join(real, '.claude/skills/console-e2e/scripts/issue-access-link.mjs'),
    add: path.join(real, '.claude/skills/console-e2e/scripts/add-remote-host.mjs'),
  };
  for (const file of [scripts.cli, scripts.fake, scripts.isolated, scripts.issue, scripts.add]) {
    if (!fs.existsSync(file)) fail(`missing ${path.basename(file)} under the worktree`);
  }
  return scripts;
}

function parseArgs(argv) {
  const mode = argv[0];
  if (mode !== 'prepare' && mode !== 'stop') {
    fail('usage: node prepare-owned-pair.mjs prepare|stop --worktree <abs> --home <abs> --remote <abs>');
  }
  const opts = {};
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!value) fail(`${flag} needs a value`);
    if (flag === '--worktree') opts.worktree = value;
    else if (flag === '--home') opts.home = value;
    else if (flag === '--remote') opts.remote = value;
    else fail(`unknown flag ${JSON.stringify(flag)}`);
  }
  if (!opts.worktree || !opts.home || !opts.remote) fail('prepare and stop need --worktree, --home, and --remote');
  const scripts = assertWorktree(opts.worktree);
  const home = assertE2eDir(opts.home);
  const remote = assertE2eDir(opts.remote);
  if (home === remote) fail('home and remote must be different directories');
  return { mode, scripts, home, remote };
}

function redact(text) {
  return String(text)
    .replace(/fleet:\/\/\S+/g, 'fleet://…')
    .replace(/Bearer\s+\S+/gi, 'Bearer …')
    .slice(0, 300);
}

function runNode(scripts, args, envExtra = {}, timeout = 60_000) {
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    cwd: scripts.real,
    env: { ...process.env, ...envExtra },
    timeout,
  });
}

function checkPlan(scripts, runDir) {
  const fakeDir = path.join(runDir, 'fake-claude');
  const res = runNode(scripts, [
    scripts.isolated, '--run-dir', runDir,
    '--set', `CLAUDE_BIN=${scripts.fake}`,
    '--set', `FAKE_CLAUDE_DIR=${fakeDir}`,
    '--check',
  ], {}, 30_000);
  if (res.status !== 0) fail(redact(res.stderr || 'isolated-env --check refused'));
}

function lanAddress() {
  if (process.platform !== 'darwin') fail('no LAN address: this helper uses the macOS default-route lookup');
  const route = spawnSync('route', ['-n', 'get', 'default'], { encoding: 'utf8' });
  const iface = route.status === 0
    ? route.stdout.split('\n').map((line) => line.trim()).find((line) => line.startsWith('interface:'))?.split(/\s+/)[1]
    : '';
  if (!iface || !/^[A-Za-z0-9]+$/.test(iface)) fail('no LAN address');
  const addr = spawnSync('ipconfig', ['getifaddr', iface], { encoding: 'utf8' });
  const bind = addr.status === 0 ? addr.stdout.trim() : '';
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(bind)) fail('no LAN address');
  return bind;
}

function startServe(scripts, runDir) {
  const logFd = fs.openSync(path.join(runDir, 'serve.log'), 'a', 0o600);
  const child = spawn(process.execPath, [
    scripts.isolated, '--run-dir', runDir,
    '--set', `CLAUDE_BIN=${scripts.fake}`,
    '--set', `FAKE_CLAUDE_DIR=${path.join(runDir, 'fake-claude')}`,
    '--', process.execPath, scripts.cli, 'serve',
  ], {
    cwd: scripts.real,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });
  child.unref();
  fs.closeSync(logFd);
  if (!child.pid) fail('isolated-env serve did not start');
  fs.writeFileSync(path.join(runDir, 'pair-serve.pid'), `${child.pid}\n`, { mode: 0o600 });
  return child.pid;
}

function commandOf(pid) {
  const res = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : '';
}

async function waitLock(runDir) {
  const file = path.join(runDir, 'console', 'console.lock');
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const lock = lockPortPid(file);
    if (lock && alive(lock.pid)) {
      if (userConsolePorts().has(lock.port)) fail('refusing the user Console');
      return lock;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(`console.lock not readable yet for ${path.basename(runDir)}`);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stopOne(scripts, runDir) {
  if (!fs.existsSync(runDir)) fail(`refusing to stop ${path.basename(runDir)}: directory is absent`);
  let real;
  try {
    real = fs.realpathSync(runDir);
  } catch {
    fail(`refusing to stop ${path.basename(runDir)}: directory is not readable`);
  }
  if (real !== runDir || underUserFleet(real)) fail(`refusing to stop ${path.basename(runDir)}`);
  const caller = callerHash();
  const created = readTrim(path.join(runDir, 'pair-created'));
  const owner = readTrim(path.join(runDir, 'owner'));
  if (created !== caller) fail(`refusing to stop ${path.basename(runDir)}: this run did not create it`);
  if (owner && owner !== caller) fail(`refusing to stop ${path.basename(runDir)}: owner is another session`);
  const lockFile = path.join(runDir, 'console', 'console.lock');
  const before = lockPortPid(lockFile);
  if (before && userConsolePorts().has(before.port)) fail('refusing the user Console');
  let stopStatus = null;
  if (before || owner) {
    const res = runNode(scripts, [
      scripts.isolated, '--run-dir', runDir, '--', process.execPath, scripts.cli, 'stop',
    ], {}, 60_000);
    stopStatus = res.status;
  }
  const wrapperPid = Number(readTrim(path.join(runDir, 'pair-serve.pid')));
  if (Number.isInteger(wrapperPid) && wrapperPid > 0 && alive(wrapperPid)) {
    const cmd = commandOf(wrapperPid);
    if (cmd.includes('isolated-env.mjs') && cmd.includes(runDir)) {
      try { process.kill(wrapperPid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const lock = lockPortPid(lockFile);
    const wrapperLive = Number.isInteger(wrapperPid) && wrapperPid > 0 && alive(wrapperPid);
    if ((!lock || !alive(lock.pid)) && !wrapperLive) break;
    sleepSync(200);
  }
  const after = lockPortPid(lockFile);
  if (after && alive(after.pid)) fail(`lock still live for ${path.basename(runDir)}; not deleting`);
  if (Number.isInteger(wrapperPid) && wrapperPid > 0 && alive(wrapperPid) && commandOf(wrapperPid).includes(runDir)) {
    fail(`serve still running for ${path.basename(runDir)}; not deleting`);
  }
  if (readTrim(path.join(runDir, 'pair-created')) !== caller) fail(`refusing to delete ${path.basename(runDir)}`);
  const ownerNow = readTrim(path.join(runDir, 'owner'));
  if (ownerNow && ownerNow !== caller) fail(`refusing to delete ${path.basename(runDir)}: owner is another session`);
  fs.rmSync(runDir, { recursive: true });
  return { stop: stopStatus, removed: true };
}

function createRun(runDir) {
  if (fs.existsSync(runDir)) fail(`${path.basename(runDir)} already exists; choose another id`);
  fs.mkdirSync(runDir, { mode: 0o700 });
  try {
    fs.writeFileSync(path.join(runDir, 'pair-created'), `${callerHash()}\n`, { flag: 'wx', mode: 0o600 });
  } catch {
    fail(`${path.basename(runDir)} lost its create record; not continuing`);
  }
}

async function prepare(scripts, home, remote) {
  checkPlan(scripts, home);
  checkPlan(scripts, remote);
  const bind = lanAddress();
  const created = [];
  try {
    createRun(home);
    created.push(home);
    createRun(remote);
    created.push(remote);
    startServe(scripts, home);
    startServe(scripts, remote);
    const homeLock = await waitLock(home);
    const remoteLock = await waitLock(remote);
    const issued = runNode(scripts, [scripts.issue, remote, 'full'], { BIND: bind }, 60_000);
    if (issued.status !== 0) fail(redact(issued.stderr || 'issue-access-link refused'));
    const listenerOrigin = issued.stdout.match(/\(listener (https:\/\/[^)\s]+)\)/)?.[1] ?? null;
    if (!listenerOrigin) fail('listener origin missing');
    const registered = runNode(scripts, [scripts.add, remote, `http://127.0.0.1:${homeLock.port}`], {}, 60_000);
    let register;
    try {
      register = JSON.parse(registered.stdout);
    } catch {
      fail(redact(registered.stderr || 'add-remote-host returned no JSON'));
    }
    if (registered.status !== 0 || typeof register.status !== 'number' || register.status < 200 || register.status >= 300) {
      fail(`add-remote-host status ${register.status ?? registered.status}`);
    }
    process.stdout.write(`${JSON.stringify({
      homePort: homeLock.port,
      remotePort: remoteLock.port,
      listenerOrigin,
      register,
      evidence: 'remote-host-register',
    })}\n`);
  } catch (error) {
    for (const dir of created) {
      try { stopOne(scripts, dir); } catch (stopError) {
        process.stderr.write(`prepare-owned-pair: cleanup ${path.basename(dir)}: ${stopError.message}\n`);
      }
    }
    throw error;
  }
}

try {
  const { mode, scripts, home, remote } = parseArgs(process.argv.slice(2));
  if (mode === 'stop') {
    const homeResult = stopOne(scripts, home);
    const remoteResult = stopOne(scripts, remote);
    process.stdout.write(`${JSON.stringify({ home: homeResult, remote: remoteResult })}\n`);
  } else {
    await prepare(scripts, home, remote);
  }
} catch (error) {
  const text = error?.pairFailure ? error.message : (error?.stack || String(error));
  process.stderr.write(`prepare-owned-pair: ${text}\n`);
  process.exit(1);
}
