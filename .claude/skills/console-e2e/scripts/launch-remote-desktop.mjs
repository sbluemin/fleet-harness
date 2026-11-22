#!/usr/bin/env node
/**
 * Launch one host-built Desktop package on a remote Mac over SSH and hold it
 * in the foreground with a loopback-only CDP tunnel.
 *
 *   FLEET_E2E_SSH_TARGET=<ssh-host-alias|user@host> \
 *   node launch-remote-desktop.mjs <worktree> \
 *     --package <abs.zip> --package-sha256 <64hex> --package-revision <rev> \
 *     --run-id <id> --local-port <n> --remote-port <n> [--dry-run] [--json]
 *
 * This tool is remote-only: a missing or invalid FLEET_E2E_SSH_TARGET fails
 * (exit 20) and never falls back to a local launch. Whether to run local or
 * remote is decided by the shared entrypoint, not here.
 *
 * Lifetime: after printing one READY JSON line to stdout, the process stays in
 * the foreground holding the SSH tunnel. While it runs, CDP is usable at
 * http://127.0.0.1:<local-port>/ on this host. It reclaims only the resources
 * this run owns (the remote app PID started here, the tunnel child, and the
 * verified remote run directory) when the remote app exits, the tunnel drops,
 * or this process gets SIGTERM/SIGINT. It never touches another run, another
 * PID, or the remote user's real home: every remote path is derived from one
 * verified `<home>/.fleet/e2e-remote-<run-id>` directory.
 *
 * Safety rules (no exceptions):
 * - The SSH target is the single value of FLEET_E2E_SSH_TARGET. It must be an
 *   SSH Host alias or user@host (`^([user]@)?host$`, `[A-Za-z0-9._-]`);
 *   anything else fails before any connection is opened.
 * - CDP is loopback-only on both ends: the forward is
 *   `-L 127.0.0.1:<local>:127.0.0.1:<remote>` and the remote listener address
 *   is verified with lsof before the tunnel is trusted.
 * - A local port that already answers is a conflict (exit 20): this tool does
 *   not issue any CDP command to it and never attaches to an existing target.
 * - The package input is explicit (`--package` + `--package-sha256`); there is
 *   no public-download fallback, so a substituted public build cannot slip in.
 *   The sha256 is verified on the host and again on the remote side.
 * - FLEET_E2E_SSH_TARGET grants no OS input permission. This tool sends no
 *   input anywhere; host input protection paths are untouched (no file under
 *   the worktree outside this script changes host behavior).
 * - No waiting on other runs, no lock files, no snapshots: an existing remote
 *   run directory or an occupied port fails immediately.
 * - stdout carries only the READY line; it never contains the SSH target, key
 *   material, tokens, or absolute remote home paths.
 *
 * Preconditions on the remote Mac: the SSH user has a logged-in GUI session
 * (an Electron app needs its WindowServer), `unzip`, `shasum` (or `sha256sum`),
 * `lsof`, and `python3` (only if the caller uses the documented port probe;
 * this script probes the remote port with python3 when available).
 *
 * Exit codes: 0 reclaimed after normal remote exit or SIGTERM; 130 SIGINT;
 * 1 runtime failure after reclaim was attempted; 20 pre-launch refusal or a
 * failed reclaim check (nothing outside the owned directory was touched).
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, realpathSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const SSH_ENV = 'FLEET_E2E_SSH_TARGET';
const TARGET_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9_][A-Za-z0-9._-]{0,253}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const REVISION_RE = /^[A-Za-z0-9._+-]{1,128}$/;
const REMOTE_BASENAME = (runId) => `e2e-remote-${runId}`;
const CDP_READY_TIMEOUT_MS = 60_000;
const CDP_POLL_MS = 500;

function fail(code, message) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

/** POSIX-shell single-quote an arbitrary string for the remote command line. */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function resolveSshTarget(raw) {
  const target = String(raw ?? '').trim();
  if (!target) fail(20, `${SSH_ENV} is not set; this remote-only tool refuses without it (no local fallback)`);
  if (target.length > 300 || !TARGET_RE.test(target) || target.startsWith('-')) {
    fail(20, `${SSH_ENV} must be an SSH Host alias or user@host ([A-Za-z0-9._-], optional user@); refusing to connect`);
  }
  return target;
}

