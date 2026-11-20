#!/usr/bin/env node
/**
 * Create, inspect, and reclaim one owned E2E run directory, with a receipt kept outside it.
 *
 *   init     --objective <id> --run-dir <abs> --receipt <abs>
 *   list     --objective <id> --receipt <abs> [--receipt <abs>]...
 *   check    --objective <id> --receipt <abs> [--receipt <abs>]...
 *   reclaim  --objective <id> --receipt <abs> [--receipt <abs>]... [--apply --evidence <abs-file> [--accept-state <digest> --accept-ref <ref>]]
 *   preserve --objective <id> --receipt <abs> --request-ref <ref> --keeper <who> --release <condition> [--clear]
 *
 * Every command prints one JSON document (`--json` is accepted and changes nothing) and exits 0 when this objective's
 * responsibility is complete or only validly preserved, 1 while any of it remains, and 2 for a call, receipt, or
 * authority error. `reclaim` plans by default; only `--apply --evidence <file>` changes anything, and `list`, `check`,
 * and a plan never write.
 *
 * Authority is the conjunction of independent checks, never one of them:
 *   1. The receipt (outside the run directory, mode 0600) and the marker inside it carry the same random nonce, and the
 *      directory still has the recorded realpath, device, inode, and uid, with no symlink in any path component.
 *   2. The call names the objective the receipt records. The objective id is a selector, not a credential.
 *   3. Nothing is running: no live, unreadable, in-publication, or update-owned Console lock, and no active wrapper-run
 *      command (`<run-dir>/.e2e-active.<pid>`). A reclaim first takes `<run-dir>/.e2e-reclaiming`, which the wrapper
 *      refuses to start under; each removal re-checks the directory, the claim, the lock, and the active records.
 *   4. What is removed is attributable. Documented log files, the wrapper's per-call PATH links, tsx sockets, and the init
 *      and claim records are removed by default. Everything the Console, an agent, or a person may have written (`console`,
 *      `root`, `claude`, the owned HOME's entries, the rest of `tmp`, fixtures) is state: it is listed with a content-free
 *      digest of its exact entries, kept by default, and removed only for a caller that already holds separate authority over
 *      exactly that state: `--accept-state <digest of a fresh list> --accept-ref <that authority>`, one receipt per call.
 *      The digest identifies the listed entries (path, type, inode, size, mode, nanosecond mtime and ctime, bound to the run);
 *      it is not a content hash, an approval, or evidence. It is printed only by `list`, never suggested by a plan, and a
 *      listing too long to show in full cannot be accepted. It is re-verified immediately before each tree is removed, so a
 *      change since the review needs a new `list` and a new decision. A name this tool does not know, a symlink where a
 *      directory belongs, a mount point, another user's file, or a special file is never removed, and while one exists no
 *      state is removed either.
 * The receipt and marker are same-user files, so they are not a security boundary between OS accounts or between sessions
 * of one account. This command never sends a signal to a process and never stops a Console: stop through the
 * isolated-environment wrapper (`cli.mjs stop` with the same `--run-dir`) from the session that started it, then run it
 * again. It never touches a worktree, a Theater, a browser tab or session, the canonical Console slot, or any path it did
 * not create. It prints neither the receipt nonce nor any lock token. Evidence is checked to exist outside the run and
 * recorded by size and digest; it is not permission to delete data this tool does not attribute. The marker and owner
 * record go last, after the receipt records that removal began, so an interrupted run is resumed by the same inode.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callerHash } from './isolated-env.mjs';

const SCHEMA = 1;
const MARKER = '.e2e-run.json';
const OWNER = 'owner';
const FLAG = '.e2e-reclaiming';
const ACTIVE = /^\.e2e-active\.(\d+)$/;
const LISTING_CAP = 2000;
const RUN_NAME = /^e2e-[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const OBJECTIVE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RECEIPT_MAX_BYTES = 64 * 1024;
const WALK_LIMIT = 200_000;
const UPDATE_RUNNING_PHASES = new Set(['starting', 'preflight-ok', 'stopping-console', 'installing', 'starting-daemon']);
const UPDATE_STALE_MS = 10 * 60 * 1000;
const HOME_PROTECTED = ['.fleet', '.claude', '.codex', '.agent-browser', '.config', '.ssh', 'Library'];

// What the wrapper and the documented fixtures create directly under a run directory. `tmp`, `pathbin` and `home` are
// classified entry by entry below; the rest of TOP_DIRS is Console, agent, or fixture state.
const TOP_DIRS = new Set(['root', 'console', 'desktop', 'claude', 'claude-tmp', 'pathbin', 'fake-claude', 'update-fixture', 'ios-build']);
const TOP_FILES = new Set(['serve.log', 'owned-process.json', 'link.txt', 'emulator.log', 'away-cookies.json']);
// Entries a shell, pnpm, node, or tsx leaves in the owned HOME. Anything else there may be a person's file.
const HOME_NAMES = new Set(['.zsh_history', '.zsh_sessions', '.bash_history', '.bash_sessions', '.node_repl_history', '.lesshst',
  '.viminfo', '.python_history', '.DS_Store', '.npm', '.cache', '.local', '.config', 'Library', '.terminfo']);
const HOME_PREFIXES = ['.zcompdump'];

const DELEGATED = [
  'worktree: never registered or removed here; remove a dedicated worktree through the git-worktree skill, which checks ownership and unsaved or unpushed work',
  'Theater, browser tab, and agent-browser session: outside this run directory; their owner closes them',
  'canonical Console slot and other sessions\' runs: never touched',
];

class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const UID = typeof process.getuid === 'function' ? process.getuid() : null;

function requireUid() {
  if (UID === null || process.platform === 'win32') throw new CliError('unsupported_platform', 'e2e-resources runs on macOS and Linux only');
}

// ---------------------------------------------------------------------------------------------------------------------
// Paths

function isCanonicalAbsolute(p) {
  return typeof p === 'string' && p.length > 0 && !p.includes('\0') && path.isAbsolute(p) && path.resolve(p) === p;
}

function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function lstatOrNull(p, options) {
  try {
    return fs.lstatSync(p, options);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function sha256File(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1 << 16);
    let bytes = 0;
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      hash.update(buffer.subarray(0, n));
      bytes += n;
    }
    return { sha256: hash.digest('hex'), bytes };
  } finally {
    fs.closeSync(fd);
  }
}

function gitEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

/** The first `git worktree list` entry of the repository that holds `dir`, resolved. Null when `dir` is not in one. */
function mainCheckoutOf(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    const first = /^worktree (.+)$/m.exec(out);
    return first ? fs.realpathSync(first[1]) : null;
  } catch {
    return null;
  }
}

