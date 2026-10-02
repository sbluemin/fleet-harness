#!/usr/bin/env node
/**
 * Read-only client for the main inspector observation lane in references/desktop/native-and-package.md.
 *
 *   node main-inspector.mjs <inspector-port> <out-dir> snapshot <label>
 *   node main-inspector.mjs <inspector-port> <out-dir> crop <label> <windowId> <consoleContentsId> <x> <y> <width> <height>
 *
 * It connects only to a 127.0.0.1 inspector, evaluates expressions that read view composition or capture
 * the Console webContents, and writes the results to <out-dir> on this side; nothing evaluated in the
 * Electron main moves, resizes, reorders, shows, focuses, or writes anything. Confirm the listener PID is
 * the owned main before running it. Exit 1 means the observation failed; never retry through another
 * module-loading path.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SNAPSHOT = `(() => {
  const { BaseWindow } = process.mainModule.require('electron');
  return {
    pid: process.pid,
    windows: BaseWindow.getAllWindows().map((window) => ({
      id: window.id,
      bounds: window.getBounds(),
      contentBounds: window.getContentBounds(),
      children: window.contentView.children.map((view, index) => {
        const wc = view.webContents;
        let page = null;
        if (wc && !wc.isDestroyed()) {
          try {
            const url = new URL(wc.getURL());
            page = { origin: url.origin, pathname: url.pathname };
          } catch { /* view has not navigated yet */ }
        }
        return { index, bounds: view.getBounds(), webContentsId: wc?.id ?? null, page };
      }),
    })),
  };
})()`;

function crop([windowId, contentsId, x, y, width, height]) {
  const n = [windowId, contentsId, x, y, width, height].map(Number);
  if (n.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error('crop needs six non-negative integers');
  // An empty rect makes capturePage capture the whole page instead of the region of interest.
  if (n[4] < 1 || n[5] < 1) throw new Error('crop width and height must be at least 1');
  return `(async () => {
  const { BaseWindow } = process.mainModule.require('electron');
  const window = BaseWindow.fromId(${n[0]});
  const view = window?.contentView.children.find((child) => child.webContents?.id === ${n[1]});
  if (!view) throw new Error('observed Console child is gone');
  const image = await view.webContents.capturePage(
    { x: ${n[2]}, y: ${n[3]}, width: ${n[4]}, height: ${n[5]} },
    { stayHidden: true, stayAwake: false },
  );
  return { size: image.getSize(), png: image.toDataURL() };
})()`;
}

async function main() {
  const [rawPort, outDir, mode, label, ...rest] = process.argv.slice(2);
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('expected an inspector port');
  if (!outDir || !path.isAbsolute(outDir)) throw new Error('expected an absolute out-dir');
  if (!['snapshot', 'crop'].includes(mode) || !/^[A-Za-z0-9_-]+$/.test(label ?? '')) {
    throw new Error('expected snapshot <label> or crop <label> <windowId> <consoleContentsId> <x> <y> <width> <height>');
  }
  const expression = mode === 'snapshot' ? SNAPSHOT : crop(rest);

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
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
        params: { expression, returnByValue: true, awaitPromise: mode === 'crop' },
      }));
    });
  } finally {
    clearTimeout(timer);
    ws.onclose = null;
    ws.close();
  }
  if (reply.error || reply.result?.exceptionDetails) {
    throw new Error(`observation failed: ${JSON.stringify(reply.error ?? reply.result.exceptionDetails).slice(0, 800)}`);
  }

  const value = reply.result.result.value;
  const at = new Date().toISOString();
  mkdirSync(outDir, { recursive: true });
  if (mode === 'snapshot') {
    writeFileSync(path.join(outDir, `${label}.snapshot.json`), JSON.stringify({ at, ...value }, null, 2));
    console.log(JSON.stringify({ at, ...value }));
    return;
  }
  const png = Buffer.from(value.png.replace(/^data:image\/png;base64,/, ''), 'base64');
  const file = path.join(outDir, `${label}.crop.png`);
  writeFileSync(file, png);
  // capturePage takes the rect in DIP but returns device pixels.
  console.log(JSON.stringify({ at, devicePixelSize: value.size, bytes: png.length, path: file }));
}

main().catch((error) => {
  console.error(error.message);
  // A peer that never completes the WebSocket close handshake would otherwise keep Node alive past the timeout.
  process.exit(1);
});
