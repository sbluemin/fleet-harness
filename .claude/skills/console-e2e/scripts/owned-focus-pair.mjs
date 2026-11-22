#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readOwnedRunReceipt } from './e2e-resources.mjs';
import { callerHash } from './isolated-env.mjs';

const here = fileURLToPath(import.meta.url);
const sibling = (name) => path.join(path.dirname(here), name);
const roles = ['stand-in', 'target'];
const markerPattern = /^[A-Za-z0-9_-]{1,20}$/;
const tupleKeys = ['runId', 'role', 'pid', 'startedAt', 'windowId'];
const tupleMatches = (a, b) => a && b && tupleKeys.every((key) => a[key] === b[key]);
const signs = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const usage = `node ${path.basename(here)} <check|start|status|focus|input|stop> --objective <id> --run-dir <abs> --receipt <abs>
  start: --allow-activate (managed command; stays running until stop)
  focus: --role <stand-in|target> --pid <pid> --started-at <seconds.microseconds> --window-id <id> --allow-activate
  input: same four identity flags, plus --marker <1–20 ASCII letters, digits, underscores or hyphens>
  stop: stops only this run's pair; a repeat reads the prior stop result without targeting a process`;

function refuse(code) {
  throw Object.assign(new Error(code), { code });
}

function deadline(promise, ms, code) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms);
  })]).finally(() => clearTimeout(timer));
}

function childOf(file, args, options) {
  const proc = spawn(file, args, options);
  const child = { proc, outcome: null };
  child.done = new Promise((resolve) => {
    const finish = (outcome) => { child.outcome = outcome; resolve(outcome); };
    proc.once('error', (error) => finish({ error: error.code ?? 'spawn_failed' }));
    proc.once('exit', (code, signal) => finish({ code, signal }));
  });
  return child;
}

function launchWindow(binary, runId, role) {
  const child = childOf(binary, [runId, role], { stdio: ['pipe', 'pipe', 'inherit'] });
  const { proc } = child;
  proc.stdin.on('error', () => {}); // A failed child can close its pipe while a request is in flight.
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
  let channelFailed = false;
  return {
    role,
    pid: proc.pid,
    get outcome() { return child.outcome; },
    done: child.done,
    closeLease: () => proc.stdin.end(),
    async send(request) {
      if (child.outcome || channelFailed) refuse('fixture_channel_unavailable');
      let reply;
      try {
        proc.stdin.write(`${JSON.stringify(request)}\n`);
        const line = await deadline(lines.next(), 1500, 'fixture_reply_timeout');
        if (line.done) refuse('fixture_channel_ended');
        reply = JSON.parse(line.value);
      } catch (error) {
        channelFailed = true; // A late reply can never be mistaken for a different request.
        throw error;
      }
      if (reply.error) refuse(reply.error);
      return reply;
    },
  };
}

// Keep each launched role tied to its private pipe; receipt contents never select a PID to signal.
export function createPair(runId, launch) {
  const members = new Map();
  const entries = () => [...members.values()];
  const observe = async (member) => {
    const { child, identity } = member;
    const { snapshot } = await child.send({ action: 'snapshot', expected: identity });
    const actual = snapshot?.identity;
    if (actual?.pid !== child.pid || actual?.role !== child.role || actual?.runId !== runId ||
        !/^\d+\.\d{6}$/.test(actual?.startedAt) || !Number.isInteger(actual?.windowId) || actual.windowId <= 0 ||
        (identity && !tupleMatches(identity, actual))) refuse('fixture_identity_mismatch');
    member.identity ??= actual;
    return snapshot;
  };
  return {
    async prepare() {
      for (const role of roles) {
        const member = { child: launch(role) };
        members.set(role, member);
        for (let i = 0; ; i++) {
          try { await observe(member); break; } catch (error) {
            if (i >= 30 || error.code !== 'window_ownership_unverified') throw error;
            await delay(100);
          }
        }
      }
      const [a, b] = entries().map(({ identity }) => identity);
      if (a.pid === b.pid || a.windowId === b.windowId) refuse('fixtures_not_distinct');
    },
    async status() { return Promise.all(entries().map(observe)); },
    async act(action, expected, marker) {
      const member = members.get(expected?.role);
      if (!tupleMatches(expected, member?.identity)) refuse('fixture_identity_mismatch');
      return member.child.send({ action, expected, marker }); // Swift checks the tuple again on its main thread.
    },
    async stop() {
      // Precheck every live member before requesting either one to exit.
      await Promise.all(entries().filter(({ child }) => !child.outcome).map(observe));
      for (const { child, identity } of entries()) {
        if (child.outcome) continue;
        const reply = await child.send({ action: 'stop', expected: identity });
        if (reply.stopping !== true) refuse('fixture_stop_unconfirmed');
      }
      return this.collect();
    },
    async abort() {
      for (const { child } of entries()) child.closeLease();
      return this.collect();
    },
    async collect() {
      return Promise.all(entries().map(async ({ child, identity }) => ({
        role: child.role, identity: identity ?? null, pid: child.pid ?? null,
        exit: await deadline(child.done, 4000, 'fixture_exit_unverified'),
      })));
    },
  };
}

