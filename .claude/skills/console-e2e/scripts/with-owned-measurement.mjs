#!/usr/bin/env node
// Opt-in only: the caller still needs the existing preflight and OS authorization.
// The default export runs in the lock-owning process. Await all measurement work;
// no measured operation may continue in a subprocess after this process dies.
// Do not detach measurement work, exit early, or transfer the native descriptor.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { readOwnedRunReceipt } from './e2e-resources.mjs';
import { callerHash } from './isolated-env.mjs';

const here = fileURLToPath(import.meta.url);
const nativeSource = fileURLToPath(new URL('./owned-measurement-lock.c', import.meta.url));
const wrapper = fileURLToPath(new URL('./isolated-env.mjs', import.meta.url));
const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
const require = createRequire(import.meta.url);
const usage = 'node with-owned-measurement.mjs --objective <id> --run-dir <abs> --receipt <abs> --scratch-dir <private abs> --module <abs.mjs> [-- <args...>]';

class MeasurementError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function refuse(code, message) {
  throw new MeasurementError(code, message);
}

const report = (event, fields) => fs.writeSync(2, `${JSON.stringify({ event, at: new Date().toISOString(), ...fields })}\n`);
const msSince = (start) => Number((performance.now() - start).toFixed(2));
const canonical = (value) => path.isAbsolute(value) && fs.realpathSync(value) === value;

function parse(argv) {
  const split = argv.indexOf('--');
  const args = split === -1 ? [] : argv.slice(split + 1);
  const inputs = split === -1 ? argv : argv.slice(0, split);
  const names = new Map([
    ['--objective', 'objective'], ['--run-dir', 'runDir'], ['--receipt', 'receiptFile'],
    ['--scratch-dir', 'scratchDir'], ['--module', 'moduleFile'],
  ]);
  const opts = { args };
  for (let i = 0; i < inputs.length; i += 2) {
    const key = names.get(inputs[i]);
    const value = inputs[i + 1];
    if (!key || Object.hasOwn(opts, key) || !value || value.startsWith('--')) refuse('usage', usage);
    opts[key] = value;
  }
  if ([...names.values()].some((key) => !Object.hasOwn(opts, key)) ||
      !['runDir', 'receiptFile', 'scratchDir', 'moduleFile'].every((key) => path.isAbsolute(opts[key])) ||
      path.extname(opts.moduleFile) !== '.mjs') refuse('usage', usage);
  return opts;
}

function hasNoAcl(file) {
  // Node's stat exposes Unix mode bits but not Darwin ACLs. `ls -e` adds one
  // line per ACL entry even alongside xattrs. Escape newlines in the pathname.
  return execFileSync('/bin/ls', ['-ldeb', file], { encoding: 'utf8', timeout: 2000, env: { LC_ALL: 'C' } }).trimEnd().split('\n').length === 1;
}

function requirePrivateDirectory(dir) {
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st?.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o7777) !== 0o700 || !canonical(dir) || !hasNoAcl(dir)) {
    refuse('measurement_cache_unverified', 'use an existing canonical, user-owned, mode-0700 scratch directory without an ACL');
  }
}

function headers() {
  const include = path.resolve(path.dirname(fs.realpathSync(process.execPath)), '../include/node');
  try {
    const header = fs.readFileSync(path.join(include, 'node_version.h'), 'utf8');
    const v = ['MAJOR', 'MINOR', 'PATCH'].map((field) => new RegExp(`^#define[ \\t]+NODE_${field}_VERSION[ \\t]+(\\d+)[ \\t]*$`, 'm').exec(header)?.[1]);
    if (v.join('.') === process.versions.node && fs.statSync(path.join(include, 'node_api.h')).isFile()) return include;
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  }
  refuse('measurement_node_headers_unavailable', `matching headers for Node ${process.versions.node} were not found beside this Node installation; no download is attempted`);
}