/** Receipt-content rules: a run directory is `<main checkout>/.fleet/e2e-<name>`. A violation is an invalid receipt. */
function runLayout(runDir) {
  if (!isCanonicalAbsolute(runDir)) throw new CliError('layout_invalid', 'run directory must be a canonical absolute path');
  if (!RUN_NAME.test(path.basename(runDir))) throw new CliError('layout_invalid', 'run directory name must match e2e-<name>');
  const fleetDir = path.dirname(runDir);
  if (path.basename(fleetDir) !== '.fleet') throw new CliError('layout_invalid', 'run directory must sit directly under <main checkout>/.fleet');
  return { fleetDir, mainDir: path.dirname(fleetDir) };
}

/** Filesystem rules for the ancestors; returns a block reason code, or null when they hold. */
function ancestorProblem({ fleetDir, mainDir }) {
  const fleetStat = lstatOrNull(fleetDir);
  if (fleetStat === null) return 'absent';
  if (fleetStat.isSymbolicLink() || !fleetStat.isDirectory()) return 'symlink_component';
  if (fleetStat.uid !== UID) return 'foreign_owner';
  if (realOrNull(fleetDir) !== fleetDir || realOrNull(mainDir) !== mainDir) return 'symlink_component';
  const realHome = realOrNull(os.homedir());
  if (realHome && HOME_PROTECTED.some((entry) => inside(fleetDir, path.join(realHome, entry)))) return 'outside_allowed_root';
  if (mainCheckoutOf(mainDir) !== mainDir) return 'main_checkout_unverified';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Receipt

function validateReceiptShape(value) {
  const bad = (what) => new CliError('receipt_invalid', `receipt is invalid (${what})`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('not an object');
  if (value.schema !== SCHEMA || value.kind !== 'e2e-run') throw bad('schema');
  if (typeof value.objective !== 'string' || !OBJECTIVE.test(value.objective)) throw bad('objective');
  if (typeof value.runId !== 'string' || !/^[0-9a-f]{32}$/.test(value.runId)) throw bad('runId');
  if (typeof value.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(value.nonce)) throw bad('nonce');
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) throw bad('createdAt');
  if (value.uid !== UID) throw bad('uid');
  if (typeof value.creator !== 'string' || !/^[0-9a-f]{16}$/.test(value.creator)) throw bad('creator');
  const dir = value.runDir;
  if (!dir || typeof dir.path !== 'string' || !/^\d+$/.test(String(dir.dev)) || !/^\d+$/.test(String(dir.ino))) throw bad('runDir');
  try {
    runLayout(dir.path);
  } catch {
    throw bad('runDir layout');
  }
  const kept = value.preserved;
  if (kept !== undefined && kept !== null) {
    if (typeof kept !== 'object' || ![kept.requestRef, kept.keeper, kept.release, kept.at].every((field) => typeof field === 'string' && field.length > 0)) throw bad('preserved');
  }
  if (value.closing !== undefined && value.closing !== null && (typeof value.closing !== 'object' || typeof value.closing.at !== 'string')) throw bad('closing');
  if (value.closed !== undefined && value.closed !== null && (typeof value.closed !== 'object' || typeof value.closed.at !== 'string')) throw bad('closed');
  return value;
}

function checkReceiptLocation(file) {
  if (!isCanonicalAbsolute(file)) throw new CliError('receipt_invalid', '--receipt must be a canonical absolute path');
  const dir = path.dirname(file);
  const dirStat = lstatOrNull(dir);
  if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new CliError('receipt_invalid', 'receipt directory must be an existing real directory');
  if (realOrNull(dir) !== dir) throw new CliError('receipt_invalid', 'receipt path has a symlink component');
  if (dirStat.uid !== UID) throw new CliError('receipt_permissions', 'receipt directory is owned by another user');
  if ((dirStat.mode & 0o022) !== 0) throw new CliError('receipt_permissions', 'receipt directory must not be group- or world-writable');
}

function readReceipt(file) {
  checkReceiptLocation(file);
  const stat = lstatOrNull(file);
  if (!stat) throw new CliError('receipt_missing', 'receipt does not exist');
  if (stat.isSymbolicLink() || !stat.isFile()) throw new CliError('receipt_invalid', 'receipt must be a regular file');
  if (stat.uid !== UID) throw new CliError('receipt_permissions', 'receipt is owned by another user');
  if ((stat.mode & 0o077) !== 0) throw new CliError('receipt_permissions', 'receipt must be mode 0600');
  if (stat.size > RECEIPT_MAX_BYTES) throw new CliError('receipt_invalid', 'receipt is too large');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new CliError('receipt_invalid', 'receipt is not valid JSON');
  }
  return validateReceiptShape(parsed);
}

function writeReceiptReplacing(file, receipt) {
  const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function nonceMatches(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------------------------------------------------
// Observation

function pidState(pid) {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'pid='], { encoding: 'utf8', env: { PATH: '/bin:/usr/bin', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\s+/).includes(String(pid)) ? 'alive' : 'dead';
  } catch (error) {
    return error.status === 1 && !String(error.stdout ?? '').trim() ? 'dead' : 'unknown';
  }
}

function updateActive(consoleDir) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(consoleDir, 'update-progress.json'), 'utf8'));
  } catch {
    return false;
  }
  if (!raw || typeof raw !== 'object' || !UPDATE_RUNNING_PHASES.has(raw.phase)) return false;
  if (Number.isSafeInteger(raw.workerPid) && raw.workerPid > 0) return pidState(raw.workerPid) !== 'dead';
  const updatedAt = typeof raw.updatedAt === 'string' ? Date.parse(raw.updatedAt) : Number.NaN;
  return !(Number.isFinite(updatedAt) && Date.now() - updatedAt > UPDATE_STALE_MS);
}

/**
 * The slot's lock, judged without a signal and without printing its body. Only a dead author (no such process) frees it;
 * an unreadable, unsafe, in-publication, or live lock blocks. `digest` identifies the exact bytes judged.
 */