function probeScreen() {
  // Reuse only the existing read-only check, never its click/post path.
  const probe = spawnSync(process.execPath, [sibling('os-mouse.mjs'), 'check', '--json'], { encoding: 'utf8', timeout: 12000 });
  if (![0, 10].includes(probe.status)) refuse('screen_preflight_failed');
  const { screenLocked, accessibilityTrusted, error } = JSON.parse(probe.stdout);
  return { screenLocked, accessibilityTrusted, error: error ?? null };
}

function validateArgs(argv) {
  const [action, ...args] = argv;
  const common = ['--objective', '--run-dir', '--receipt'];
  const target = ['--role', '--pid', '--started-at', '--window-id'];
  const extra = { check: [], start: ['--allow-activate'], status: [], focus: [...target, '--allow-activate'], input: [...target, '--marker'], stop: [] };
  if (!Object.hasOwn(extra, action)) refuse('usage');
  const required = [...common, ...extra[action]];
  const flags = new Map();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!required.includes(flag) || flags.has(flag)) refuse('usage');
    const value = flag === '--allow-activate' ? true : args[++i];
    if (!value || (typeof value === 'string' && value.startsWith('--'))) refuse('usage');
    flags.set(flag, value);
  }
  if (flags.size !== required.length) refuse('usage');
  let expected;
  if (flags.has('--role')) {
    const [, pid, startedAt, windowId] = target.map((key) => flags.get(key));
    const role = flags.get('--role');
    if (!roles.includes(role) || !/^[1-9]\d{0,9}$/.test(pid) || Number(pid) > 0x7fffffff ||
        !/^\d+\.\d{6}$/.test(startedAt) || !/^[1-9]\d{0,9}$/.test(windowId) || Number(windowId) > 0xffffffff) refuse('invalid_identity');
    expected = { role, pid: Number(pid), startedAt, windowId: Number(windowId) };
  }
  const marker = flags.get('--marker');
  if (marker && !markerPattern.test(marker)) refuse('invalid_marker');
  return { action, objective: flags.get('--objective'), runDir: flags.get('--run-dir'), receiptFile: flags.get('--receipt'), expected, marker };
}

function readLine(socket) {
  return new Promise((resolve, reject) => {
    let data = '';
    const cleanup = () => {
      socket.off('data', receive);
      socket.off('close', closed);
    };
    const closed = () => { cleanup(); reject(Object.assign(new Error('control_channel_closed'), { code: 'control_channel_closed' })); };
    const receive = (chunk) => {
      data += chunk;
      if (data.length > 4096 || data.includes('\n')) {
        cleanup();
        if (data.length > 4096 || data.indexOf('\n') !== data.length - 1) {
          reject(Object.assign(new Error('invalid_control_frame'), { code: 'invalid_control_frame' }));
        } else {
          try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
        }
      }
    };
    socket.on('data', receive);
    socket.once('close', closed);
  });
}

const writeLine = (socket, value) => socket.write(`${JSON.stringify(value)}\n`);
const proof = (nonce, challenge, body) => createHmac('sha256', nonce).update(JSON.stringify([challenge, body])).digest('hex');
const checkProof = (signature, want) => typeof signature === 'string' && /^[0-9a-f]{64}$/.test(signature) &&
  timingSafeEqual(Buffer.from(signature), Buffer.from(want));
const controlPath = (runDir) => path.join(runDir, 'tmp', 'focus.sock');
const stopPath = (runDir) => path.join(runDir, 'tmp', 'focus-stopped.json');

