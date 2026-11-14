#!/usr/bin/env node
/**
 * Ask an owned development Desktop to quit through Electron app.quit().
 *
 *   node quit-owned-desktop.mjs <inspector-port> <owned-pid> <worktree> --cdp-port <n>
 *
 * Clean quit for a lifetime claim. This is not stop-owned-desktop.mjs: it never sends
 * SIGTERM or SIGKILL and has no --force. A non-zero exit, including a timeout, means
 * the quit was not confirmed. Do not replace that result with a signal.
 *
 * Exit 0 only after <owned-pid> is gone and neither the inspector port nor the CDP port
 * still answers on loopback. A completed app.quit() evaluate is not that confirmation.
 *
 * <owned-pid> must be an init-parented Desktop main under <worktree> as selectOwnedDesktop
 * reports it. The inspector must already listen on 127.0.0.1 only, and that listener's PID
 * must be <owned-pid>. The main checkout is refused. This script does not read or write
 * HOME, a browser profile, a keychain, or a Fleet data directory.
 *
 * Exit 0 confirmed, 2 usage, 3 main checkout, 4 timed out with something still standing,
 * 1 any other refusal or failure.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mainCheckoutOf, selectOwnedDesktop } from './stop-owned-desktop.mjs';

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 20_000;

function ps() {
  return execFileSync('ps', ['-eo', 'pid,ppid,command'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function pidSet(psOutput) {
  const ids = new Set();
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s/.exec(line);
    if (match) ids.add(Number(match[1]));
  }
  return ids;
}

function portNumber(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${label}: expected a port 1–65535`);
  }
  return n;
}

function parse(argv) {
  if (argv.includes('--force') || argv.some((arg) => arg === '--signal' || /^SIG(TERM|KILL)$/i.test(arg))) {
    throw new Error('refused: this helper only calls app.quit(); it has no --force, SIGTERM, or SIGKILL');
  }
  const positionals = [];
  let cdpPort = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cdp-port') {
      if (cdpPort !== null) throw new Error('--cdp-port: pass it once');
      cdpPort = portNumber(argv[++i], '--cdp-port');
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`);
    positionals.push(arg);
  }
  if (positionals.length !== 3) {
    throw new Error('usage: quit-owned-desktop.mjs <inspector-port> <owned-pid> <worktree> --cdp-port <n>');
  }
  const [rawInspector, rawPid, worktree] = positionals;
  const inspectorPort = portNumber(rawInspector, 'inspector-port');
  const pid = Number(rawPid);
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('owned-pid: expected an integer >= 2');
  if (cdpPort === null) throw new Error('--cdp-port is required');
  if (cdpPort === inspectorPort) throw new Error('the CDP and inspector ports must differ');
  return { inspectorPort, pid, worktree, cdpPort };
}

function listeners(port) {
  let out = '';
  try {
    out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'pn'], { encoding: 'utf8' });
  } catch (error) {
    if (error && error.status === 1) return [];
    throw error;
  }
  const rows = [];
  let current = null;
  for (const line of out.split('\n')) {
    if (!line) continue;
    if (line[0] === 'p') {
      current = { pid: Number(line.slice(1)), names: [] };
      rows.push(current);
    } else if (line[0] === 'n' && current) {
      current.names.push(line.slice(1));
    }
  }
  return rows;
}

function assertInspector(port, pid) {
  const rows = listeners(port);
  if (rows.length === 0) throw new Error(`refused: no listener on inspector port ${port}`);
  for (const row of rows) {
    if (row.pid !== pid) {
      throw new Error(`refused: inspector port ${port} is listened by pid ${row.pid}, not owned pid ${pid}`);
    }
    if (row.names.length === 0) throw new Error('refused: inspector listener address is unknown');
    for (const name of row.names) {
      if (name.replace(/:\d+$/, '') !== '127.0.0.1') {
        throw new Error(`refused: inspector listener ${name} is not 127.0.0.1`);
      }
    }
  }
}

async function portAnswers(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function evaluateQuit(port, pid) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const wsUrl = targets[0]?.webSocketDebuggerUrl ?? '';
  if (!wsUrl.startsWith(`ws://127.0.0.1:${port}/`)) {
    throw new Error(`unexpected inspector endpoint: ${wsUrl || 'none'}`);
  }
  const expression = `(() => {
    if (process.pid !== ${pid}) throw new Error('inspector PID ' + process.pid + ' is not the owned main');
    setTimeout(() => process.mainModule.require('electron').app.quit(), 50);
    return 'quit scheduled';
  })()`;
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let timer;
  try {
    const reply = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('inspector did not answer within 30s')), 30_000);
      ws.onclose = () => reject(new Error('inspector closed before answering'));
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id === 1) resolve(message);
      };
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true },
      }));
    });
    if (reply.error || reply.result?.exceptionDetails) {
      throw new Error(`app.quit() was not accepted: ${JSON.stringify(reply.error ?? reply.result.exceptionDetails).slice(0, 800)}`);
    }
    return reply.result?.result?.value;
  } finally {
    clearTimeout(timer);
    ws.onclose = null;
    ws.close();
  }
}

async function main() {
  let opts;
  try {
    opts = parse(process.argv.slice(2));
  } catch (error) {
    const message = error?.message ?? String(error);
    process.stderr.write(`${message}\n`);
    return message.startsWith('usage:') ? 2 : 1;
  }

  const worktree = realpathSync(opts.worktree);
  const mainCheckout = mainCheckoutOf(worktree);
  if (mainCheckout && mainCheckout === worktree) {
    process.stderr.write(`refused: ${worktree} is the main checkout — the user's own Desktop runs there\n`);
    return 3;
  }
  const found = selectOwnedDesktop(ps(), worktree);
  if (!found.mains.some((row) => row.pid === opts.pid)) {
    process.stderr.write(`refused: pid ${opts.pid} is not an init-parented Desktop main under ${worktree}\n`);
    return 1;
  }
  assertInspector(opts.inspectorPort, opts.pid);

  const scheduled = await evaluateQuit(opts.inspectorPort, opts.pid);
  process.stdout.write(`${new Date().toISOString()} ${scheduled ?? 'quit evaluate returned'}; waiting until the process and listeners are gone\n`);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const alive = pidSet(ps()).has(opts.pid);
    const inspectorUp = await portAnswers(opts.inspectorPort);
    const cdpUp = await portAnswers(opts.cdpPort);
    if (!alive && !inspectorUp && !cdpUp) {
      process.stdout.write('quit confirmed: owned main, inspector, and CDP listener are gone\n');
      return 0;
    }
    if (Date.now() > deadline) {
      process.stderr.write(`timed out after ${POLL_TIMEOUT_MS}ms — still standing: pid=${alive} inspector=${inspectorUp} cdp=${cdpUp}; nothing was signalled\n`);
      return 4;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error?.message ?? error}\n`);
      process.exit(1);
    },
  );
}