export function parsePort(raw, name) {
  if (!/^\d+$/.test(String(raw ?? ''))) fail(20, `${name} must be a port in 1-65535`);
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail(20, `${name} must be a port in 1-65535`);
  return port;
}

export function parseArgs(argv) {
  const [rawWorktree, ...rest] = argv;
  if (!rawWorktree || rawWorktree.startsWith('--')) fail(20, 'a worktree path is required');
  const opts = { rawWorktree, dryRun: false, json: false };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--dry-run' && !opts.dryRun) { opts.dryRun = true; continue; }
    if (flag === '--json' && !opts.json) { opts.json = true; continue; }
    if (!['--package', '--package-sha256', '--package-revision', '--run-id', '--local-port', '--remote-port'].includes(flag)) {
      fail(20, `unknown or repeated argument: ${flag}`);
    }
    if (opts[flag] !== undefined) fail(20, `unknown or repeated argument: ${flag}`);
    const value = rest[++i];
    if (!value || value.startsWith('--')) fail(20, `${flag} needs a value`);
    opts[flag] = value;
  }
  for (const flag of ['--package', '--package-sha256', '--package-revision', '--run-id', '--local-port', '--remote-port']) {
    if (opts[flag] === undefined) fail(20, `${flag} is required`);
  }
  if (!SHA256_RE.test(opts['--package-sha256'])) fail(20, '--package-sha256 must be 64 lowercase hex');
  if (!REVISION_RE.test(opts['--package-revision'])) fail(20, '--package-revision must be 1-128 chars of [A-Za-z0-9._+-]');
  if (!RUN_ID_RE.test(opts['--run-id'])) fail(20, '--run-id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}');
  opts.localPort = parsePort(opts['--local-port'], '--local-port');
  opts.remotePort = parsePort(opts['--remote-port'], '--remote-port');
  if (!path.isAbsolute(opts['--package'])) fail(20, '--package must be an absolute path');
  if (path.extname(opts['--package']).toLowerCase() !== '.zip') fail(20, '--package must be a .zip archive (single-format contract)');
  return opts;
}

export function checkWorktree(rawWorktree) {
  let worktree;
  try {
    worktree = realpathSync(rawWorktree);
  } catch {
    fail(20, 'the worktree is not readable');
  }
  return worktree;
}

/** The exact owned remote directory; the only remote path this tool may remove. */
export function ownedRemoteDir(home, runId) {
  if (!home.startsWith('/') || home.includes('\n') || home === '/') fail(20, 'remote HOME is not usable');
  return `${home}/.fleet/${REMOTE_BASENAME(runId)}`;
}

