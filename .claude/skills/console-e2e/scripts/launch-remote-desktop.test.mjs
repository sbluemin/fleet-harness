import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertOwnedRemoteDir,
  checkAppPlist,
  checkIdentityDocument,
  ownedRemoteDir,
  parsePort,
  resolveSshTarget,
  shQuote,
} from './launch-remote-desktop.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'launch-remote-desktop.mjs');

describe('ssh target selection (single source: FLEET_E2E_SSH_TARGET)', () => {
  test('accepts a Host alias and user@host', () => {
    assert.equal(resolveSshTarget('remote-mac'), 'remote-mac');
    assert.equal(resolveSshTarget('deploy@remote-mac.local'), 'deploy@remote-mac.local');
  });
  for (const bad of ['', '   ', 'a/b', 'host:22', '-oProxyJump=x', 'a b', 'user@@h', ';rm', 'host|cat', 'user@', '@host', '-alias']) {
    test(`refuses ${JSON.stringify(bad)}`, () => {
      assert.throws(() => resolveSshTarget(bad), /ssh-selector/);
    });
  }
  test('missing value refuses without a local fallback', () => {
    assert.throws(() => resolveSshTarget(undefined), /ssh-selector-missing/);
  });
});

describe('ports and quoting', () => {
  test('parsePort accepts the range and refuses the rest', () => {
    assert.equal(parsePort('9222', '--local-port'), 9222);
    assert.throws(() => parsePort('0', '--local-port'));
    assert.throws(() => parsePort('70000', '--local-port'));
    assert.throws(() => parsePort('abc', '--local-port'));
  });
  test('shQuote keeps spaces and single quotes intact for sh', () => {
    const value = `/Users/some one/o'clock/Fleet Console.app`;
    const out = spawnSync('sh', ['-c', `printf %s ${shQuote(value)}`], { encoding: 'utf8' });
    assert.equal(out.status, 0);
    assert.equal(out.stdout, value);
  });
});

describe('owned remote directory', () => {
  test('derives one fixed directory per run id', () => {
    assert.equal(ownedRemoteDir('/Users/remote', 'abc-1'), '/Users/remote/.fleet/e2e-remote-abc-1');
  });
  test('acts only on that exact directory', () => {
    assert.throws(() => assertOwnedRemoteDir('/Users/remote', 'a', '/Users/remote/.fleet/e2e-remote-b'));
    assert.throws(() => assertOwnedRemoteDir('/Users/remote', 'a', '/Users/remote'));
    assert.throws(() => assertOwnedRemoteDir('/Users/remote', 'a', '/Users/remote/.fleet/e2e-remote-a/evil'));
  });
});

describe('dry-run CLI (local mock only, no SSH connection)', () => {
  function arrange(t) {
    const base = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'rmt-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const pkg = path.join(base, 'pkg.zip');
    fs.writeFileSync(pkg, 'fake-zip-bytes');
    const sha = createHash('sha256').update('fake-zip-bytes').digest('hex');
    return { base, pkg, sha };
  }
  function freePort() {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
    });
  }
  function cli(args, env) {
    return spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  }

  test('dry-run passes with a valid explicit package', async (t) => {
    const { base, pkg, sha } = arrange(t);
    const port = await freePort();
    const result = cli([base, '--package', pkg, '--package-sha256', sha, '--package-revision', 'a'.repeat(40),
      '--run-id', 't1', '--local-port', String(port), '--remote-port', '19322', '--dry-run'],
    { FLEET_E2E_SSH_TARGET: 'remote-mac' });
    assert.equal(result.status, 0, result.stderr);
  });

  test('dry-run refuses a digest mismatch (no public substitute)', async (t) => {
    const { base, pkg } = arrange(t);
    const port = await freePort();
    const result = cli([base, '--package', pkg, '--package-sha256', '0'.repeat(64), '--package-revision', 'a'.repeat(40),
      '--run-id', 't1', '--local-port', String(port), '--remote-port', '19322', '--dry-run'],
    { FLEET_E2E_SSH_TARGET: 'remote-mac' });
    assert.equal(result.status, 20);
    assert.match(result.stderr, /package-digest-mismatch/);
  });

  test('an occupied local port fails without any CDP traffic to it', async (t) => {
    const { base, pkg, sha } = arrange(t);
    let bytes = 0;
    let requests = 0;
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => { bytes += chunk.length; });
      // Never answer: this tool must not treat the listener as its target.
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const port = server.address().port;
    const before = Date.now();
    const result = cli([base, '--package', pkg, '--package-sha256', sha, '--package-revision', 'a'.repeat(40),
      '--run-id', 't1', '--local-port', String(port), '--remote-port', '19322', '--dry-run'],
    { FLEET_E2E_SSH_TARGET: 'remote-mac' });
    assert.equal(result.status, 20, result.stderr);
    assert.match(result.stderr, /local-port-occupied/);
    // Settle any in-flight connect; only a bare TCP handshake is allowed, never HTTP.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(requests, 0);
    assert.equal(bytes, 0, `sent ${bytes} bytes to an existing listener in ${Date.now() - before}ms`);
  });

  test('missing selector refuses with no local fallback', async (t) => {
    const { base, pkg, sha } = arrange(t);
    const port = await freePort();
    const env = { ...process.env };
    delete env.FLEET_E2E_SSH_TARGET;
    const result = spawnSync(process.execPath, [script, base, '--package', pkg, '--package-sha256', sha,
      '--package-revision', 'a'.repeat(40), '--run-id', 't1', '--local-port', String(port), '--remote-port', '19322', '--dry-run'],
    { encoding: 'utf8', env });
    assert.equal(result.status, 20);
    assert.match(result.stderr, /ssh-selector-missing/);
  });

  test('an invalid selector refuses before any connection', async (t) => {
    const { base, pkg, sha } = arrange(t);
    const port = await freePort();
    const result = cli([base, '--package', pkg, '--package-sha256', sha, '--package-revision', 'a'.repeat(40),
      '--run-id', 't1', '--local-port', String(port), '--remote-port', '19322', '--dry-run'],
    { FLEET_E2E_SSH_TARGET: 'not a/target' });
    assert.equal(result.status, 20);
    assert.match(result.stderr, /ssh-selector-invalid/);
  });
});

