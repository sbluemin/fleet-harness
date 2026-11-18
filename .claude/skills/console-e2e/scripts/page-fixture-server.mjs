#!/usr/bin/env node
/**
 * Reusable page fixture for an owned browser run: text input, select, native
 * alert/confirm, and a fake login form at `/`; a same-origin opener page at
 * `/opener` and its child at `/child`.
 *
 *   node page-fixture-server.mjs [--port <0-65535>]
 *
 * Binds 127.0.0.1 only, and with no argument or `--port 0` asks the OS for a
 * port. It prints one JSON line with the actual url and pid, then nothing else.
 * SIGINT/SIGTERM close the server and exit 0.
 *
 * The login form is a fixture. Submit is prevented and the page only shows an
 * in-page completion marker; its inputs carry no names, and the server never
 * reads a body, parses a query, logs a request, or sets a cookie. No page uses
 * storage or calls the network. It does not verify IME composition or real
 * authentication success.
 *
 * `/opener` opens `/child` as a tab or a popup, and the child posts one fixed
 * synthetic result to the opener before calling `window.close()`. The opener
 * accepts a message only from the same origin, from a window it opened, and with
 * that exact result. Its "result" marker means only that the opener received
 * the message, and its handle state is the opener's own observation of the
 * handle; neither proves the child's tab actually disappeared, which the browser
 * context list decides.
 */