function stopResult(receipt) {
  const file = stopPath(receipt.runDir.path);
  const dir = path.dirname(file);
  const tmp = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!tmp) return null;
  if (!tmp.isDirectory() || tmp.uid !== receipt.uid || (tmp.mode & 0o077) !== 0 || fs.realpathSync(dir) !== dir) {
    refuse('run_tmp_unverified');
  }
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.uid !== receipt.uid || stat.size > 4096 || (stat.mode & 0o077) !== 0) refuse('stop_record_unverified');
  const { body, sig } = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (body?.runId !== receipt.runId || !checkProof(sig, proof(receipt.nonce, 'stopped', body))) refuse('stop_record_unverified');
  return body;
}

async function buildWindow(buildDir, runId) {
  const binary = path.join(buildDir, 'owned-focus-window');
  const compiler = childOf('/usr/bin/swiftc', ['-parse-as-library', '-module-cache-path', path.join(buildDir, 'cache'),
    '-o', binary, sibling('owned-focus-window.swift')], { stdio: ['ignore', 'inherit', 'inherit'] });
  if ((await compiler.done).code !== 0) refuse('fixture_build_failed');
  return (role) => launchWindow(binary, runId, role);
}

export async function servePair(opts, creator, build = buildWindow, report = emit) {
  const { runDir, receiptFile } = opts;
  const readReceipt = () => readOwnedRunReceipt(receiptFile, { ...opts, creator });
  const receipt = readReceipt();
  if (stopResult(receipt)) refuse('run_already_stopped');
  let buildDir, pair, ready = false, busy = false, cancelled = false, closeWait, exited = false;
  const socketPath = controlPath(runDir);
  const wrapperPid = process.ppid;
  const income = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    income.add(socket);
    socket.on('close', () => income.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(10000, () => socket.destroy());
    void handle(socket);
  });
  const serverClosed = new Promise((resolve) => server.once('close', resolve));
  const close = () => closeWait ??= new Promise((resolve) => server.close(resolve));
  const cancel = () => { cancelled = true; for (const socket of income) socket.destroy(); void close(); };
  const record = (outcome, windows) => {
    const body = { runId: receipt.runId, outcome, windows };
    fs.writeFileSync(stopPath(runDir), `${JSON.stringify({ body, sig: proof(receipt.nonce, 'stopped', body) })}\n`, { flag: 'wx', mode: 0o600 });
    return body;
  };
  async function handle(socket) {
    const challenge = randomBytes(32).toString('hex');
    let response;
    let reserved = false;
    try {
      const reading = readLine(socket);
      writeLine(socket, challenge);
      const { request, sig } = await reading;
      const current = readReceipt();
      if (current.runId !== receipt.runId || current.nonce !== receipt.nonce ||
          !checkProof(sig, proof(receipt.nonce, challenge, request))) refuse('control_run_mismatch');
      if (!ready || cancelled || busy) refuse('pair_not_ready_or_busy');
      reserved = busy = true;
      if (request.action === 'status') {
        response = { runId: receipt.runId, windows: await pair.status() };
      } else if (request.action === 'focus' && request.allowActivate === true) {
        await pair.act('focus', request.expected);
        response = { activationRequested: true, windows: await pair.status() };
      } else if (request.action === 'input' && markerPattern.test(request.marker ?? '')) {
        const reply = await pair.act('input', request.expected, request.marker);
        if (reply.posted !== true) refuse('fixture_post_unconfirmed');
        response = { posted: true, delivery: 'unverified' };
      } else if (request.action === 'stop') {
        const windows = await pair.stop();
        exited = true;
        ready = false;
        void close();
        response = record('stopped', windows);
      } else refuse('invalid_control_request');
    } catch (error) {
      response = { error: error.code ?? 'control_failed' };
    } finally {
      if (reserved) busy = false;
      socket.end(`${JSON.stringify({ response, sig: proof(receipt.nonce, challenge, response) })}\n`);
    }
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  for (const signal of signs) process.on(signal, cancel);
  const watch = setInterval(() => { if (process.ppid !== wrapperPid) cancel(); }, 500);
  try {
    fs.chmodSync(socketPath, 0o600);
    if (stopResult(receipt)) refuse('run_already_stopped');
    buildDir = fs.mkdtempSync(path.join(runDir, 'tmp', 'focus-build-'));
    const launch = await build(buildDir, receipt.runId);
    if (cancelled) refuse('start_cancelled');
    readReceipt();
    pair = createPair(receipt.runId, launch);
    await pair.prepare();
    const windows = await pair.status();
    if (cancelled) refuse('start_cancelled');
    ready = true;
    report({ runId: receipt.runId, state: 'ready', windows });
    // Wait for verified stop or for the isolated wrapper/runner to cancel this invocation.
    await serverClosed;
    if (cancelled && !exited) {
      const stopped = await pair.abort();
      exited = true;
      report(record('cancelled', stopped));
    }
  } catch (error) {
    cancel();
    if (pair && !exited) {
      const stopped = await pair.abort();
      exited = true;
      report(record('start_failed', stopped));
    }
    throw error;
  } finally {
    clearInterval(watch);
    for (const signal of signs) process.off(signal, cancel);
    await close();
    if (buildDir && (!pair || exited)) fs.rmSync(buildDir, { recursive: true });
  }
}

