#!/usr/bin/env node
/**
 * Shared OS mouse helper for references/desktop/os-mouse.md.
 *
 *   node os-mouse.mjs compile --out <abs-binary>
 *   node os-mouse.mjs check [--json]
 *   node os-mouse.mjs click --binary <abs-binary> --pid <owned-main-pid>
 *     --origin <cg-x>,<cg-y> --dip <x>,<y> [--dip <x>,<y> ...]
 *     --max-clicks <n> --allow-activate
 *
 * compile writes the sibling Swift program and a `<binary>.stamp` source hash.
 * It never runs the binary. check is read-only (screen lock and Accessibility
 * for this osascript probe). It does not call desktop-preflight, does not read
 * Screen Recording, and does not raise a permission dialog. click posts only
 * after those gates plus the owned-window PID check. A returned post is not
 * delivery and not a reaction.
 *
 * Exit 1 is a helper failure. For click, exit 2 is a refusal and exit 10 means
 * the readiness check did not pass. A click that already posted earlier points
 * stops there instead of continuing.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const swiftPath = path.join(scriptDir, 'os-mouse.swift');
const CHECK_NOTE = 'preflight exit 0 is not this check';

const CHECK_SOURCE = `function run() {
  ObjC.import('CoreGraphics');
  ObjC.import('ApplicationServices');
  var screenLocked = null;
  var accessibilityTrusted = null;
  var error = null;
  try {
    var session = ObjC.deepUnwrap(ObjC.castRefToObject($.CGSessionCopyCurrentDictionary()));
    var sessionKeyCount = session ? Object.keys(session).length : 0;
    screenLocked = sessionKeyCount > 0 ? Boolean(session.CGSSessionScreenIsLocked) : null;
  } catch (e) { error = String(e); }
  try {
    accessibilityTrusted = Boolean($.AXIsProcessTrusted());
  } catch (e) {
    accessibilityTrusted = null;
    error = error || String(e);
  }
  return JSON.stringify({ screenLocked: screenLocked, accessibilityTrusted: accessibilityTrusted, error: error });
}`;

const WINDOW_SOURCE = `function run(argv) {
  ObjC.import('CoreGraphics');
  var x = Number(argv[0]);
  var y = Number(argv[1]);
  if (!isFinite(x) || !isFinite(y)) return JSON.stringify({ pid: null, error: 'bad point' });
  var list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0));
  var count = Number(list.count);
  for (var i = 0; i < count; i++) {
    var item = ObjC.deepUnwrap(list.objectAtIndex(i));
    if (Number(item.kCGWindowLayer) < 0) continue;
    var alpha = item.kCGWindowAlpha;
    if (!(Number(alpha == null ? 1 : alpha) > 0)) continue;
    var bounds = item.kCGWindowBounds;
    var left = Number(bounds.X);
    var top = Number(bounds.Y);
    var right = left + Number(bounds.Width);
    var bottom = top + Number(bounds.Height);
    if (x >= left && y >= top && x < right && y < bottom) {
      return JSON.stringify({ pid: Number(item.kCGWindowOwnerPID) });
    }
  }
  return JSON.stringify({ pid: null });
}`;

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function sourceHash() {
  return createHash('sha256').update(readFileSync(swiftPath)).digest('hex');
}

function resolveExisting(target) {
  let ancestor = path.resolve(target);
  const suffix = [];
  for (;;) {
    try { return path.join(realpathSync(ancestor), ...suffix); } catch (error) {
      if (error.code !== 'ENOENT' || ancestor === path.dirname(ancestor)) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
}

function forbiddenRoots() {
  const listed = spawnSync('git', ['-C', scriptDir, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8', timeout: 10_000,
  });
  if (listed.error) throw listed.error;
  if (listed.status !== 0) throw new Error(`git worktree list failed: ${listed.stderr || listed.status}`);
  const roots = [];
  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('worktree ')) roots.push(line.slice('worktree '.length));
  }
  if (!roots.length) throw new Error('git worktree list was empty');
  for (const home of [homedir(), userInfo().homedir]) {
    if (home) roots.push(path.join(home, '.fleet'));
  }
  return roots.map((root) => {
    try { return resolveExisting(root); } catch { return path.resolve(root); }
  });
}

function assertAllowedOutput(dest) {
  if (typeof dest !== 'string' || !path.isAbsolute(dest)) throw new Error('output path must be absolute');
  const parent = path.dirname(path.resolve(dest));
  if (!existsSync(parent)) throw new Error('output directory does not exist');
  const base = path.basename(dest);
  if (!base || base === '.' || base === '..') throw new Error('invalid output name');
  const canon = path.join(realpathSync(parent), base);
  for (const root of forbiddenRoots()) {
    if (canon === root || canon.startsWith(`${root}${path.sep}`)) throw new Error(`refusing output inside ${root}`);
  }
  if (existsSync(canon) && lstatSync(canon).isSymbolicLink()) throw new Error('refusing symlink output');
  return canon;
}

function runOsascript(source, args) {
  const child = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source, ...args], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error((child.stderr || `osascript exited ${child.status}`).trim().slice(0, 300));
  return JSON.parse(child.stdout);
}

function readInputGate() {
  if (process.platform !== 'darwin') {
    return { screenLocked: null, accessibilityTrusted: null, error: 'macOS-only' };
  }
  try {
    const gate = runOsascript(CHECK_SOURCE, []);
    return {
      screenLocked: gate.screenLocked === true ? true : gate.screenLocked === false ? false : null,
      accessibilityTrusted: gate.accessibilityTrusted === true ? true : gate.accessibilityTrusted === false ? false : null,
      error: gate.error ? String(gate.error).slice(0, 300) : null,
    };
  } catch (error) {
    return { screenLocked: null, accessibilityTrusted: null, error: String(error.message || error).slice(0, 300) };
  }
}

function gateReady(gate) {
  return gate.screenLocked === false && gate.accessibilityTrusted === true && !gate.error;
}

function checkReport(gate) {
  return {
    stage: 'check',
    screenLocked: gate.screenLocked,
    accessibilityTrusted: gate.accessibilityTrusted,
    screenRecordingChecked: false,
    postBinaryChecked: false,
    posted: false,
    probeExecutable: process.platform === 'darwin' ? '/usr/bin/osascript' : null,
    ...(gate.error ? { error: gate.error } : {}),
  };
}

function compile(argv) {
  let out;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--out' && out === undefined) {
      out = argv[i + 1];
      if (!out || out.startsWith('--')) throw new Error('--out needs a path');
      i += 1;
      continue;
    }
    throw new Error(`unknown or repeated argument: ${flag}`);
  }
  if (!out) throw new Error('--out is required');
  const binary = assertAllowedOutput(out);
  const hash = sourceHash();
  const stamp = `${binary}.stamp`;
  const reusable = existsSync(binary) && existsSync(stamp)
    && lstatSync(binary).isFile() && !lstatSync(binary).isSymbolicLink()
    && readFileSync(stamp, 'utf8').trim() === hash;
  if (!reusable) {
    const tmp = `${binary}.${process.pid}.compile`;
    const compiled = spawnSync('/usr/bin/swiftc', ['-O', '-o', tmp, swiftPath], {
      encoding: 'utf8', timeout: 120_000,
    });
    if (compiled.status !== 0) {
      if (existsSync(tmp)) unlinkSync(tmp);
      throw new Error((compiled.stderr || `swiftc exited ${compiled.status}`).trim().slice(0, 500));
    }
    try {
      renameSync(tmp, binary);
      writeFileSync(stamp, `${hash}\n`);
    } catch (error) {
      if (existsSync(tmp)) unlinkSync(tmp);
      throw error;
    }
  }
  emit({ stage: 'compile', binary, stamp, ran: false, reused: reusable });
  process.stderr.write('os-mouse: compile exit 0; binary not run\n');
  return 0;
}

function check() {
  process.stderr.write(`${CHECK_NOTE}\n`);
  const gate = readInputGate();
  emit(checkReport(gate));
  return gateReady(gate) ? 0 : 10;
}

function parsePair(value, flag) {
  const match = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(value ?? '');
  if (!match) throw new Error(`${flag} needs <x>,<y>`);
  return [Number(match[1]), Number(match[2])];
}

function click(argv) {
  const dips = [];
  const opts = { allowActivate: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--allow-activate' && !opts.allowActivate) { opts.allowActivate = true; continue; }
    if (flag === '--dip') {
      dips.push(parsePair(argv[i + 1], '--dip'));
      i += 1;
      continue;
    }
    if (['--binary', '--pid', '--origin', '--max-clicks'].includes(flag)) {
      if (opts[flag] !== undefined) throw new Error(`repeated argument: ${flag}`);
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      opts[flag] = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${flag}`);
  }
  if (!opts['--binary'] || !opts['--pid'] || !opts['--origin'] || !opts['--max-clicks'] || !dips.length) {
    throw new Error('--binary, --pid, --origin, at least one --dip, and --max-clicks are required');
  }
  const maxClicks = /^[1-9]\d*$/.test(opts['--max-clicks']) ? Number(opts['--max-clicks']) : NaN;
  if (!Number.isSafeInteger(maxClicks)) throw new Error('--max-clicks must be a positive integer');
  const pid = /^[1-9]\d*$/.test(opts['--pid']) ? Number(opts['--pid']) : NaN;
  if (!Number.isSafeInteger(pid)) throw new Error('--pid must be a positive integer');
  const origin = parsePair(opts['--origin'], '--origin');
  const binary = assertAllowedOutput(opts['--binary']);
  const base = {
    stage: 'click', posted: false, postedCount: 0, delivery: 'unverified', reaction: 'not-checked',
    cursorMoved: false, points: [],
  };
  const stop = (code, reason, done) => {
    emit({ ...base, posted: false, postedCount: done.length, cursorMoved: done.length > 0, points: done, reason });
    return code;
  };
  if (!opts.allowActivate) return stop(2, 'activation not allowed by this invocation', []);
  if (dips.length > maxClicks) return stop(2, 'over the click cap', []);
  let stamped = '';
  let regularFile = false;
  try {
    const stat = lstatSync(binary);
    regularFile = stat.isFile() && !stat.isSymbolicLink();
    stamped = readFileSync(`${binary}.stamp`, 'utf8').trim();
  } catch { /* a missing binary or stamp is a refusal, not a post */ }
  if (!regularFile || stamped !== sourceHash()) return stop(2, 'stamp does not match the Swift source', []);

  const gate = readInputGate();
  process.stderr.write(`${CHECK_NOTE}\n`);
  if (!gateReady(gate)) {
    emit({ ...base, ...checkReport(gate), stage: 'click', reason: 'readiness check did not pass' });
    return 10;
  }

  const posted = [];
  for (const [dipX, dipY] of dips) {
    const point = [origin[0] + dipX, origin[1] + dipY];
    const again = readInputGate();
    if (again.screenLocked !== false) return stop(posted.length ? 2 : 10, 'screen locked', posted);
    let owner;
    try { owner = runOsascript(WINDOW_SOURCE, point.map(String)); } catch (error) {
      return stop(posted.length ? 2 : 1, `window probe failed: ${String(error.message || error).slice(0, 200)}`, posted);
    }
    if (owner.pid !== pid) return stop(2, 'point is not on the owned window', posted);
    const child = spawnSync(binary, point.map(String), {
      encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.error || child.status !== 0) {
      const detail = (child.stderr || child.error?.message || `post exited ${child.status}`).trim().slice(0, 200);
      return stop(posted.length ? 2 : 1, `post did not return: ${detail}`, posted);
    }
    posted.push({ cg: point, dip: [dipX, dipY], posted: true });
  }
  emit({
    ...base, posted: true, postedCount: posted.length, cursorMoved: true, points: posted,
    screenLocked: false, accessibilityTrusted: true,
  });
  process.stderr.write('os-mouse: post calls returned; delivery unverified\n');
  return 0;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'compile') return compile(rest);
  if (command === 'check') {
    if (rest.some((arg) => arg !== '--json')) throw new Error('check accepts only --json');
    return check();
  }
  if (command === 'click') return click(rest);
  throw new Error('command must be compile, check, or click');
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`os-mouse: ${error.message}\n`);
  process.exitCode = 1;
}
