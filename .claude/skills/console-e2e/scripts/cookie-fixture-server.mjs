#!/usr/bin/env node
/**
 * Non-secret cookie fixture for an owned Desktop browser context.
 * Not a login, not a profile or keychain reader, and not evidence that a real site session persists.
 *
 *   node cookie-fixture-server.mjs --port <n>
 *
 * Listens on 127.0.0.1 only. /set sends two fixed cookies and nothing else:
 * fleet_session (no Max-Age) and fleet_persist (Max-Age 2592000).
 * /read returns only those two cookies from the Cookie header this request carried, as JSON,
 * drops every other cookie the browser sent, and sets nothing. Each /read also prints one
 * `read {json}` line on stdout, so a native view that cannot be read back still leaves a record.
 * The caller chooses the browser session or profile and records what /read showed.
 * This server does not.
 */

import http from 'node:http';

const SESSION = 'fleet_session=session-value; Path=/';
const NAMES = new Set(['fleet_session', 'fleet_persist']);
const PERSIST = 'fleet_persist=persist-value; Path=/; Max-Age=2592000';

function onlyFixtureCookies(header) {
  return (header ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => NAMES.has(part.split('=')[0]))
    .join('; ');
}

function fail(message) {
  process.stderr.write(`cookie-fixture-server: ${message}\n`);
  process.exit(1);
}

function parse(argv) {
  let port = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') {
      if (port !== null) fail('--port: pass it once');
      const value = argv[++i];
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 1 || n > 65535) fail('--port: expected a port 1–65535');
      port = n;
      continue;
    }
    fail(arg ? `unknown argument: ${arg}` : 'usage: cookie-fixture-server.mjs --port <n>');
  }
  if (port === null) fail('usage: cookie-fixture-server.mjs --port <n>');
  return port;
}

function main() {
  const port = parse(process.argv.slice(2));
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/set') {
      res.setHeader('Set-Cookie', [SESSION, PERSIST]);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<title>cookie set</title>set');
      return;
    }
    if (pathname === '/read') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const body = { at: new Date().toISOString(), cookie: onlyFixtureCookies(req.headers.cookie) };
      process.stdout.write(`read ${JSON.stringify(body)}\n`);
      res.end(JSON.stringify(body));
      return;
    }
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('not found');
  });
  server.on('error', (error) => fail(error.message));
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || address.port !== port) {
      server.close();
      fail(`refused: bound ${JSON.stringify(address)}, not 127.0.0.1:${port}`);
    }
    process.stdout.write(`listening 127.0.0.1:${address.port}\n`);
  });
}

main();