describe('packaged identity contract (exact fields, no substrings)', () => {
  const REV = 'c'.repeat(40);
  const good = JSON.stringify({
    schemaVersion: 1,
    kind: 'fleet-remote-mac-package',
    sourceRevision: REV,
    bundleId: 'com.dotobokuri.fleet-console',
    productName: 'Fleet Console',
  });
  const plistFor = ({ bundleId = 'com.dotobokuri.fleet-console', revision = REV, executable = 'Fleet Console' } = {}) => [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    `<key>CFBundleIdentifier</key><string>${bundleId}</string>`,
    '<key>CFBundleShortVersionString</key><string>0.44.0</string>',
    `<key>CFBundleExecutable</key><string>${executable}</string>`,
    `<key>FleetSourceRevision</key><string>${revision}</string>`,
    '</dict></plist>',
  ].join('\n');

  test('accepts the exact contract document and plist', () => {
    const doc = checkIdentityDocument(good, REV);
    assert.equal(doc.sourceRevision, REV);
    const app = checkAppPlist(plistFor(), doc);
    assert.equal(app.bundleExecutable, 'Fleet Console');
    assert.equal(app.bundleVersion, '0.44.0');
  });

  for (const [name, mutate] of [
    ['schemaVersion', (d) => ({ ...d, schemaVersion: 2 })],
    ['kind', (d) => ({ ...d, kind: 'fleet-remote-mac-package-v2' })],
    ['sourceRevision', (d) => ({ ...d, sourceRevision: 'd'.repeat(40) })],
    ['bundleId', (d) => ({ ...d, bundleId: 'com.dotobokuri.fleet-console.dev' })],
    ['productName', (d) => ({ ...d, productName: 'Fleet Console Dev' })],
  ]) {
    test(`refuses a document with a wrong ${name}`, () => {
      assert.throws(() => checkIdentityDocument(JSON.stringify(mutate(JSON.parse(good))), REV), /package-identity-mismatch/);
    });
  }

  test('refuses malformed and non-object documents', () => {
    for (const bad of ['{nope', 'null', '[]', '"str"', '42']) {
      assert.throws(() => checkIdentityDocument(bad, REV), /package-identity-mismatch/);
    }
  });

  for (const [name, options] of [
    ['bundle id', { bundleId: 'com.dotobokuri.fleet-console.dev' }],
    ['revision', { revision: 'd'.repeat(40) }],
    ['renamed executable', { executable: 'Fleet Console Helper' }],
    ['helper executable', { executable: 'fleet-computer-use' }],
  ]) {
    test(`refuses a plist with a wrong ${name}`, () => {
      const doc = checkIdentityDocument(good, REV);
      assert.throws(() => checkAppPlist(plistFor(options), doc), /package-identity-mismatch/);
    });
  }
});