function observeLock(runDir) {
  const consoleDir = path.join(runDir, 'console');
  const dirStat = lstatOrNull(consoleDir);
  if (!dirStat) return { state: 'none' };
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || dirStat.uid !== UID) return { state: 'unsafe', block: 'lock_unsafe' };
  let names;
  try {
    names = fs.readdirSync(consoleDir);
  } catch {
    return { state: 'unreadable', block: 'lock_unreadable' };
  }
  const lockFile = path.join(consoleDir, 'console.lock');
  const lockStat = lstatOrNull(lockFile);
  let result = { state: 'none' };
  if (lockStat) {
    if (lockStat.isSymbolicLink() || !lockStat.isFile() || lockStat.uid !== UID) return { state: 'unsafe', block: 'lock_unsafe' };
    let bytes;
    try {
      bytes = fs.readFileSync(lockFile);
    } catch {
      return { state: 'unreadable', block: 'lock_unreadable' };
    }
    let pid = null;
    try {
      const lock = JSON.parse(bytes.toString('utf8'));
      if (Number.isInteger(lock.pid) && lock.pid > 0 && Number.isInteger(lock.port) && lock.port > 0) pid = lock.pid;
    } catch {
      pid = null;
    }
    if (pid === null) return { state: 'unreadable', block: 'lock_unreadable' };
    const digest = createHash('sha256').update(bytes).digest('hex');
    const alive = pidState(pid);
    if (alive !== 'dead') return { state: alive === 'alive' ? 'live' : 'unknown', block: 'live_lock', digest };
    result = { state: 'dead', digest };
  }
  for (const name of names) {
    if (!name.startsWith('.console.lock.')) continue;
    const rest = name.slice('.console.lock.'.length);
    const staged = /^c?tmp-(\d+)-/.exec(rest);
    if (staged ? pidState(Number(staged[1])) !== 'dead' : true) return { state: 'pending', block: 'lock_pending', digest: result.digest };
  }
  if (updateActive(consoleDir)) return { state: 'update', block: 'update_active', digest: result.digest };
  return result;
}