export async function requestControl(opts) {
  const receipt = readOwnedRunReceipt(opts.receiptFile, opts);
  if (opts.action === 'stop') {
    const stopped = stopResult(receipt);
    if (stopped) return { ...stopped, alreadyStopped: true };
  }
  const file = controlPath(opts.runDir);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isSocket() || stat.uid !== receipt.uid || (stat.mode & 0o077) !== 0 || fs.realpathSync(path.dirname(file)) !== path.dirname(file)) {
    refuse('control_socket_unavailable_or_unverified');
  }
  const request = { action: opts.action, expected: opts.expected && { ...opts.expected, runId: receipt.runId },
    allowActivate: opts.action === 'focus', marker: opts.marker };
  const socket = net.createConnection(file);
  socket.on('error', () => socket.destroy());
  socket.setTimeout(10000, () => socket.destroy());
  try {
    const challenge = await readLine(socket);
    if (typeof challenge !== 'string' || !/^[0-9a-f]{64}$/.test(challenge)) refuse('invalid_control_challenge');
    const waiting = readLine(socket);
    writeLine(socket, { request, sig: proof(receipt.nonce, challenge, request) });
    const { response, sig } = await waiting;
    if (!checkProof(sig, proof(receipt.nonce, challenge, response))) refuse('control_response_unverified');
    if (response.error) refuse(response.error);
    return response;
  } finally { socket.destroy(); }
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') { process.stdout.write(`${usage}\n`); return 0; }
  if (process.platform !== 'darwin') refuse('unsupported_platform');
  if (argv[0] === '_serve' && argv.length === 5) {
    const [, objective, runDir, receiptFile, creator] = argv;
    if (process.env.HOME !== path.join(runDir, 'home') || process.env.TMPDIR !== path.join(runDir, 'tmp') ||
        fs.realpathSync(process.env.HOME) !== process.env.HOME || fs.realpathSync(process.env.TMPDIR) !== process.env.TMPDIR ||
        !fs.existsSync(path.join(runDir, `.e2e-active.${process.ppid}`))) refuse('run_environment_not_isolated');
    await servePair({ objective, runDir, receiptFile }, creator);
    return 0;
  }
  const opts = validateArgs(argv);
  if (!process.env.FLEET_CONSOLE_WORKSPACE_SESSION_ID && !process.env.CLAUDE_CODE_SESSION_ID) refuse('no_caller_identity');
  const { action, objective, runDir, receiptFile } = opts;
  const receipt = readOwnedRunReceipt(receiptFile, opts);
  if (action === 'check' || action === 'start') {
    const probe = probeScreen();
    if (action === 'check') {
      emit({ runId: receipt.runId, ...probe, posted: false, fixturePostEventAccessChecked: false });
      return probe.screenLocked === false && !probe.error ? 0 : 10;
    }
    if (probe.screenLocked !== false || probe.error) refuse('screen_locked_or_unverified');
    const args = [sibling('isolated-env.mjs'), '--run-dir', runDir, '--', process.execPath, here,
      '_serve', objective, runDir, receiptFile, callerHash()];
    const check = spawnSync(process.execPath, [args[0], '--check', ...args.slice(1)], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 12000 });
    if (check.status !== 0) refuse('isolation_check_refused');
    const child = childOf(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    const handlers = signs.map((signal) => () => child.proc.kill(signal));
    signs.forEach((signal, i) => process.on(signal, handlers[i]));
    const outcome = await child.done;
    signs.forEach((signal, i) => process.off(signal, handlers[i]));
    return outcome.code ?? 1;
  }
  emit(await requestControl(opts, receipt));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === here) {
  try { process.exitCode = await main(process.argv.slice(2)); } catch (error) {
    emit({ error: error.code ?? 'fixture_failed' });
    if (error.code === 'usage') process.stderr.write(`${usage}\n`);
    process.exitCode = ['screen_locked_or_unverified', 'post_event_access_denied'].includes(error.code) ? 10 : 2;
  }
}