import http from 'node:http';

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fleet fixture page</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; line-height: 1.5; }
  section { border: 1px solid #888; border-radius: 8px; padding: 12px; margin-bottom: 16px; }
  output { font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<h1>Fleet fixture page</h1>
<p id="fixture-note">Fixture only: use fake values, never real credentials. This page does not verify IME composition or whether authentication succeeds.</p>
<section>
  <h2>Text input</h2>
  <label for="text-input">Text</label>
  <input id="text-input" type="text" autocomplete="off">
  <p>value: <output id="text-result">none</output></p>
</section>
<section>
  <h2>Select</h2>
  <label for="select-input">Option</label>
  <select id="select-input">
    <option value="red">Red</option>
    <option value="green">Green</option>
    <option value="blue">Blue</option>
  </select>
  <p>value: <output id="select-result">red</output></p>
</section>
<section>
  <h2>Dialogs</h2>
  <button id="alert-button" type="button">Open alert</button>
  <button id="confirm-button" type="button">Open confirm</button>
  <p>result: <output id="dialog-result">none</output></p>
</section>
<section>
  <h2>Fake login</h2>
  <p>Fake values only. Submit is blocked, and completion stays on this page.</p>
  <form id="login-form" autocomplete="off">
    <label for="login-user">User</label>
    <input id="login-user" type="text" autocomplete="off">
    <label for="login-pass">Password</label>
    <input id="login-pass" type="password" autocomplete="off">
    <button id="login-submit" type="submit">Sign in</button>
  </form>
  <p>result: <output id="login-result">none</output></p>
</section>
<script>
  const textInput = document.getElementById('text-input');
  textInput.addEventListener('input', () => {
    document.getElementById('text-result').textContent = textInput.value;
  });
  const selectInput = document.getElementById('select-input');
  selectInput.addEventListener('change', () => {
    document.getElementById('select-result').textContent = selectInput.value;
  });
  document.getElementById('alert-button').addEventListener('click', () => {
    alert('Fixture alert');
    document.getElementById('dialog-result').textContent = 'alert-dismissed';
  });
  document.getElementById('confirm-button').addEventListener('click', () => {
    const accepted = confirm('Fixture confirm?');
    document.getElementById('dialog-result').textContent = accepted ? 'confirm-accepted' : 'confirm-cancelled';
  });
  document.getElementById('login-form').addEventListener('submit', (event) => {
    event.preventDefault();
    document.getElementById('login-result').textContent = 'login-fixture-complete';
  });
</script>
</body>
</html>`;

const OPENER = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fleet fixture opener</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; line-height: 1.5; }
  section { border: 1px solid #888; border-radius: 8px; padding: 12px; margin-bottom: 16px; }
  output { font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<h1>Fleet fixture opener</h1>
<p>Fixture only. It opens the fixed same-origin child and accepts its fixed result.</p>
<section>
  <h2>Open child</h2>
  <button id="open-tab" type="button">Open child as tab</button>
  <button id="open-popup" type="button">Open child as popup</button>
  <p>opened: <output id="opened-count">0</output></p>
  <p>child handle: <output id="child-handle">none</output></p>
</section>
<section>
  <h2>Result</h2>
  <p>result: <output id="parent-result">none</output></p>
  <p>received: <output id="parent-result-detail">none</output></p>
  <p>This marker means only that this page received the fixed message. The handle state is this page's own observation; confirm the child actually disappeared in the browser context list.</p>
</section>
<script>
  const CHILD_URL = '/child';
  const EXPECTED = { fixture: 'child-result', value: 'fixed' };
  const opened = [];
  let lastHandle = null;
  const count = document.getElementById('opened-count');
  const handleOut = document.getElementById('child-handle');

  const watch = (handle) => {
    lastHandle = handle;
    const timer = setInterval(() => {
      if (!handle || handle.closed) {
        clearInterval(timer);
        if (lastHandle === handle) handleOut.textContent = 'closed';
      }
    }, 100);
  };
  const open = (target, features) => {
    const handle = window.open(CHILD_URL, target, features);
    if (handle) {
      opened.push(handle);
      handleOut.textContent = 'open';
      watch(handle);
    } else {
      handleOut.textContent = 'blocked';
    }
    count.textContent = String(opened.length);
  };

  document.getElementById('open-tab').addEventListener('click', () => open('_blank', ''));
  document.getElementById('open-popup').addEventListener('click', () => open('', 'popup,width=420,height=520'));

  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin) return;
    if (!opened.includes(event.source)) return;
    const data = event.data;
    if (data === null || typeof data !== 'object') return;
    if (Object.keys(data).length !== 2 || data.fixture !== EXPECTED.fixture || data.value !== EXPECTED.value) return;
    document.getElementById('parent-result').textContent = 'child-result-received';
    document.getElementById('parent-result-detail').textContent = JSON.stringify(data);
  });
</script>
</body>
</html>`;

const CHILD = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fleet fixture child</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; line-height: 1.5; }
  section { border: 1px solid #888; border-radius: 8px; padding: 12px; margin-bottom: 16px; }
  output { font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<h1>Fleet fixture child</h1>
<p>Fixture only. It sends the fixed synthetic result to its opener and then calls <code>window.close()</code>.</p>
<section>
  <p>opener: <output id="child-opener">absent</output></p>
  <button id="send-close" type="button">Send fixed result and close</button>
  <p>state: <output id="child-state">idle</output></p>
  <p>Calling <code>window.close()</code> is not proof that this tab disappeared; confirm that in the browser context list.</p>
</section>
<script>
  document.getElementById('child-opener').textContent = window.opener ? 'present' : 'absent';
  document.getElementById('send-close').addEventListener('click', () => {
    const target = window.opener;
    const state = document.getElementById('child-state');
    if (!target) {
      state.textContent = 'no-opener';
      return;
    }
    target.postMessage({ fixture: 'child-result', value: 'fixed' }, location.origin);
    state.textContent = 'result-sent-close-requested';
    window.close();
  });
</script>
</body>
</html>`;

function fail(message) {
  process.stderr.write(`page-fixture-server: ${message}\n`);
  process.exit(1);
}

function parsePort(argv) {
  let port = 0;
  let seen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== '--port') fail(`unknown argument: ${JSON.stringify(arg)}`);
    if (seen) fail('--port: pass it once');
    seen = true;
    const raw = argv[++i];
    if (raw === undefined) fail('--port: missing value');
    if (!/^\d+$/.test(raw)) fail(`--port: expected an integer 0-65535, got ${JSON.stringify(raw)}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > 65535) {
      fail(`--port: expected an integer 0-65535, got ${JSON.stringify(raw)}`);
    }
    port = value;
  }
  return port;
}

function main() {
  const port = parsePort(process.argv.slice(2));
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('method not allowed');
      return;
    }
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('bad request');
      return;
    }
    const pages = { '/': HTML, '/opener': OPENER, '/child': CHILD };
    const page = pages[pathname];
    if (page === undefined) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(req.method === 'HEAD' ? undefined : page);
  });

  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  server.on('error', (error) => fail(error.message));
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || (port !== 0 && address.port !== port)) {
      server.close();
      fail(`refused: bound ${JSON.stringify(address)}, not 127.0.0.1:${port}`);
    }
    process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${address.port}/`, pid: process.pid })}\n`);
  });
}

main();