function homeName(name) {
  return HOME_NAMES.has(name) || HOME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Walk one entry without following symlinks. Returns what would block its removal, the entry types seen, and a sorted
 * listing (relative path, type, inode, size, whole-second mtime) that identifies exactly what is there without reading
 * any content.
 */
function scan(root, runDir, runDev, budget) {
  const issues = [];
  const types = new Set();
  const lines = [];
  let entries = 0;
  let bytes = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let stat;
    try {
      stat = fs.lstatSync(current, { bigint: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      issues.push({ path: current, reason: 'unreadable' });
      continue;
    }
    entries += 1;
    budget.count += 1;
    if (budget.count > WALK_LIMIT) {
      issues.push({ path: current, reason: 'too_many_entries' });
      break;
    }
    if (Number(stat.uid) !== UID) {
      issues.push({ path: current, reason: 'foreign_owner' });
      continue;
    }
    if (stat.dev !== runDev) {
      issues.push({ path: current, reason: 'other_filesystem' });
      continue;
    }
    const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : stat.isSocket() ? 'socket' : 'special';
    types.add(type);
    // One unambiguous row per entry (a JSON array, so no name can imitate a separator): path, type, inode, size, mode,
    // and nanosecond mtime and ctime, so an edit that keeps the size, a rename, or a chmod still changes the digest.
    lines.push([path.relative(runDir, current), type, String(stat.ino), String(stat.size), String(stat.mode), String(stat.mtimeNs), String(stat.ctimeNs)]);
    if (type === 'special') {
      issues.push({ path: current, reason: 'special_file' });
    } else if (type === 'file') {
      bytes += Number(stat.size);
    } else if (type === 'dir') {
      let children;
      try {
        children = fs.readdirSync(current);
      } catch {
        issues.push({ path: current, reason: 'unreadable' });
        continue;
      }
      for (const child of children) stack.push(path.join(current, child));
    }
  }
  lines.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { issues, types, entries, bytes, lines, digest: createHash('sha256').update(JSON.stringify(lines)).digest('hex') };
}

const TMP_CHILD = /^tsx-\d+$/;
const PATHBIN_CHILD = /^call-/;

/**
 * Classify what sits in a run directory. Only what this tool can attribute from its own structure is `attributed`
 * (documented log and fixture files, the wrapper's per-call PATH links, tsx sockets, the init and reclaim records). Anything
 * the Console, an agent, or a person may have written is `state`: it is listed with a content-free digest and removed only
 * under `--accept-state` for exactly that digest. A name this tool does not know is `unrecognized` and is never removed.
 */
function inventory(runDir, runDev, { flagNonce, runId }) {
  const budget = { count: 0 };
  const out = { control: [], stale: [], attributed: [], state: [], unrecognized: [], unsafe: [], emptyDirs: [], activeWrappers: 0, flagBusy: false, canonicalSlot: false, stateDigest: null, truncated: false };
  let names;
  try {
    names = fs.readdirSync(runDir).sort();
  } catch {
    out.unsafe.push({ path: runDir, reason: 'unreadable' });
    return out;
  }
  const take = (full, display, kind) => {
    const result = scan(full, runDir, runDev, budget);
    if (result.issues.length > 0) {
      for (const issue of result.issues) out.unsafe.push({ path: issue.path, reason: issue.reason });
      return null;
    }
    const entry = { name: display, path: full, kind, entries: result.entries, bytes: result.bytes, digest: result.digest, types: result.types, lines: result.lines };
    (kind === 'attributed' ? out.attributed : out.state).push(entry);
    return entry;
  };
  const readSmallJson = (file) => {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.uid !== UID || stat.size > 4096) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };
  for (const name of names) {
    const full = path.join(runDir, name);
    const stat = lstatOrNull(full);
    if (!stat) continue;
    const plainFile = stat.isFile() && !stat.isSymbolicLink() && stat.uid === UID;
    if (name === MARKER || name === OWNER) {
      out.control.push(full);
    } else if (name === FLAG) {
      const flag = readSmallJson(full);
      if (flag && flag.nonce === flagNonce) out.control.push(full);
      else if (flag && Number.isInteger(flag.pid) && pidState(flag.pid) === 'dead') out.stale.push(full);
      else if (plainFile) out.flagBusy = true;
      else out.unrecognized.push(full);
    } else if (ACTIVE.test(name)) {
      const pid = Number(ACTIVE.exec(name)[1]);
      if (!plainFile) out.unrecognized.push(full);
      else if (pidState(pid) === 'dead') out.stale.push(full);
      else out.activeWrappers += 1;
    } else if (name === 'canonical-console.pid') {
      out.canonicalSlot = true;
    } else if (name === 'home' && stat.isDirectory() && !stat.isSymbolicLink()) {
      let children;
      try {
        children = fs.readdirSync(full).sort();
      } catch {
        out.unsafe.push({ path: full, reason: 'unreadable' });
        continue;
      }
      for (const child of children) {
        const childPath = path.join(full, child);
        const childStat = lstatOrNull(childPath);
        if (!childStat) continue;
        if (childStat.isSymbolicLink() || !homeName(child)) out.unrecognized.push(childPath);
        else take(childPath, `home/${child}`, 'state');
      }
      out.emptyDirs.push(full);
    } else if ((name === 'tmp' || name === 'pathbin') && stat.isDirectory() && !stat.isSymbolicLink()) {
      let children;
      try {
        children = fs.readdirSync(full).sort();
      } catch {
        out.unsafe.push({ path: full, reason: 'unreadable' });
        continue;
      }
      for (const child of children) {
        const childPath = path.join(full, child);
        const childStat = lstatOrNull(childPath);
        if (!childStat) continue;
        const shaped = (name === 'tmp' ? TMP_CHILD : PATHBIN_CHILD).test(child) && childStat.isDirectory() && !childStat.isSymbolicLink();
        const entry = take(childPath, `${name}/${child}`, 'state');
        if (!entry) continue;
        const allowed = name === 'tmp' ? ['dir', 'socket'] : ['dir', 'symlink'];
        if (shaped && [...entry.types].every((type) => allowed.includes(type))) {
          out.state.pop();
          entry.kind = 'attributed';
          out.attributed.push(entry);
        }
      }
      out.emptyDirs.push(full);
    } else if (TOP_FILES.has(name) && plainFile) {
      take(full, name, 'attributed');
    } else if (TOP_DIRS.has(name) && stat.isDirectory() && !stat.isSymbolicLink()) {
      take(full, name, 'state');
    } else {
      out.unrecognized.push(full);
    }
  }
  if (out.state.length > 0) {
    // Bound to this run, so a digest from one run can never select another.
    out.stateDigest = createHash('sha256').update(JSON.stringify({ runId, state: out.state.map((entry) => [entry.name, entry.digest]) })).digest('hex');
    out.truncated = out.state.some((entry) => entry.lines.length > LISTING_CAP);
  }
  return out;
}

function relList(runDir, list) {
  return list.map((entry) => path.relative(runDir, typeof entry === 'string' ? entry : entry.path) || '.');
}

/** One run directory against its receipt: identity, lock, and contents. Reads only; never writes. */
function observeRun(receipt, { deep, accept = null, flagNonce = null }) {
  const runDir = receipt.runDir.path;
  const base = { kind: 'run-dir', path: runDir };
  const state = (status, reason, detail, extra = {}) => ({ ...base, status, reason, detail, ...extra });
  if (receipt.closed) {
    return state('already_gone', 'closed_by_reclaim', 'an earlier reclaim removed this run and recorded it; a path that exists now is not this run and is left alone');
  }
  const layout = runLayout(runDir);
  const problem = ancestorProblem(layout);
  if (problem === 'absent') return state('already_gone', 'path_absent', 'the run directory does not exist');
  if (problem) return state('blocked', problem, 'the path to the run directory is not the one this receipt recorded', { reclaimable: false });
  const stat = lstatOrNull(runDir, { bigint: true });
  if (!stat) return state('already_gone', 'path_absent', 'the run directory does not exist');
  if (stat.isSymbolicLink() || !stat.isDirectory()) return state('blocked', 'path_replaced', 'a symlink or non-directory now sits at the recorded path; it was not touched', { reclaimable: false });
  if (String(stat.dev) !== String(receipt.runDir.dev) || String(stat.ino) !== String(receipt.runDir.ino)) {
    return state('blocked', 'path_replaced', 'a different directory now sits at the recorded path (device/inode differ); it was not touched', { reclaimable: false });
  }
  if (Number(stat.uid) !== UID) return state('blocked', 'foreign_owner', 'the run directory is owned by another user', { reclaimable: false });
  if (realOrNull(runDir) !== runDir) return state('blocked', 'symlink_component', 'the run directory path has a symlink component', { reclaimable: false });

  const marker = lstatOrNull(path.join(runDir, MARKER));
  let markerOk = false;
  if (marker && marker.isFile() && !marker.isSymbolicLink() && marker.uid === UID && marker.size < 4096) {
    try {
      const body = JSON.parse(fs.readFileSync(path.join(runDir, MARKER), 'utf8'));
      markerOk = body && body.schema === SCHEMA && body.runId === receipt.runId && typeof body.nonce === 'string' && nonceMatches(body.nonce, receipt.nonce);
    } catch {
      markerOk = false;
    }
  }
  let closing = false;
  if (!markerOk) {
    // An interrupted final step: the receipt says removal had begun, the marker is gone, and the same inode still holds
    // nothing but what removal leaves. Anything else here is new content in a directory this tool no longer vouches for.
    let names = null;
    if (!marker && receipt.closing) {
      try { names = fs.readdirSync(runDir); } catch { names = null; }
    }
    if (names && names.every((name) => name === OWNER || name === FLAG)) closing = true;
    else return state('blocked', 'marker_mismatch', 'the marker inside the directory does not match the receipt, or new content appeared after removal began; it was not touched', { reclaimable: false });
  }
  const owner = lstatOrNull(path.join(runDir, OWNER));
  if (owner) {
    let ownerOk = false;
    if (owner.isFile() && !owner.isSymbolicLink() && owner.uid === UID && owner.size < 256) {
      try {
        ownerOk = fs.readFileSync(path.join(runDir, OWNER), 'utf8').trim() === receipt.creator;
      } catch {
        ownerOk = false;
      }
    }
    if (!ownerOk) return state('blocked', 'owner_mismatch', 'the directory belongs to another session; it was not touched', { reclaimable: false });
  }

  const lock = observeLock(runDir);
  const items = inventory(runDir, stat.dev, { flagNonce, runId: receipt.runId });
  const inv = deep ? {
    attributed: items.attributed.map((entry) => ({ name: entry.name, entries: entry.entries, bytes: entry.bytes })),
    state: items.state.map((entry) => ({
      name: entry.name,
      entries: entry.entries,
      bytes: entry.bytes,
      digest: entry.digest,
      listing: entry.lines.slice(0, LISTING_CAP).map(([rel, type, , size]) => ({ path: rel, type, size: Number(size) })),
      listingTruncated: Math.max(0, entry.lines.length - LISTING_CAP),
    })),
    stateDigest: items.stateDigest,
    listingComplete: !items.truncated,
    unrecognized: relList(runDir, items.unrecognized),
    unsafe: items.unsafe.map((entry) => ({ path: path.relative(runDir, entry.path) || '.', reason: entry.reason })),
    activeWrappers: items.activeWrappers,
  } : undefined;
  const common = { lock: { state: lock.state }, ...(inv ? { inventory: inv } : {}), observed: { runDev: stat.dev, lockDigest: lock.digest, items, closing } };

  if (receipt.preserved) {
    const remaining = [runDir, ...[...items.attributed, ...items.state].map((entry) => entry.path), ...items.unrecognized, ...items.control];
    return state('preserved', 'preserved', 'a recorded request keeps this run and everything under it', { preserved: receipt.preserved, remaining: [...new Set(remaining)], ...common });
  }
  if (items.flagBusy) return state('blocked', 'reclaim_in_progress', 'another reclaim holds this run; wait for it to finish', { reclaimable: false, ...common });
  if (items.activeWrappers > 0) return state('blocked', 'wrapper_active', 'a wrapper-run command is still active in this run directory; let it end (or stop it through its own session), then run again', { reclaimable: false, ...common });
  if (lock.block) {
    const hint = lock.block === 'live_lock'
      ? 'a Console lock names a live or unverifiable process; stop it through the isolated-environment wrapper (cli.mjs stop with the same --run-dir) from the session that started it, then run again. If that pid was reused by another program, a person must confirm it.'
      : lock.block === 'lock_pending' ? 'a lock publication or reclaim marker is present; let the wrapper-run `cli.mjs stop` settle it, then run again'
        : lock.block === 'update_active' ? 'a Console update is still running in this slot'
          : 'the Console lock cannot be read safely; leave it';
    return state('blocked', lock.block, hint, { reclaimable: false, ...common });
  }
  if (items.canonicalSlot) {
    return state('blocked', 'canonical_slot', 'this run started a Console in a canonical checkout slot, which this tool never touches; stop it through the wrapper with the same --canonical-console-dir', { reclaimable: false, ...common });
  }
  const remaining = [...items.unrecognized, ...items.unsafe.map((entry) => entry.path)];
  const accepted = items.stateDigest === null || (accept !== null && accept === items.stateDigest && !items.truncated);
  const plan = {
    remove: relList(runDir, [...items.attributed, ...items.stale]),
    state: items.state.map((entry) => entry.name),
    stateNeedsDisposition: items.state.length > 0,
  };
  if (items.unsafe.length > 0) {
    return state('blocked', 'unsafe_entry', 'entries on another filesystem, owned by another user, special, or unreadable are kept; what is attributable can still be reclaimed', { reclaimable: 'partial', remaining: [...new Set(remaining)], plan, ...common });
  }
  if (items.unrecognized.length > 0) {
    return state('blocked', 'unrecognized_content', 'entries this tool does not recognise may be a person\'s data and are never removed here; resolve them by hand', { reclaimable: 'partial', remaining: [...new Set(remaining)], plan, ...common });
  }
  if (!accepted) {
    const reason = accept === null ? 'unattributed_state' : items.truncated && accept === items.stateDigest ? 'listing_truncated' : 'state_changed';
    const detail = {
      unattributed_state: 'Console, agent, and shell state may hold a person\'s data and is kept. Only a caller who already holds separate authority over exactly this state may name it with --accept-state and --accept-ref, after reading a fresh `list`',
      listing_truncated: 'the state listing is too long to be shown in full, so it cannot be accepted as a whole; nothing in state was removed',
      state_changed: 'the accepted digest does not match what is in the run now (or belongs to another run or an earlier listing); nothing in state was removed. Read a fresh `list` before deciding again',
    }[reason];
    return state('blocked', reason, detail, {
      reclaimable: 'partial', remaining: items.state.map((entry) => entry.path), plan, ...common,
    });
  }
  return state('blocked', 'reclaim_pending', 'ready: run reclaim with --apply and --evidence to remove it', { reclaimable: true, plan, ...common });
}

// ---------------------------------------------------------------------------------------------------------------------
// Reclaim

function checkEvidence(file, runDir) {
  if (!isCanonicalAbsolute(file)) throw new CliError('evidence_invalid', '--evidence must be a canonical absolute path');
  const stat = lstatOrNull(file);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw new CliError('evidence_invalid', '--evidence must be an existing regular file');
  if (stat.uid !== UID) throw new CliError('evidence_invalid', '--evidence is owned by another user');
  if (stat.size === 0) throw new CliError('evidence_invalid', '--evidence is empty');
  if (realOrNull(file) !== file) throw new CliError('evidence_invalid', '--evidence path has a symlink component');
  if (inside(file, runDir)) throw new CliError('evidence_invalid', '--evidence must be outside the run it covers');
  const { sha256, bytes } = sha256File(file);
  return { path: file, bytes, sha256 };
}

function removeEntry(target) {
  try {
    fs.rmSync(target, { recursive: true, force: false });
    return null;
  } catch (error) {
    return error.code === 'ENOENT' ? null : (error.code ?? 'error');
  }
}

/**
 * The reclaim claim: an exclusive record inside the run directory that the wrapper refuses to start under, written before
 * anything is judged. A wrapper-run command records `.e2e-active.<pid>` and re-reads this claim, so one of the two always sees
 * the other. A claim whose process is gone is stale and is replaced.
 */
function takeFlag(runDir) {
  const file = path.join(runDir, FLAG);
  const nonce = randomBytes(16).toString('hex');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, `${JSON.stringify({ schema: SCHEMA, pid: process.pid, nonce })}\n`, { flag: 'wx', mode: 0o600 });
      return nonce;
    } catch (error) {
      if (error.code !== 'EEXIST') return null;
      let held = null;
      try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
      if (!held || !Number.isInteger(held.pid) || pidState(held.pid) !== 'dead') return null;
      if (removeEntry(file)) return null;
    }
  }
  return null;
}

