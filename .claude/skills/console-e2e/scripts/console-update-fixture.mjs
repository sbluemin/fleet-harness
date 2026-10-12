#!/usr/bin/env node
/**
 * Local Release fixture for the Console in-place update (references/console-update-fixture.md).
 *
 *   prepare  --worktree <abs> --dir <run-dir>/update-fixture [--current-version X.Y.Z] [--target-version X.Y.Z]
 *            [--fail-install] [--delay-ms N]        (inside isolated-env.mjs, with --bin npm)
 *   serve    --dir <fixture-dir>                       (inside isolated-env.mjs, with --bin npm; the managed process)
 *   drive    --dir <fixture-dir> --run-dir <run-dir> [--timeout-ms N]   (plain-Node HTTP helper)
 *   stop     --dir <fixture-dir>                       (signals the recorded serve supervisor)
 *
 * prepare installs the worktree's built dist as a stable global npm package at the current version into an owned
 * prefix and publishes the same bytes as the target version: a validated release manifest and tarball. Only the
 * package.json differs (no `private`, the version, no dependencies; the external dependencies resolve through
 * <prefix>/node_modules, a link outside the npm-managed root to the worktree's node_modules).
 * serve starts that installed `cli.mjs serve` with NPM_CONFIG_PREFIX on the prefix and a Node preload that answers the
 * product's GitHub Release URLs from the fixture and refuses every other non-loopback fetch. It stays alive across the
 * update, so the wrapper's per-call PATH (npm, node) outlives the old Console for the update worker, and it records
 * lifecycle transitions in <dir>/lifecycle.jsonl. It never prints the lock token.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();

function fail(message) {
  process.stderr.write(`console-update-fixture: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith('--')) fail(`unexpected argument ${JSON.stringify(flag)}`);
    const name = flag.slice(2);
    if (name === 'fail-install') out[name] = true;
    else out[name] = argv[++i];
  }
  return out;
}

function requireAbs(name) {
  const value = opts[name];
  if (!value || !path.isAbsolute(value)) fail(`--${name} <absolute path> is required`);
  return path.resolve(value);
}

/** prepare and serve run npm and the host; both must run under isolated-env.mjs so npm's HOME, cache, and userconfig are owned. */
function requireWrapper() {
  const { HOME, FLEET_DATA_DIR, FLEET_CONSOLE_DATA_DIR } = process.env;
  if (!HOME || !FLEET_DATA_DIR || !FLEET_CONSOLE_DATA_DIR || path.dirname(FLEET_DATA_DIR) !== path.dirname(HOME)) {
    fail('run this mode through isolated-env.mjs --run-dir <run-dir> --bin npm (references/setup.md#keep-the-real-home-out)');
  }
  for (const key of Object.keys(process.env)) {
    if (key.toLowerCase().startsWith('npm_config_')) fail(`${key} is set; start from the wrapper, not from an npm or pnpm script`);
  }
}

function readFixture(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'fixture.json'), 'utf8'));
  } catch {
    return fail(`${dir}/fixture.json is missing; run prepare first`);
  }
}