export function assertOwnedRemoteDir(home, runId, candidate) {
  if (candidate !== ownedRemoteDir(home, runId)) fail(20, 'refusing to act on a remote path outside the owned run directory');
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** True when something already answers on 127.0.0.1:port. Connects only; no CDP traffic. */
export function localPortOccupied(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(1500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const SSH_BASE = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new'];

async function ssh(target, remoteCommand, { timeout = 30_000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('ssh', [...SSH_BASE, target, remoteCommand], { timeout, maxBuffer: 4 * 1024 * 1024 });
    return { stdout, stderr };
  } catch (error) {
    error.sshFailure = true;
    throw error;
  }
}

async function fetchJson(url, timeoutMs = 2000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function consoleTargetFromList(list) {
  if (!Array.isArray(list)) return null;
  for (const target of list) {
    try {
      const parsed = new URL(target.url);
      if (parsed.pathname.startsWith('/console/')) return target;
    } catch {
      // Not a URL (e.g. chrome-internal target); keep looking.
    }
  }
  return null;
}

function urlPathOnly(raw) {
  try {
    const parsed = new URL(raw);
    return parsed.pathname || '/';
  } catch {
    return '(unparseable)';
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const worktree = checkWorktree(opts.rawWorktree);
  const target = resolveSshTarget(process.env[SSH_ENV]);
  const runId = opts['--run-id'];
  const log = (message) => process.stderr.write(`launch-remote-desktop: ${message}\n`);

  const pkg = opts['--package'];
  if (!existsSync(pkg) || !lstatSync(pkg).isFile()) fail(20, '--package does not exist or is not a file');
  const localDigest = await sha256File(pkg);
  if (localDigest !== opts['--package-sha256']) {
    fail(20, '--package sha256 mismatch: the archive is not the verified build; refusing (no public substitute)');
  }
  if (await localPortOccupied(opts.localPort)) {
    fail(20, `local port ${opts.localPort} is already in use; refusing to attach to the existing target`);
  }

  if (opts.dryRun) {
    log(`dry-run ok; target from ${SSH_ENV} (value withheld); run=${runId} local-port=${opts.localPort} remote-port=${opts.remotePort}`);
    return 0;
  }

  // ---- remote plan ---------------------------------------------------------
  let home;
  try {
    home = (await ssh(target, 'printf %s "$HOME"')).stdout;
  } catch {
    fail(20, 'cannot reach the SSH target (check the Host alias or user@host, key, and network); refusing');
  }
  const remoteDir = ownedRemoteDir(home, runId);
  const q = shQuote(remoteDir);
  const run = async (command, label, code = 20) => {
    try {
      return await ssh(target, command, { timeout: 120_000 });
    } catch (error) {
      fail(code, `${label} failed: ${String(error.stderr || error.message).split('\n')[0]}`);
    }
  };

  // No adoption: an existing directory means another (maybe live) run owns the name.
  try {
    await execFileAsync('ssh', [...SSH_BASE, target, `test ! -e ${q}`], { timeout: 30_000 });
  } catch {
    fail(20, `remote ${REMOTE_BASENAME(runId)} already exists; refusing to adopt or replace it`);
  }
  // Remote loopback port must be free before anything listens on it.
  try {
    await execFileAsync('ssh', [...SSH_BASE, target,
      `python3 -c ${shQuote(`import socket,sys;s=socket.socket();s.settimeout(2);sys.exit(0 if s.connect_ex(("127.0.0.1",${opts.remotePort}))!=0 else 1)`)}`],
    { timeout: 30_000 });
  } catch (error) {
    if (error.code === 1) fail(20, `remote port ${opts.remotePort} is already in use; refusing to share it`);
    fail(20, `remote port check failed: ${String(error.stderr || error.message).split('\n')[0]}`);
  }

  let createdDir = false;
  let remotePid = null;
  let tunnel = null;
  const state = { reclaimed: false };

  const reclaim = async (reason) => {
    if (state.reclaimed) return { removed: false, reason };
    state.reclaimed = true;
    const summary = { reason, appStopped: null, tunnelStopped: null, dirRemoved: null };
    if (remotePid !== null) {
      try {
        assertOwnedRemoteDir(home, runId, remoteDir);
        // Kill only the PID whose command line proves it runs from the owned directory.
        const { stdout: psOut } = await ssh(target, `ps -p ${remotePid} -o command= || true`).catch(() => ({ stdout: '' }));
        if (psOut.includes(remoteDir)) {
          await ssh(target, `kill ${remotePid} 2>/dev/null || true`);
          for (let i = 0; i < 10; i++) {
            const { stdout } = await ssh(target, `ps -p ${remotePid} -o pid= || true`).catch(() => ({ stdout: '' }));
            if (!stdout.trim()) break;
            await new Promise((r) => setTimeout(r, 500));
          }
          const { stdout: still } = await ssh(target, `ps -p ${remotePid} -o pid= || true`).catch(() => ({ stdout: '' }));
          if (still.trim()) await ssh(target, `kill -9 ${remotePid} 2>/dev/null || true`);
          summary.appStopped = true;
        } else {
          summary.appStopped = 'refused_not_owned';
        }
      } catch {
        summary.appStopped = false;
      }
      remotePid = null;
    }
    if (tunnel !== null) {
      try {
        tunnel.kill('SIGTERM');
        summary.tunnelStopped = true;
      } catch {
        summary.tunnelStopped = false;
      }
      tunnel = null;
    }
    if (createdDir) {
      try {
        assertOwnedRemoteDir(home, runId, remoteDir);
        await ssh(target, `test ! -L ${q} && rm -rf -- ${q} && test ! -e ${q}`).catch(() => null);
        const gone = await execFileAsync('ssh', [...SSH_BASE, target, `test ! -e ${q}`], { timeout: 30_000 })
          .then(() => true).catch(() => false);
        summary.dirRemoved = gone;
      } catch {
        summary.dirRemoved = false;
      }
    }
    process.stderr.write(`remote-reclaim: ${JSON.stringify(summary)}\n`);
    return summary;
  };
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      void reclaim(signal).then(() => process.exit(signal === 'SIGINT' ? 130 : 0));
    });
  }

  try {
    await run(`mkdir -p ${q}/home ${q}/tmp ${q}/console ${q}/desktop ${q}/fleet-data && chmod 700 ${q} ${q}/home`, 'create the owned remote run directory');
    createdDir = true;

    // Transfer the explicit host package; verify its digest on the remote side.
    try {
      await execFileAsync('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', pkg, `${target}:${remoteDir}/package.zip`],
        { timeout: 300_000 });
    } catch {
      fail(20, 'package transfer failed; refusing');
    }
    const { stdout: remoteDigestOut } = await run(
      `cd ${q} && (command -v shasum >/dev/null && shasum -a 256 package.zip || sha256sum package.zip)`,
      'verify the transferred archive',
    );
    if (!remoteDigestOut.startsWith(opts['--package-sha256'])) {
      fail(20, 'transferred archive digest mismatch on the remote side; refusing to run it');
    }
    const { stdout: appsOut } = await run(
      `cd ${q} && rm -rf app && mkdir app && unzip -q package.zip -d app && find app -maxdepth 3 -name '*.app' -type d -print`,
      'extract the transferred package',
    );
    const apps = appsOut.split('\n').map((line) => line.trim()).filter(Boolean);
    if (apps.length !== 1) fail(20, `expected exactly one .app in the package, found ${apps.length}; refusing`);
    const appPath = `${remoteDir}/${apps[0]}`;
    const { stdout: plist } = await run(`cat ${shQuote(`${appPath}/Contents/Info.plist`)}`, 'read the app identity');
    const bundleVersion = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
    const bundleExecutable = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
    if (!bundleExecutable || /[\s"'\\$`]/.test(bundleExecutable)) fail(20, 'app bundle executable is not usable; refusing');
    const executable = `${appPath}/Contents/MacOS/${bundleExecutable}`;

    // Per-run home and app state: nothing resolves to the remote user's real home.
    const appHome = `${remoteDir}/home`;
    const appEnv = [
      `HOME=${appHome}`,
      `TMPDIR=${remoteDir}/tmp`,
      'LANG=en_US.UTF-8',
      `FLEET_DATA_DIR=${remoteDir}/fleet-data`,
      `FLEET_CONSOLE_DATA_DIR=${remoteDir}/console`,
      `FLEET_DESKTOP_DATA_DIR=${remoteDir}/desktop`,
    ].map(shQuote).join(' ');
    const launchCommand = `env -i ${appEnv} /usr/bin/nohup ${shQuote(executable)} `
      + `--remote-debugging-port=${opts.remotePort} ${shQuote(`--user-data-dir=${remoteDir}/userData`)} `
      + `>${shQuote(`${remoteDir}/app.log`)} 2>&1 & echo $!`;
    const { stdout: pidOut } = await run(`mkdir -p ${shQuote(appHome)} ${shQuote(`${remoteDir}/userData`)} && ${launchCommand}`, 'launch the transferred app');
    remotePid = Number(pidOut.trim().split('\n').pop());
    if (!Number.isSafeInteger(remotePid) || remotePid <= 0) {
      remotePid = null;
      fail(1, 'remote launch did not report a PID; see the remote log after manual inspection (directory kept only if reclaim failed)');
    }
    // Ownership proof: the PID must run from the owned directory, and the CDP
    // listener must be loopback-only.
    const { stdout: cmdOut } = await run(`ps -p ${remotePid} -o command= || true`, 'confirm the owned app process', 1);
    if (!cmdOut.includes(remoteDir)) {
      fail(1, 'the remote PID does not run from the owned directory; refusing to adopt it');
    }
    const { stdout: listenOut } = await run(
      `/usr/sbin/lsof -nP -iTCP:${opts.remotePort} -sTCP:LISTEN -Fcn || lsof -nP -iTCP:${opts.remotePort} -sTCP:LISTEN -Fcn`,
      'confirm the loopback-only CDP listener',
      1,
    );
    const listeners = listenOut.split('\n').filter((line) => line.startsWith('n'));
    if (listeners.length === 0) fail(1, 'no remote CDP listener appeared; refusing');
    if (!listeners.every((line) => /^n(127\.\d+\.\d+\.\d+|\[::1\]):/.test(line))) {
      fail(1, 'the remote CDP listener is not loopback-only; refusing');
    }

    // Loopback-only tunnel held by this foreground process.
    const { spawn } = await import('node:child_process');
    tunnel = spawn('ssh', [...SSH_BASE,
      '-N',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-L', `127.0.0.1:${opts.localPort}:127.0.0.1:${opts.remotePort}`,
      target,
    ], { stdio: 'ignore' });
    const tunnelEarlyExit = new Promise((resolve) => tunnel.on('exit', (code) => resolve(code)));
    const early = await Promise.race([
      tunnelEarlyExit.then(() => 'exited'),
      new Promise((resolve) => setTimeout(() => resolve('held'), 3000)),
    ]);
    if (early === 'exited') fail(1, 'the SSH tunnel exited immediately (likely a forward failure); refusing');

    // Wait for OUR app's CDP through the tunnel (bounded; no waiting on other runs).
    const deadline = Date.now() + CDP_READY_TIMEOUT_MS;
    let version = null;
    let consoleTarget = null;
    for (;;) {
      try {
        version = await fetchJson(`http://127.0.0.1:${opts.localPort}/json/version`);
        const list = await fetchJson(`http://127.0.0.1:${opts.localPort}/json/list`);
        consoleTarget = consoleTargetFromList(list);
        if (consoleTarget) break;
      } catch {
        version = null;
        consoleTarget = null;
      }
      if (Date.now() > deadline) fail(1, 'no owned Console CDP target appeared through the tunnel in time');
      await new Promise((r) => setTimeout(r, CDP_POLL_MS));
    }

    const ready = {
      status: 'ready',
      runId,
      localPort: opts.localPort,
      remotePort: opts.remotePort,
      remoteDirName: REMOTE_BASENAME(runId),
      packageSha256: opts['--package-sha256'],
      packageRevision: opts['--package-revision'],
      appBundleVersion: bundleVersion,
      browser: version?.Browser ?? null,
      protocolVersion: version?.['Protocol-Version'] ?? null,
      consoleTarget: consoleTarget
        ? { id: consoleTarget.id ?? null, type: consoleTarget.type ?? null, urlPath: urlPathOnly(consoleTarget.url) }
        : null,
      worktree,
    };
    process.stdout.write(`${JSON.stringify(ready)}\n`);

    // Foreground hold: reclaim when the app goes, the tunnel drops, or we are signalled.
    const remoteGone = (async () => {
      for (;;) {
        const { stdout } = await ssh(target, `ps -p ${remotePid} -o pid= || true`, { timeout: 15_000 }).catch(() => ({ stdout: '?' }));
        if (!stdout.trim() || /^\s*$/.test(stdout)) return 'remote-exited';
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    const outcome = await Promise.race([remoteGone, tunnelEarlyExit.then(() => 'tunnel-dropped')]);
    if (outcome === 'tunnel-dropped') {
      await reclaim('tunnel-dropped');
      process.stderr.write('launch-remote-desktop: tunnel dropped; reclaimed and exiting 1\n');
      return 1;
    }
    await reclaim('remote-exited');
    log('remote app exited; reclaimed and exiting 0');
    return 0;
  } catch (error) {
    await reclaim(error.exitCode === 20 ? 'pre-launch-refusal' : 'failure');
    if (error.exitCode === 20) {
      process.stderr.write(`launch-remote-desktop: refused (${error.message}); Electron was not started\n`);
      return 20;
    }
    process.stderr.write(`launch-remote-desktop: failed (${error.message})\n`);
    return typeof error.exitCode === 'number' ? error.exitCode : 1;
  }
}

const invoked = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invoked) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`launch-remote-desktop: failed (${error?.message ?? error})\n`);
      process.exit(typeof error?.exitCode === 'number' ? error.exitCode : 1);
    },
  );
}