function releaseFlag(runDir, nonce) {
  const file = path.join(runDir, FLAG);
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).nonce === nonce) fs.rmSync(file, { force: true });
  } catch {
    // Already gone or not ours.
  }
}

/** The cheap re-check before every removal: same directory, our claim still held, no wrapper active, the lock judged earlier. */
function recheck(receipt, lockDigest, flagNonce) {
  const runDir = receipt.runDir.path;
  const stat = lstatOrNull(runDir, { bigint: true });
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || String(stat.dev) !== String(receipt.runDir.dev) || String(stat.ino) !== String(receipt.runDir.ino)) return 'path_replaced';
  try {
    if (JSON.parse(fs.readFileSync(path.join(runDir, FLAG), 'utf8')).nonce !== flagNonce) return 'reclaim_in_progress';
  } catch {
    return 'reclaim_in_progress';
  }
  let names = [];
  try { names = fs.readdirSync(runDir); } catch { return 'unreadable'; }
  for (const name of names) {
    const match = ACTIVE.exec(name);
    if (match && pidState(Number(match[1])) !== 'dead') return 'wrapper_active';
  }
  const lock = observeLock(runDir);
  if (lock.block) return lock.block;
  if (lock.state !== 'none' && lock.digest !== lockDigest) return 'lock_changed';
  return null;
}

