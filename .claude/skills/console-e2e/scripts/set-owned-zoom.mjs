#!/usr/bin/env node
/**
 * Owned-window Console zoom client for the Console zoom section of references/desktop/setup.md.
 *
 *   node set-owned-zoom.mjs <inspector-port> <owned-pid> <out-dir> <label> [--page <abs-path>] --dry-run
 *   node set-owned-zoom.mjs <inspector-port> <owned-pid> <out-dir> <label> [--page <abs-path>] <zoom-factor>
 *
 * Sibling of resize-owned-window.mjs with the same refusals (127.0.0.1 inspector, PID equals <owned-pid>, exactly one
 * BaseWindow or one --page match, no fullscreen or minimized window) and the same rule: it never calls show, focus,
 * moveTop, or setFullScreen. It also refuses a window with no Console child (a detached Browser window reads null).
 * It CHANGES the Electron main: webContents.setZoomFactor on that Console view, only within the person's
 * authorization for that window and factor. <zoom-factor> is 1.2^-3..1.2^3, the range the Desktop zoom store clamps to.
 * It does not run the menu actions (zoomIn/zoomOut/actualSize), does not save the zoom store, and does not refresh
 * the native chrome those actions refresh; it is runtime state, not OS shortcut verification.
 * --dry-run only reads getZoomFactor, contentBounds, and focus. Writes <out-dir>/<label>.zoom.json and prints it.
 * Exit 0 when getZoomFactor reads back as requested (or after --dry-run), 2 when it settled elsewhere, 1 on refusal.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseResizeArgs, readSource } from './resize-owned-window.mjs';

const MIN_FACTOR = 1.2 ** -3;
const MAX_FACTOR = 1.2 ** 3;

function parseArgs(argv) {
  const factorIndex = argv.findIndex((value, i) => i >= 4 && value !== '--page' && argv[i - 1] !== '--page' && value !== '--dry-run');
  if (factorIndex === -1) return { ...parseResizeArgs(argv), factor: null };
  const rest = argv.filter((_, i) => i !== factorIndex);
  const base = parseResizeArgs([...rest, '--dry-run'].filter((v, i, a) => !(v === '--dry-run' && a.indexOf(v) !== i)));
  const factor = Number(argv[factorIndex]);
  if (argv.length - 1 !== factorIndex || !Number.isFinite(factor) || factor < MIN_FACTOR || factor > MAX_FACTOR) {
    throw new Error(`expected <zoom-factor> last, between ${MIN_FACTOR.toFixed(4)} and ${MAX_FACTOR.toFixed(4)}`);
  }
  return { ...base, factor };
}

function expression(pid, factor, page = null) {
  const pageField = page ? ` page: ${JSON.stringify(page)},` : '';
  const body = factor === null
    ? `return { pid: process.pid, windowId: window.id,${pageField} dryRun: true, current: read() };`
    : `if (!consoleView) throw new Error('window has no Console child; refusing');
  if (window.isFullScreen() || window.isMinimized()) throw new Error('window is fullscreen or minimized; refusing');
  const before = read();
  consoleView.webContents.setZoomFactor(${factor});
  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = read();
  return { pid: process.pid, windowId: window.id,${pageField} requested: ${factor}, before, after,
    reached: Math.abs(after.consoleZoomFactor - ${factor}) < 1e-3 };`;
  return `(async () => { ${readSource(page).replace('OWNED_PID', String(pid))}\n  ${body}\n})()`;
}

async function main() {
  const { port, pid, outDir, label, factor, page } = parseArgs(process.argv.slice(2));
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
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expression(pid, factor, page), returnByValue: true, awaitPromise: true } }));
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
  writeFileSync(path.join(outDir, `${label}.zoom.json`), `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record));
  if (factor !== null && !record.reached) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit()).catch((error) => {
    console.error(`set-owned-zoom: ${error.message}`);
    process.exit(1);
  });
}

export { expression, parseArgs };
