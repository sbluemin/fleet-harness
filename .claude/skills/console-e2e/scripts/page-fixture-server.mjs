#!/usr/bin/env node
/**
 * Reusable page fixture for an owned browser run: text input, select, native
 * alert/confirm, and a fake login form.
 *
 *   node page-fixture-server.mjs [--port <0-65535>]
 *
 * Binds 127.0.0.1 only, and with no argument or `--port 0` asks the OS for a
 * port. It prints one JSON line with the actual url and pid, then nothing else.
 * SIGINT/SIGTERM close the server and exit 0.
 *
 * The login form is a fixture. Submit is prevented and the page only shows an
 * in-page completion marker; its inputs carry no names, and the server never
 * reads a body, parses a query, logs a request, or sets a cookie. The page uses
 * no storage and calls no network. It does not verify IME composition or real
 * authentication success.
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
    if (pathname !== '/') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(req.method === 'HEAD' ? undefined : HTML);
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