function applyReclaim(receipt, receiptFile, evidence, accept, acceptRef) {
  const runDir = receipt.runDir.path;
  const idle = { removed: [], failed: [] };
  const first = observeRun(receipt, { deep: false, accept });
  if (first.status === 'already_gone') {
    if (!receipt.closed && first.reason === 'path_absent') closeReceipt(receipt, receiptFile, evidence, accept ? acceptRef : null);
    return { ...first, actions: idle };
  }
  if (first.status !== 'blocked' || first.reclaimable === false) return { ...first, actions: idle };

  const flagNonce = takeFlag(runDir);
  if (flagNonce === null) {
    return { ...first, reason: 'reclaim_in_progress', reclaimable: false, detail: 'another reclaim holds this run, or its claim cannot be written; nothing was changed', actions: idle };
  }
  const removed = [];
  const failed = [];
  let finished = false;
  let closingWritten = false;
  try {
    const held = observeRun(receipt, { deep: false, accept, flagNonce });
    if (held.status !== 'blocked' || held.reclaimable === false) return { ...held, actions: idle };
    const { items, closing } = held.observed;
    const lockDigest = held.observed.lockDigest;
    let abandoned = null;
    const guard = () => {
      abandoned = abandoned ?? recheck(receipt, lockDigest, flagNonce);
      return abandoned;
    };
    // Unrecognised or unsafe entries mean this tool cannot tell what the state belongs to, so state stays with them.
    const stateAccepted = (items.stateDigest === null || (accept !== null && accept === items.stateDigest && !items.truncated)) && items.unrecognized.length === 0 && items.unsafe.length === 0;
    if (!closing) {
      const attributed = [...items.attributed, ...items.stale.map((p) => ({ path: p, kind: 'stale' }))];
      for (const target of attributed) {
        if (guard()) break;
        if (target.kind === 'attributed') {
          const again = scan(target.path, runDir, held.observed.runDev, { count: 0 });
          if (again.issues.length > 0 || again.digest !== target.digest) {
            failed.push({ path: path.relative(runDir, target.path), code: 'changed' });
            continue;
          }
        }
        const code = removeEntry(target.path);
        if (code) failed.push({ path: path.relative(runDir, target.path), code });
        else removed.push(path.relative(runDir, target.path));
      }
      if (stateAccepted && items.state.length > 0) {
        // `console` goes last, so its lock outlasts everything that depends on it.
        const ordered = [...items.state].sort((a, b) => Number(a.name === 'console') - Number(b.name === 'console'));
        for (const target of ordered) {
          if (guard()) break;
          // The content digest is recomputed immediately before each removal, so a restart or a new file since the plan stops it.
          const again = scan(target.path, runDir, held.observed.runDev, { count: 0 });
          if (again.issues.length > 0 || again.digest !== target.digest) {
            failed.push({ path: path.relative(runDir, target.path), code: 'state_changed' });
            abandoned = abandoned ?? 'state_changed';
            break;
          }
          const code = removeEntry(target.path);
          if (code) failed.push({ path: path.relative(runDir, target.path), code });
          else removed.push(path.relative(runDir, target.path));
        }
      }
      if (!guard()) {
        for (const dir of items.emptyDirs) {
          try {
            fs.rmdirSync(dir);
            removed.push(path.relative(runDir, dir));
          } catch {
            // Not empty (kept entries) or already gone.
          }
        }
      }
    }
    const complete = !abandoned && failed.length === 0 && items.unrecognized.length === 0 && items.unsafe.length === 0 && (closing || (items.stateDigest === null || stateAccepted));
    if (complete && !guard()) {
      // The marker is the proof of identity for a retry, so it goes only after the receipt records that removal began,
      // and the claim goes last so a wrapper cannot start between the marker and the directory.
      writeReceiptReplacing(receiptFile, { ...receipt, closing: { at: new Date().toISOString() } });
      closingWritten = true;
      for (const control of [path.join(runDir, OWNER), path.join(runDir, MARKER)]) {
        const code = removeEntry(control);
        if (code) failed.push({ path: path.relative(runDir, control), code });
        else removed.push(path.relative(runDir, control));
      }
      if (failed.length === 0) {
        const code = removeEntry(path.join(runDir, FLAG));
        if (code) failed.push({ path: FLAG, code });
        else {
          finished = true;
          try {
            fs.rmdirSync(runDir);
          } catch (error) {
            if (error.code !== 'ENOENT') failed.push({ path: '.', code: error.code ?? 'error' });
          }
        }
      }
    }
    const view = { ...receipt, closing: receipt.closing ?? (closingWritten ? { at: 'now' } : undefined) };
    const final = observeRun(view, { deep: false, accept, flagNonce: finished ? null : flagNonce });
    const actions = { removed, failed };
    if (final.status === 'already_gone' && failed.length === 0 && !abandoned) {
      closeReceipt(receipt, receiptFile, evidence, accept ? acceptRef : null);
      return { ...final, status: 'reclaimed', reason: 'reclaimed', detail: 'removed by this call and verified absent', actions };
    }
    if (final.status === 'already_gone') return { ...final, status: 'blocked', reason: 'remove_failed', detail: 'the directory changed while this call was removing it; run the same call again to verify', actions };
    if (abandoned && final.status === 'blocked') {
      return { ...final, reason: abandoned, reclaimable: final.reclaimable === false ? false : 'partial', detail: 'the run changed while it was being reclaimed (lock, wrapper, or state); nothing further was removed, run the same call again', actions };
    }
    if (failed.length > 0 && final.status === 'blocked') {
      return { ...final, reason: 'remove_failed', detail: 'some entries could not be removed; fix the cause and run the same call again', actions };
    }
    return { ...final, actions };
  } finally {
    if (!finished) releaseFlag(runDir, flagNonce);
  }
}

