#!/usr/bin/env node
/**
 * Owned-window size client for the Window size section of references/desktop/setup.md.
 *
 *   node resize-owned-window.mjs <inspector-port> <owned-pid> <out-dir> <label> --dry-run
 *   node resize-owned-window.mjs <inspector-port> <owned-pid> <out-dir> <label> <width> <height> [<x> <y>]
 *   node resize-owned-window.mjs <inspector-port> <owned-pid> <out-dir> <label> --page /console/browser-window.html <width> <height> [<x> <y>]
 *
 * Unlike main-inspector.mjs this client CHANGES the Electron main: it calls setContentBounds on the selected
 * owned BaseWindow, so run it only within the person's authorization for that window, size, and position.
 * Matching --page is not that authorization. It connects only to a 127.0.0.1 inspector and refuses unless
 * the main's PID equals <owned-pid>. With no --page it also refuses unless exactly one BaseWindow exists.
 * --page <pathname> selects the one BaseWindow that has a child page at that exact pathname, and refuses on
 * any other count instead of resizing a different window. It refuses a fullscreen or minimized window, a size
 * below that window's minimum, or a rect outside every display's work area. It never calls show, focus,
 * moveTop, or setFullScreen, and touches no other window or app.
 * <width>/<height> are the Console content size in DIP; <x>/<y> default to the current content origin.
 * --page may also precede --dry-run. --dry-run only reads the bounds, minimum size, focus, Console zoom
 * factor, and display work areas.
 *
 * Writes <out-dir>/<label>.window.json and prints the same JSON. Exit 0 when the content bounds read back as
 * requested (or after --dry-run), 2 when the window settled at other bounds, 1 when the helper refused or failed.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SELECT_ONE = `  if (windows.length !== 1) throw new Error('expected exactly one BaseWindow, found ' + windows.length);
  const window = windows[0];`;

const READ = `const { BaseWindow, screen } = process.mainModule.require('electron');
  const windows = BaseWindow.getAllWindows();
  if (process.pid !== OWNED_PID) throw new Error('inspector PID ' + process.pid + ' is not the owned main');
${SELECT_ONE}
  const consoleView = window.contentView.children.find((child) => {
    try { return new URL(child.webContents.getURL()).pathname.startsWith('/console/'); } catch { return false; }
  });
  const read = () => ({
    bounds: window.getBounds(),
    contentBounds: window.getContentBounds(),
    focused: window.isFocused(),
    consoleZoomFactor: consoleView ? consoleView.webContents.getZoomFactor() : null,
  });
  const displays = screen.getAllDisplays().map((d) => ({ id: d.id, workArea: d.workArea, scaleFactor: d.scaleFactor }));
  const [minWidth, minHeight] = window.getMinimumSize();`;

const PAGE_PATH = /^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/;

function pagePath(value) {
  if (typeof value !== 'string' || value.length > 200 || value.includes('..') || !PAGE_PATH.test(value)) {
    throw new Error('--page: expected one absolute pathname, such as /console/browser-window.html');
  }
  return value;
}

function readSource(page) {
  if (!page) return READ;
  const literal = JSON.stringify(page);
  const selected = `  const matched = windows.filter((candidate) => candidate.contentView.children.some((child) => { try { return new URL(child.webContents.getURL()).pathname === ${literal}; } catch { return false; } }));
  if (matched.length !== 1) throw new Error('expected exactly one BaseWindow with page ' + ${literal} + ', found ' + matched.length);
  const window = matched[0];`;
  const next = READ.replace(SELECT_ONE, selected);
  if (next === READ) throw new Error('window selection template missing');
  return next;
}

function expression(pid, request, page = null) {
  const pageField = page ? ` page: ${JSON.stringify(page)},` : '';
  const body = request
    ? `if (window.isFullScreen() || window.isMinimized()) throw new Error('window is fullscreen or minimized; refusing');
  const before = read();
  const rect = { x: ${request.x ?? 'before.contentBounds.x'}, y: ${request.y ?? 'before.contentBounds.y'}, width: ${request.width}, height: ${request.height} };
  if (rect.width < minWidth || rect.height < minHeight) throw new Error('requested size is below the window minimum ' + minWidth + 'x' + minHeight);
  const inside = displays.some(({ workArea: a }) => rect.x >= a.x && rect.y >= a.y
    && rect.x + rect.width <= a.x + a.width && rect.y + rect.height <= a.y + a.height);
  if (!inside) throw new Error('requested rect is outside every display work area');
  window.setContentBounds(rect);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = read();
  const c = after.contentBounds;
  return { pid: process.pid, windowId: window.id,${pageField} requested: rect, minimumSize: [minWidth, minHeight], displays, before, after,
    reached: c.x === rect.x && c.y === rect.y && c.width === rect.width && c.height === rect.height };`
    : `return { pid: process.pid, windowId: window.id,${pageField} dryRun: true, minimumSize: [minWidth, minHeight], displays, current: read() };`;
  return `(async () => { ${readSource(page).replace('OWNED_PID', String(pid))}\n  ${body}\n})()`;
}

function integer(value, label, { min = 0, signed = false } = {}) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || (!signed && n < min)) throw new Error(`${label}: expected an integer${signed ? '' : ` >= ${min}`}`);
  return n;
}

function parseArgs(argv) {
  const [rawPort, rawPid, outDir, label, ...rest] = argv;
  const port = integer(rawPort, 'inspector-port', { min: 1 });
  if (port > 65535) throw new Error('inspector-port: expected 1–65535');
  const pid = integer(rawPid, 'owned-pid', { min: 2 });
  if (!outDir || !path.isAbsolute(outDir)) throw new Error('expected an absolute out-dir');
  if (!/^[A-Za-z0-9_-]+$/.test(label ?? '')) throw new Error('expected a label of [A-Za-z0-9_-]');
  let page = null;
  let mode = rest;
  if (rest[0] === '--page') {
    if (rest.indexOf('--page', 1) !== -1) throw new Error('--page: pass it once, before --dry-run or the size');
    page = pagePath(rest[1]);
    mode = rest.slice(2);
  } else if (rest.includes('--page')) {
    throw new Error('--page: pass it once, before --dry-run or the size');
  }
  let request = null;
  if (mode.length === 1 && mode[0] === '--dry-run') request = null;
  else if (mode.length === 2 || mode.length === 4) {
    request = { width: integer(mode[0], 'width', { min: 1 }), height: integer(mode[1], 'height', { min: 1 }) };
    if (mode.length === 4) Object.assign(request, { x: integer(mode[2], 'x', { signed: true }), y: integer(mode[3], 'y', { signed: true }) });
  } else throw new Error('expected --dry-run, <width> <height>, or <width> <height> <x> <y>');
  return { port, pid, outDir, label, request, page };
}

async function main() {
  const { port, pid, outDir, label, request, page } = parseArgs(process.argv.slice(2));

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
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id === 1) resolve(message);
      };
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: expression(pid, request, page), returnByValue: true, awaitPromise: true },
      }));
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
  writeFileSync(path.join(outDir, `${label}.window.json`), `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record));
  if (request && !record.reached) process.exitCode = 2;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then(() => process.exit()).catch((error) => {
    console.error(`resize-owned-window: ${error.message}`);
    // A peer that never completes the WebSocket close handshake would otherwise keep Node alive past the timeout.
    process.exit(1);
  });
}

export { expression, parseArgs };
