#!/usr/bin/env node
// Owned-window fullscreen preparation; see references/desktop/setup.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseResizeArgs, readSource } from './resize-owned-window.mjs';

function parseArgs(argv) {
  const mode = argv.at(-1);
  if (!['--dry-run', 'on', 'off'].includes(mode) || argv.length < 5) {
    throw new Error('expected <inspector-port> <owned-pid> <out-dir> <label> [--page <abs-path>] <--dry-run|on|off>');
  }
  const base = parseResizeArgs([...argv.slice(0, -1), '--dry-run']);
  return { ...base, fullscreen: mode === '--dry-run' ? null : mode === 'on' };
}

function expression(pid, fullscreen, page = null) {
  const pageField = page ? ` page: ${JSON.stringify(page)},` : '';
  const body = fullscreen === null
    ? `return { pid: process.pid, windowId: window.id,${pageField} dryRun: true, current: state() };`
    : `if (window.isMinimized()) throw new Error('window is minimized; refusing');
  const before = state();
  let completed = before.fullscreen === ${fullscreen};
  if (!completed) {
    const event = ${fullscreen} ? 'enter-full-screen' : 'leave-full-screen';
    let timer;
    let onComplete;
    try {
      completed = await new Promise((resolve) => {
        onComplete = () => resolve(true);
        window.once(event, onComplete);
        timer = setTimeout(() => resolve(false), 8000);
        window.setFullScreen(${fullscreen});
      });
    } finally {
      clearTimeout(timer);
      window.removeListener(event, onComplete);
    }
  }
  const after = state();
  return { pid: process.pid, windowId: window.id,${pageField} requested: ${fullscreen}, before, after,
    reached: completed && after.fullscreen === ${fullscreen} };`;
  return `(async () => {
  if (process.platform === 'win32') throw new Error('Windows is outside this client contract; refusing');
  ${readSource(page).replace('OWNED_PID', String(pid))}
  const state = () => ({ ...read(), fullscreen: window.isFullScreen() });
  ${body}
})()`;
}

async function main() {
  const { port, pid, outDir, label, fullscreen, page } = parseArgs(process.argv.slice(2));
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  if (targets.length !== 1) throw new Error(`expected one inspector target, found ${targets.length}`);
  const wsUrl = targets[0]?.webSocketDebuggerUrl ?? '';
  if (!wsUrl.startsWith(`ws://127.0.0.1:${port}/`)) throw new Error(`unexpected inspector endpoint: ${wsUrl || 'none'}`);
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let timer;
  let reply;
  try {
    reply = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('inspector did not answer within 30s')), 30_000);
      ws.onclose = () => reject(new Error('inspector closed before answering'));
      ws.onmessage = (event) => { const m = JSON.parse(event.data); if (m.id === 1) resolve(m); };
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expression(pid, fullscreen, page), returnByValue: true, awaitPromise: true } }));
    });
  } finally {
    clearTimeout(timer);
    ws.onclose = null;
    ws.close();
  }
  if (reply.error || reply.result?.exceptionDetails) {
    const details = reply.error ?? reply.result.exceptionDetails;
    throw new Error(`refused or failed: ${details.exception?.description ?? JSON.stringify(details)}`.slice(0, 800));
  }
  const record = { at: new Date().toISOString(), ...reply.result.result.value };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, `${label}.fullscreen.json`), `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record));
  if (fullscreen !== null && !record.reached) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit()).catch((error) => {
    console.error(`set-owned-fullscreen: ${error.message}`);
    process.exit(1);
  });
}

export { expression, parseArgs };
