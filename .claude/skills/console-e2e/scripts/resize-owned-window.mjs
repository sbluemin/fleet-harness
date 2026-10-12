#!/usr/bin/env node
/**
 * Owned-window size client for the Window size section of references/desktop/setup.md.
 *
 *   node resize-owned-window.mjs <inspector-port> <owned-pid> <out-dir> <label> --dry-run
 *   node resize-owned-window.mjs <inspector-port> <owned-pid> <out-dir> <label> <width> <height> [<x> <y>]
 *
 * Unlike main-inspector.mjs this client CHANGES the Electron main: it calls setContentBounds on the one owned
 * BaseWindow, so run it only within the person's authorization for that size and position. It connects only to
 * a 127.0.0.1 inspector, refuses unless the main's PID equals <owned-pid> and exactly one BaseWindow exists, and
 * refuses a fullscreen or minimized window, a size below the window minimum, or a rect outside every display's
 * work area. It never calls show, focus, moveTop, or setFullScreen, and touches no other window or app.
 * <width>/<height> are the Console content size in DIP; <x>/<y> default to the current content origin.
 * --dry-run only reads the bounds, minimum size, focus, Console zoom factor, and display work areas.
 *
 * Writes <out-dir>/<label>.window.json and prints the same JSON. Exit 0 when the content bounds read back as
 * requested (or after --dry-run), 2 when the window settled at other bounds, 1 when the helper refused or failed.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const READ = `const { BaseWindow, screen } = process.mainModule.require('electron');
  const windows = BaseWindow.getAllWindows();
  if (process.pid !== OWNED_PID) throw new Error('inspector PID ' + process.pid + ' is not the owned main');
  if (windows.length !== 1) throw new Error('expected exactly one BaseWindow, found ' + windows.length);
  const window = windows[0];
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

function expression(pid, request) {
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
  return { pid: process.pid, windowId: window.id, requested: rect, minimumSize: [minWidth, minHeight], displays, before, after,
    reached: c.x === rect.x && c.y === rect.y && c.width === rect.width && c.height === rect.height };`
    : `return { pid: process.pid, windowId: window.id, dryRun: true, minimumSize: [minWidth, minHeight], displays, current: read() };`;
  return `(async () => { ${READ.replace('OWNED_PID', String(pid))}\n  ${body}\n})()`;
}

function integer(value, label, { min = 0, signed = false } = {}) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || (!signed && n < min)) throw new Error(`${label}: expected an integer${signed ? '' : ` >= ${min}`}`);
  return n;
}

async function main() {
  const [rawPort, rawPid, outDir, label, ...rest] = process.argv.slice(2);
  const port = integer(rawPort, 'inspector-port', { min: 1 });
  if (port > 65535) throw new Error('inspector-port: expected 1–65535');
  const pid = integer(rawPid, 'owned-pid', { min: 2 });
  if (!outDir || !path.isAbsolute(outDir)) throw new Error('expected an absolute out-dir');
  if (!/^[A-Za-z0-9_-]+$/.test(label ?? '')) throw new Error('expected a label of [A-Za-z0-9_-]');
  let request = null;
  if (rest.length === 1 && rest[0] === '--dry-run') request = null;
  else if (rest.length === 2 || rest.length === 4) {
    request = { width: integer(rest[0], 'width', { min: 1 }), height: integer(rest[1], 'height', { min: 1 }) };
    if (rest.length === 4) Object.assign(request, { x: integer(rest[2], 'x', { signed: true }), y: integer(rest[3], 'y', { signed: true }) });
  } else throw new Error('expected --dry-run, <width> <height>, or <width> <height> <x> <y>');

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
        params: { expression: expression(pid, request), returnByValue: true, awaitPromise: true },
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

main().then(() => process.exit()).catch((error) => {
  console.error(`resize-owned-window: ${error.message}`);
  // A peer that never completes the WebSocket close handshake would otherwise keep Node alive past the timeout.
  process.exit(1);
});