function loadNative(scratchDir, runDir) {
  requirePrivateDirectory(scratchDir);
  const relative = path.relative(runDir, scratchDir);
  if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
    refuse('measurement_cache_unverified', 'the scratch directory must be outside the owned run');
  }
  const include = headers();
  // Hash the exact source being compiled; identical copies of the skill can reuse
  // a binary within this one private scratch directory, but never a global cache.
  const source = fs.readFileSync(nativeSource);
  const key = createHash('sha256').update(source).update(JSON.stringify([process.version, process.arch, include])).digest('hex');
  const file = path.join(scratchDir, `owned-measurement-${key}.node`);
  const cached = () => {
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!st) return false;
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o7777) !== 0o600 || st.nlink !== 1 || st.size === 0 || !hasNoAcl(file)) {
      refuse('measurement_cache_unverified', 'the cached addon is not a private regular file');
    }
    return true;
  };
  const cacheHit = cached();
  if (!cacheHit) {
    const build = fs.mkdtempSync(path.join(scratchDir, 'measurement-build-'));
    const input = path.join(build, 'lock.c');
    const output = path.join(build, 'lock.node');
    try {
      fs.writeFileSync(input, source, { mode: 0o600 });
      try {
        execFileSync('/usr/bin/clang', ['-arch', process.arch === 'x64' ? 'x86_64' : process.arch,
          '-std=c11', '-D_DARWIN_C_SOURCE', '-Wall', '-Wextra', '-Werror', '-bundle', '-undefined', 'dynamic_lookup',
          '-I', include, input, '-o', output], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 30000 });
      } catch (error) {
        refuse('measurement_addon_build_failed', `local clang could not build the addon (${error.code ?? error.status ?? 'unknown'}); check Xcode Command Line Tools and matching Node headers`);
      }
      fs.chmodSync(output, 0o600);
      // Each builder publishes only a complete binary. Competing builds of this
      // key are interchangeable, and rename never follows a destination link.
      cached();
      fs.renameSync(output, file);
    } finally {
      fs.rmSync(build, { recursive: true, force: true });
    }
  }
  try { return { native: require(file), cacheHit }; }
  catch { refuse('measurement_addon_load_failed', 'could not load the private addon for this Node runtime'); }
}

async function measure(opts, creator) {
  const { objective, runDir, receiptFile, scratchDir, moduleFile, args } = opts;
  if (process.env.HOME !== path.join(runDir, 'home') || process.env.TMPDIR !== path.join(runDir, 'tmp') ||
      !canonical(process.env.HOME) || !canonical(process.env.TMPDIR) ||
      !fs.existsSync(path.join(runDir, `.e2e-active.${process.ppid}`))) {
    refuse('measurement_environment_unverified', 'measurement must run under the owned isolated wrapper');
  }
  const { runId } = readOwnedRunReceipt(receiptFile, { objective, runDir, creator });
  const preparing = performance.now();
  const { native, cacheHit } = loadNative(scratchDir, runDir);
  const prepareMs = msSince(preparing);
  const acquiring = performance.now();
  let fd;
  try { fd = native.acquire(); }
  catch (error) { refuse('measurement_lock_failed', error.message); }
  const fields = { runId, pid: process.pid, cacheHit, prepareMs, lockMs: msSince(acquiring) };
  if (fd === null) {
    report('measurement_busy', fields);
    return 75;
  }
  // The process running the module owns the FD, not a wrapper. Normal return
  // closes it; SIGKILL closes it in the kernel. An exec'ed child cannot keep it.
  let outcome = 'failed';
  try {
    report('measurement_start', fields);
    const { default: run } = await import(pathToFileURL(moduleFile).href).catch(() => {
      refuse('measurement_module_import_failed', 'could not import the measurement module');
    });
    if (typeof run !== 'function') refuse('measurement_module_invalid', 'the module must default-export a function');
    try { await run({ objective, runDir, receiptFile, runId, args }); }
    catch { refuse('measurement_module_failed', 'the measurement module failed; see its owned evidence'); }
    outcome = 'completed';
    return 0;
  } finally {
    try { report('measurement_end', { runId, pid: process.pid, outcome }); }
    finally { fs.closeSync(fd); }
  }
}

async function launch(opts, argv) {
  if (!process.env.FLEET_CONSOLE_WORKSPACE_SESSION_ID && !process.env.CLAUDE_CODE_SESSION_ID) {
    refuse('no_caller_identity', 'an owned run caller identity is required');
  }
  const creator = callerHash();
  readOwnedRunReceipt(opts.receiptFile, { ...opts, creator });
  const child = spawn(process.execPath, [wrapper, '--run-dir', opts.runDir, '--', process.execPath, here,
    '_measure', creator, ...argv], { stdio: 'inherit' });
  const handlers = signals.map((signal) => () => child.kill(signal));
  signals.forEach((signal, i) => process.on(signal, handlers[i]));
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? 128 + (constants.signals[signal] ?? 0)));
    });
  } finally { signals.forEach((signal, i) => process.off(signal, handlers[i])); }
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') { process.stdout.write(`${usage}\n`); return 0; }
  if (process.platform !== 'darwin') refuse('unsupported_platform', 'the owned measurement lane is macOS-only');
  if (argv[0] === '_measure') {
    const [, creator, ...rest] = argv;
    return measure(parse(rest), creator);
  }
  return launch(parse(argv), argv);
}

try { process.exitCode = await main(process.argv.slice(2)); }
catch (error) {
  const code = typeof error?.code === 'string' ? error.code : 'measurement_failed';
  // Errors from a measurement module need not contain safe diagnostic details.
  report('measurement_error', { code, ...(error instanceof MeasurementError ? { detail: error.message } : {}) });
  process.exitCode = 2;
}