function npmEnv(fixture, extra = {}) {
  return { ...process.env, NPM_CONFIG_PREFIX: fixture.prefix, NPM_CONFIG_UPDATE_NOTIFIER: 'false', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', ...extra };
}

function bumpPatch(version) {
  const parts = version.split('.').map(Number);
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

async function prepare() {
  requireWrapper();
  const worktree = requireAbs('worktree');
  const dir = requireAbs('dir');
  if (existsSync(dir) && readdirSync(dir).length > 0) fail(`${dir} is not empty; use a fresh fixture directory`);
  const consoleDir = path.join(worktree, 'runtime/fleet-console');
  for (const required of ['dist/cli.mjs', 'dist/lifecycle-worker-runtime.mjs', 'dist/client/index.html', 'node_modules']) {
    if (!existsSync(path.join(consoleDir, required))) fail(`${consoleDir}/${required} is missing; build the worktree's Console first`);
  }
  // The same parser and naming rules the updater uses (pure TS, loaded through Node's type stripping like the release packer).
  const release = await import(pathToFileURL(path.join(consoleDir, 'protocol/release/index.ts')).href);
  const { createPublishedFleetConsoleManifest } = await import(pathToFileURL(path.join(worktree, 'scripts/pack-fleet-console-manifest.mjs')).href);
  const sourcePkg = JSON.parse(readFileSync(path.join(consoleDir, 'package.json'), 'utf8'));
  const current = opts['current-version'] ?? sourcePkg.version;
  const target = opts['target-version'] ?? bumpPatch(current);
  for (const version of [current, target]) if (!release.isStableConsoleVersion(version)) fail(`${version} is not a stable X.Y.Z version`);
  if (!(target.localeCompare(current, undefined, { numeric: true }) > 0)) fail(`target ${target} must be newer than current ${current}`);
  const delayMs = Number(opts['delay-ms'] ?? 0);
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) fail('--delay-ms must be an integer from 0 to 60000');

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const prefix = path.join(dir, 'prefix');
  const releaseDir = path.join(dir, 'release');
  mkdirSync(prefix, { recursive: true });
  mkdirSync(releaseDir, { recursive: true });

  const stage = (version, failInstall) => {
    const root = path.join(dir, `stage-${version}`, 'package');
    mkdirSync(root, { recursive: true });
    for (const entry of sourcePkg.files ?? ['dist']) {
      const from = path.join(consoleDir, entry);
      if (existsSync(from)) cpSync(from, path.join(root, entry), { recursive: true });
    }
    // The published manifest rules (no `private`, so the installed Console reads channel=stable), then the fixture's
    // changes: its version, no registry dependencies, and on --fail-install a postinstall that fails the npm install.
    const pkg = createPublishedFleetConsoleManifest(sourcePkg);
    pkg.version = version;
    pkg.dependencies = {};
    if (failInstall) {
      writeFileSync(path.join(root, 'fixture-fail-install.mjs'), 'process.stderr.write("console-update-fixture: intentional install failure\\n");\nprocess.exit(41);\n');
      pkg.scripts = { postinstall: 'node fixture-fail-install.mjs' };
    }
    writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    return path.dirname(root);
  };
  const pack = (stageDir, tarballPath) => execFileSync('/usr/bin/tar', ['-czf', tarballPath, '-C', stageDir, 'package']);

  const currentTarball = path.join(dir, `current-${current}.tgz`);
  pack(stage(current, false), currentTarball);
  const tarballName = release.consoleTarballName(target);
  const targetTarball = path.join(releaseDir, tarballName);
  pack(stage(target, opts['fail-install'] === true), targetTarball);
  const bytes = readFileSync(targetTarball);
  const manifest = {
    schema: release.CONSOLE_RELEASE_SCHEMA_VERSION,
    package: release.CONSOLE_PACKAGE_NAME,
    version: target,
    tag: release.consoleReleaseTagForVersion(target),
    tarball: { name: tarballName, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    engines: { node: sourcePkg.engines.node },
  };
  const parsed = release.parseConsoleReleaseManifest(manifest);
  if (!parsed.ok) fail(`the fixture manifest is rejected by the release contract: ${parsed.reason}`);
  writeFileSync(path.join(releaseDir, release.CONSOLE_RELEASE_MANIFEST_ASSET), `${JSON.stringify(manifest, null, 2)}\n`);

  const fixture = {
    worktree,
    sourceSha: execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    currentVersion: current,
    targetVersion: target,
    failInstall: opts['fail-install'] === true,
    delayMs,
    prefix,
    globalRoot: path.join(prefix, 'lib/node_modules'),
    packageRoot: path.join(prefix, 'lib/node_modules', release.CONSOLE_PACKAGE_NAME),
    releaseDir,
    manifestAsset: release.CONSOLE_RELEASE_MANIFEST_ASSET,
    releaseRepository: release.CONSOLE_RELEASE_REPOSITORY,
    preload: path.join(dir, 'release-preload.mjs'),
    requestLog: path.join(dir, 'release-requests.jsonl'),
    lifecycleLog: path.join(dir, 'lifecycle.jsonl'),
    consoleDataDir: process.env.FLEET_CONSOLE_DATA_DIR,
  };
  writeFileSync(fixture.preload, preloadSource(fixture));
  writeFileSync(path.join(dir, 'fixture.json'), `${JSON.stringify(fixture, null, 2)}\n`);

  // Install the current version the way a user does: a real global npm install into the owned prefix.
  const install = spawnSync('npm', ['i', '-g', '--force', currentTarball], { env: npmEnv(fixture, { FLEET_CONSOLE_NO_AUTO_START: '1' }), encoding: 'utf8' });
  writeFileSync(path.join(dir, 'prepare-npm.log'), `${install.stdout ?? ''}${install.stderr ?? ''}`);
  if (install.status !== 0) fail(`npm i -g of the current version exited ${install.status ?? install.error?.code}; see ${dir}/prepare-npm.log`);
  // Outside the npm-managed root, so npm never sees it; Node's parent lookup reaches it from the installed package.
  symlinkSync(path.join(consoleDir, 'node_modules'), path.join(prefix, 'node_modules'), 'dir');
  const root = execFileSync('npm', ['root', '-g'], { env: npmEnv(fixture), encoding: 'utf8' }).trim();
  const installed = JSON.parse(readFileSync(path.join(fixture.packageRoot, 'package.json'), 'utf8'));
  if (root !== fixture.globalRoot || installed.version !== current || installed.private) {
    fail(`unexpected install: npm root -g=${root}, version=${installed.version}, private=${installed.private}`);
  }
  console.log(JSON.stringify({ prepared: true, current, target, failInstall: fixture.failInstall, tarballBytes: bytes.length, globalRoot: root }));
}

function preloadSource(fixture) {
  const { owner, repo } = fixture.releaseRepository;
  return `// Generated by console-update-fixture.mjs. Answers the product's GitHub Release asset URLs from the fixture and
// refuses every other non-loopback fetch in this process and in every Node child that inherits NODE_OPTIONS.
import fs from 'node:fs';
import path from 'node:path';
const releaseDir = ${JSON.stringify(fixture.releaseDir)};
const requestLog = ${JSON.stringify(fixture.requestLog)};
const delayMs = ${JSON.stringify(fixture.delayMs)};
const prefix = ${JSON.stringify(`/${owner}/${repo}/releases/`)};
const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
const original = globalThis.fetch;
const record = (entry) => { try { fs.appendFileSync(requestLog, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry }) + '\\n'); } catch {} };
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith(prefix)) {
    const name = decodeURIComponent(url.pathname.split('/').at(-1));
    const file = path.join(releaseDir, path.basename(name));
    const found = path.basename(name) === name && fs.existsSync(file);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    record({ asset: name, route: url.pathname.slice(prefix.length).split('/').slice(0, -1).join('/'), status: found ? 200 : 404 });
    return found ? new Response(fs.readFileSync(file), { status: 200 }) : new Response('', { status: 404 });
  }
  if (!loopback.has(url.hostname)) {
    record({ blocked: url.hostname });
    throw new TypeError('console-update-fixture blocks non-loopback fetch');
  }
  return original(input, init);
};
`;
}

/** The fixed lock read (references/setup.md#read-the-lock-without-the-token): port and pid only. */
function readLock(consoleDataDir) {
  try {
    const lock = JSON.parse(readFileSync(path.join(consoleDataDir, 'console.lock'), 'utf8'));
    return lock.port && lock.pid ? { port: lock.port, pid: lock.pid } : null;
  } catch {
    return null;
  }
}

function readProgress(consoleDataDir) {
  try {
    const p = JSON.parse(readFileSync(path.join(consoleDataDir, 'update-progress.json'), 'utf8'));
    const pick = ['phase', 'startedAt', 'updatedAt', 'fromVersion', 'targetVersion', 'reason', 'failureStage', 'oldConsoleOutcome', 'endpointChanged', 'error'];
    return Object.fromEntries(pick.filter((key) => p[key] !== undefined).map((key) => [key, p[key]]));
  } catch {
    return null;
  }
}

function installedVersion(fixture) {
  try {
    return JSON.parse(readFileSync(path.join(fixture.packageRoot, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

async function serve() {
  requireWrapper();
  const dir = requireAbs('dir');
  const fixture = readFixture(dir);
  if (fixture.consoleDataDir !== process.env.FLEET_CONSOLE_DATA_DIR) fail('serve must use the same --run-dir as prepare');
  writeFileSync(path.join(dir, 'supervisor.json'), `${JSON.stringify({ pid: process.pid, startedAt: now() })}\n`);
  const log = (event) => appendFileSync(fixture.lifecycleLog, `${JSON.stringify({ ts: now(), ...event })}\n`);
  const env = npmEnv(fixture, { NODE_OPTIONS: `--import ${fixture.preload}` });
  const cli = path.join(fixture.packageRoot, 'dist/cli.mjs');
  const out = openSync(path.join(dir, 'serve.log'), 'a');
  const child = spawn(process.execPath, [cli, 'serve'], { env, stdio: ['ignore', out, out] });
  log({ event: 'serve-started', pid: child.pid, installedVersion: installedVersion(fixture) });
  child.on('exit', (code, signal) => log({ event: 'first-serve-exited', code, signal }));

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    log({ event: 'supervisor-stopping', signal });
    // The installed cli, whichever version is installed now, stops the Console that holds this slot's lock.
    const result = spawnSync(process.execPath, [path.join(fixture.packageRoot, 'dist/cli.mjs'), 'stop'], { env, stdio: ['ignore', out, out], timeout: 30_000 });
    const lock = readLock(fixture.consoleDataDir);
    log({ event: 'supervisor-stopped', stopExit: result.status, lockRemains: lock !== null });
    process.exit(result.status === 0 && lock === null ? 0 : 1);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => void stop(signal));

  let last = { lock: undefined, phase: undefined, version: undefined };
  while (!stopping) {
    const lock = readLock(fixture.consoleDataDir);
    const progress = readProgress(fixture.consoleDataDir);
    const version = installedVersion(fixture);
    const lockKey = lock ? `${lock.pid}:${lock.port}` : null;
    if (lockKey !== last.lock) log({ event: 'lock', ...(lock ?? { pid: null, port: null }) });
    if ((progress?.phase ?? null) !== last.phase) log({ event: 'progress', ...(progress ?? { phase: null }) });
    if (version !== last.version) log({ event: 'installed-version', version });
    last = { lock: lockKey, phase: progress?.phase ?? null, version };
    await sleep(200);
  }
}

async function drive() {
  const dir = requireAbs('dir');
  const runDir = requireAbs('run-dir');
  const fixture = readFixture(dir);
  if (fixture.consoleDataDir !== path.join(runDir, 'console')) fail('--run-dir does not match the fixture');
  const timeoutMs = Number(opts['timeout-ms'] ?? 180_000);
  const report = { startedAt: now() };
  const deadline = Date.now() + timeoutMs;
  let lock = null;
  while (!lock && Date.now() < deadline) {
    lock = readLock(fixture.consoleDataDir);
    if (!lock) await sleep(250);
  }
  if (!lock) fail('console.lock did not appear');
  const base = `http://127.0.0.1:${lock.port}`;
  const call = async (pathname, method = 'GET') => {
    const response = await fetch(base + pathname, method === 'POST' ? { method, headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' } : {});
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const statusFields = (body) => body && { version: body.version, channel: body.channel, updateAvailable: body.updateAvailable, latestVersion: body.latestVersion ?? null };
  let before = { status: 0 };
  while (before.status !== 200 && Date.now() < deadline) {
    before = await call('/api/v1/status').catch(() => ({ status: 0 }));
    if (before.status !== 200) await sleep(250);
  }
  report.before = { lock, ...statusFields(before.body) };
  report.check = await call('/api/v1/updates/check', 'POST');
  report.apply = await call('/api/v1/updates/apply', 'POST');
  report.applyAt = now();
  let progress = null;
  while (Date.now() < deadline) {
    const response = await call('/api/v1/updates/progress').catch(() => null);
    if (response?.status === 200 && ['completed', 'failed'].includes(response.body?.state ?? response.body?.phase)) {
      progress = response.body;
      break;
    }
    await sleep(250);
  }
  report.progress = progress;
  const after = await call('/api/v1/status').catch(() => null);
  report.after = { lock: readLock(fixture.consoleDataDir), ...statusFields(after?.body) };
  report.finishedAt = now();
  writeFileSync(path.join(dir, 'drive.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ check: report.check.status, apply: report.apply.status, state: progress?.state ?? null, phase: progress?.phase ?? null, before: report.before.version, after: report.after.version ?? null }));
  const expected = fixture.failInstall ? 'failed' : 'completed';
  if (report.apply.status !== 202 || (progress?.state ?? progress?.phase) !== expected) process.exitCode = 1;
}

function stopSupervisor() {
  const dir = requireAbs('dir');
  let record;
  try {
    record = JSON.parse(readFileSync(path.join(dir, 'supervisor.json'), 'utf8'));
  } catch {
    return fail('no supervisor.json; serve was not started from this fixture');
  }
  // Prove the pid is still this fixture's supervisor before signalling it; a reused pid is not owned.
  const command = spawnSync('ps', ['-p', String(record.pid), '-o', 'command='], { encoding: 'utf8' }).stdout ?? '';
  if (!command.includes('console-update-fixture.mjs serve') || !command.includes(dir)) return fail(`pid ${record.pid} is not this fixture's supervisor; nothing signalled`);
  process.kill(record.pid, 'SIGTERM');
  console.log(JSON.stringify({ signalled: record.pid }));
}

const modes = { prepare, serve, drive, stop: stopSupervisor };
if (!modes[mode]) fail('usage: console-update-fixture.mjs prepare|serve|drive|stop --dir <fixture-dir> ...');
await modes[mode]();