function closeReceipt(receipt, receiptFile, evidence, acceptRef = null) {
  const { closing: _closing, ...rest } = receipt;
  writeReceiptReplacing(receiptFile, { ...rest, closed: { at: new Date().toISOString(), ...(acceptRef ? { acceptRef } : {}), evidence: { path: evidence.path, bytes: evidence.bytes, sha256: evidence.sha256 } } });
}

// ---------------------------------------------------------------------------------------------------------------------
// Commands

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['init', 'list', 'check', 'reclaim', 'preserve'].includes(command)) throw new CliError('usage', 'usage: e2e-resources.mjs init|list|check|reclaim|preserve --objective <id> --receipt <abs> [...]');
  const options = { receipts: [], apply: false, clear: false };
  const valued = new Map([['--objective', 'objective'], ['--run-dir', 'runDir'], ['--evidence', 'evidence'], ['--accept-state', 'acceptState'], ['--accept-ref', 'acceptRef'], ['--request-ref', 'requestRef'], ['--keeper', 'keeper'], ['--release', 'release']]);
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--apply') options.apply = true;
    else if (flag === '--clear') options.clear = true;
    else if (flag === '--json') continue;
    else if (flag === '--receipt') {
      const value = rest[(i += 1)];
      if (value === undefined) throw new CliError('usage', '--receipt needs a value');
      options.receipts.push(value);
    } else if (valued.has(flag)) {
      const value = rest[(i += 1)];
      if (value === undefined) throw new CliError('usage', `${flag} needs a value`);
      if (options[valued.get(flag)] !== undefined) throw new CliError('usage', `${flag} given twice`);
      options[valued.get(flag)] = value;
    } else throw new CliError('usage', `unknown argument ${JSON.stringify(flag).slice(0, 40)}`);
  }
  if (!options.objective || !OBJECTIVE.test(options.objective)) throw new CliError('usage', '--objective is required and must be a plain id');
  if (options.receipts.length === 0) throw new CliError('usage', '--receipt is required');
  if (new Set(options.receipts).size !== options.receipts.length) throw new CliError('usage', 'a receipt was given twice');
  const only = (names) => {
    const given = { runDir: '--run-dir', evidence: '--evidence', acceptState: '--accept-state', acceptRef: '--accept-ref', requestRef: '--request-ref', keeper: '--keeper', release: '--release' };
    for (const [key, flag] of Object.entries(given)) if (options[key] !== undefined && !names.includes(key)) throw new CliError('usage', `${flag} does not apply to ${command}`);
    if (options.apply && command !== 'reclaim') throw new CliError('usage', `--apply does not apply to ${command}`);
    if (options.clear && command !== 'preserve') throw new CliError('usage', `--clear does not apply to ${command}`);
  };
  if (command === 'init') {
    only(['runDir']);
    if (!options.runDir) throw new CliError('usage', 'init needs --run-dir');
    if (options.receipts.length !== 1) throw new CliError('usage', 'init takes exactly one --receipt');
  } else if (command === 'reclaim') {
    only(['evidence', 'acceptState', 'acceptRef']);
    if ((options.acceptState === undefined) !== (options.acceptRef === undefined)) throw new CliError('usage', '--accept-state and --accept-ref go together: the digest names exactly what was reviewed, the ref names the separate authority over it');
    if (options.acceptState !== undefined) {
      if (!options.apply || !/^[0-9a-f]{64}$/.test(options.acceptState)) throw new CliError('usage', '--accept-state takes the 64-hex stateDigest of a fresh list, and only with --apply');
      if (options.receipts.length !== 1) throw new CliError('usage', '--accept-state is valid for exactly one --receipt; a digest never selects state in several runs');
      if (options.acceptRef.trim().length === 0 || options.acceptRef.length > 500 || /[\u0000-\u001f\u007f]/.test(options.acceptRef)) throw new CliError('usage', '--accept-ref is required (1-500 printable characters)');
    }
    if (options.apply && !options.evidence) throw new CliError('evidence_required', '--apply needs --evidence <abs-file> outside the run');
    if (!options.apply && options.evidence) throw new CliError('usage', '--evidence is only used with --apply');
  } else if (command === 'preserve') {
    only(['requestRef', 'keeper', 'release']);
    if (options.receipts.length !== 1) throw new CliError('usage', 'preserve takes exactly one --receipt');
    const fields = options.clear ? ['requestRef'] : ['requestRef', 'keeper', 'release'];
    for (const key of fields) {
      const value = options[key];
      if (typeof value !== 'string' || value.trim().length === 0 || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new CliError('usage', `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required (1-500 printable characters)`);
      }
    }
    if (options.clear && (options.keeper !== undefined || options.release !== undefined)) throw new CliError('usage', '--clear takes only --request-ref');
  } else only([]);
  return { command, options };
}

function commandInit(options) {
  requireUid();
  const identity = process.env.FLEET_CONSOLE_WORKSPACE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID;
  if (!identity) throw new CliError('no_caller_identity', 'refusing to create a run without a Fleet or Claude Code session id');
  const runDir = options.runDir;
  const layout = runLayout(runDir);
  const problem = ancestorProblem(layout);
  if (problem === 'absent') throw new CliError('outside_allowed_root', '<main checkout>/.fleet does not exist; this command does not create it');
  if (problem) throw new CliError(problem === 'symlink_component' ? 'symlink_component' : 'outside_allowed_root', `run directory ancestors are not acceptable (${problem})`);
  const receiptFile = options.receipts[0];
  checkReceiptLocation(receiptFile);
  if (inside(receiptFile, runDir) || inside(receiptFile, layout.fleetDir)) throw new CliError('receipt_invalid', 'the receipt must live outside <main checkout>/.fleet');
  if (lstatOrNull(receiptFile)) throw new CliError('receipt_exists', 'the receipt path already exists');
  if (lstatOrNull(runDir)) throw new CliError('path_exists', 'the run directory already exists; an existing path is never adopted');
  const sunPath = { darwin: 103, linux: 107 }[process.platform];
  const socket = path.join(runDir, 'tmp', `tsx-${UID}`, '9999999.pipe');
  if (sunPath && Buffer.byteLength(socket) > sunPath) throw new CliError('path_too_long', `run directory is too long for the wrapper's tsx socket (${Buffer.byteLength(socket)} > ${sunPath} bytes)`);

  fs.mkdirSync(runDir, { mode: 0o700 }); // Not recursive: EEXIST means someone else created it first.
  const stat = fs.lstatSync(runDir, { bigint: true });
  const created = { path: runDir, dev: String(stat.dev), ino: String(stat.ino) };
  const nonce = randomBytes(32).toString('hex');
  const runId = randomBytes(16).toString('hex');
  const creator = callerHash();
  try {
    fs.writeFileSync(path.join(runDir, MARKER), `${JSON.stringify({ schema: SCHEMA, runId, nonce })}\n`, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(runDir, OWNER), `${creator}\n`, { flag: 'wx', mode: 0o600 });
    const receipt = { schema: SCHEMA, kind: 'e2e-run', objective: options.objective, runId, nonce, createdAt: new Date().toISOString(), uid: UID, creator, runDir: created };
    fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    // Only the directory this call just created, and only while it is still that directory and holds only what it wrote.
    const now = lstatOrNull(runDir, { bigint: true });
    if (now && String(now.ino) === created.ino && String(now.dev) === created.dev) {
      for (const name of [MARKER, OWNER]) fs.rmSync(path.join(runDir, name), { force: true });
      try { fs.rmdirSync(runDir); } catch { /* Something else appeared; leave it. */ }
    }
    throw new CliError('init_failed', `could not finish creating the run (${error.code ?? 'error'}); the new directory was removed`);
  }
  return {
    objective: options.objective,
    runDir,
    receipt: receiptFile,
    runId,
    next: 'pass --run-dir to isolated-env.mjs; hand the receipt path only to the Commander that reclaims this objective',
    delegated: DELEGATED,
  };
}

function view(receipt, observed, mode) {
  const { observed: _internal, ...rest } = observed;
  const resource = { ...rest };
  if (mode === 'check') delete resource.inventory;
  return { runId: receipt.runId, createdAt: receipt.createdAt, resources: [resource] };
}

function summarize(results) {
  const summary = { reclaimed: 0, already_gone: 0, preserved: 0, blocked: 0, errors: 0 };
  const unexpected = [];
  const preserved = [];
  let exit = 0;
  for (const result of results) {
    if (result.error) {
      summary.errors += 1;
      exit = 2;
      continue;
    }
    for (const resource of result.resources) {
      summary[resource.status] += 1;
      if (resource.status === 'blocked') {
        unexpected.push({ receipt: result.receipt, path: resource.path, reason: resource.reason, remaining: resource.remaining ?? [resource.path] });
        if (exit === 0) exit = 1;
      } else if (resource.status === 'preserved') {
        preserved.push({ receipt: result.receipt, path: resource.path, requestRef: resource.preserved.requestRef, keeper: resource.preserved.keeper, release: resource.preserved.release, remaining: resource.remaining });
      }
    }
  }
  return { summary, unexpected, preserved, complete: exit === 0, exit };
}

function processReceipt(command, options, receiptFile) {
  try {
    requireUid();
    const receipt = readReceipt(receiptFile);
    if (receipt.objective !== options.objective) throw new CliError('objective_mismatch', 'the receipt belongs to another objective; nothing was read further or changed');
    let observed;
    if (command === 'preserve') {
      observed = commandPreserve(receipt, receiptFile, options);
    } else if (command === 'reclaim' && options.apply) {
      const evidence = checkEvidence(options.evidence, receipt.runDir.path);
      observed = applyReclaim(receipt, receiptFile, evidence, options.acceptState ?? null, options.acceptRef ?? null);
      observed.evidence = { path: evidence.path, bytes: evidence.bytes, sha256: evidence.sha256, note: 'recorded, not permission to remove data this tool does not recognise' };
    } else {
      observed = observeRun(receipt, { deep: command === 'list', accept: null });
    }
    const out = view(receipt, observed, command);
    out.receipt = receiptFile;
    out.objective = receipt.objective;
    if (observed.actions) out.resources[0].actions = observed.actions;
    if (observed.evidence) out.resources[0].evidence = observed.evidence;
    return out;
  } catch (error) {
    if (error instanceof CliError) return { receipt: receiptFile, error: { code: error.code, message: error.message } };
    throw error;
  }
}

function commandPreserve(receipt, receiptFile, options) {
  const current = observeRun(receipt, { deep: false });
  if (current.status === 'already_gone') throw new CliError('nothing_to_preserve', 'the run no longer exists');
  if (current.status === 'blocked' && ['path_replaced', 'marker_mismatch', 'owner_mismatch', 'symlink_component', 'foreign_owner', 'outside_allowed_root', 'main_checkout_unverified'].includes(current.reason)) {
    throw new CliError('identity_mismatch', `refusing to preserve a path that is not the recorded run (${current.reason})`);
  }
  if (options.clear) {
    if (!receipt.preserved) throw new CliError('not_preserved', 'this run has no preservation to clear');
    const { preserved: _gone, ...rest } = receipt;
    writeReceiptReplacing(receiptFile, { ...rest, preservationCleared: { at: new Date().toISOString(), requestRef: options.requestRef.trim(), previous: receipt.preserved } });
    return observeRun({ ...rest }, { deep: false });
  }
  const preserved = { requestRef: options.requestRef.trim(), keeper: options.keeper.trim(), release: options.release.trim(), at: new Date().toISOString() };
  writeReceiptReplacing(receiptFile, { ...receipt, preserved });
  return observeRun({ ...receipt, preserved }, { deep: false });
}

export function run(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof CliError) return { exit: 2, document: { schemaVersion: SCHEMA, error: { code: error.code, message: error.message } } };
    throw error;
  }
  const { command, options } = parsed;
  if (command === 'init') {
    try {
      return { exit: 0, document: { schemaVersion: SCHEMA, command, ...commandInit(options) } };
    } catch (error) {
      if (error instanceof CliError) return { exit: 2, document: { schemaVersion: SCHEMA, command, error: { code: error.code, message: error.message } } };
      throw error;
    }
  }
  const results = options.receipts.map((file) => processReceipt(command, options, file));
  const { summary, unexpected, preserved, complete, exit } = summarize(results);
  const mode = command === 'reclaim' ? (options.apply ? 'apply' : 'plan') : command;
  return { exit, document: { schemaVersion: SCHEMA, command, mode, objective: options.objective, results, summary, unexpected, preserved, complete, delegated: DELEGATED, exit } };
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const { exit, document } = run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  if (exit === 2) process.stderr.write(`e2e-resources: ${document.error?.message ?? 'call or authority error; see the result'}\n`);
  // Not process.exit: a large document on a pipe would be cut off. Nothing is left pending, so the process ends by itself.
  process.exitCode = exit;
}
