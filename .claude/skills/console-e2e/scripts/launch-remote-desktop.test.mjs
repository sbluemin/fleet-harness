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
  isOrphanTarget,
  isShellCommand,
  orphanMarkers,
  ownedRemoteDir,
  parsePort,
  parsePsTable,
  resolveSshTarget,
  scanOwnedProcesses,
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
    assert.equal(ownedRemoteDir('/tmp/user/T/\n', 'abc-1'), '/tmp/user/T/e2e-remote-abc-1');
  });
  test('acts only on that exact directory', () => {
    assert.throws(() => assertOwnedRemoteDir('/tmp/user/T', 'a', '/tmp/user/T/e2e-remote-b'));
    assert.throws(() => assertOwnedRemoteDir('/tmp/user/T', 'a', '/tmp/user/T'));
    assert.throws(() => assertOwnedRemoteDir('/tmp/user/T', 'a', '/tmp/user/T/e2e-remote-a/other'));
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

describe('orphan discovery after reparenting (executable prefixes only)', () => {
  const DIR = '/tmp/e2e-remote-abc';
  const HOME = `${DIR}/home`;
  const LATEST = `${HOME}/.fleet/desktop/runtime/console/latest`;
  const NODEBIN = `${HOME}/.fleet/desktop/runtime/node/bin/node`;
  const markers = orphanMarkers({
    appPath: `${DIR}/pkg/Fleet Console.app`,
    latestDir: LATEST,
    latestReal: LATEST,
    homeDir: HOME,
  });
  const CLI = `${NODEBIN} ${LATEST}/dist/cli.mjs serve`;

  test('markers derive the pinned executable, console, and helper prefixes', () => {
    assert.equal(markers.exe, `${DIR}/pkg/Fleet Console.app/Contents/MacOS/Fleet Console`);
    assert.ok(markers.nodeCli.includes(`${NODEBIN} ${LATEST}/dist/cli.mjs serve`));
    assert.ok(markers.helpDirs.some((entry) => entry.endsWith('/node_modules')));
    const empty = orphanMarkers({ appPath: null, latestDir: null, latestReal: null, homeDir: null });
    assert.equal(empty.exe, null);
    assert.deepEqual(empty.nodeCli, []);
    assert.deepEqual(empty.helpDirs, []);
  });

  test('command shells never qualify, however many owned paths they carry', () => {
    assert.equal(isShellCommand(`/bin/sh -c 'cat ${LATEST}/dist/cli.mjs serve'`), true);
    assert.equal(isShellCommand(`/bin/bash -c 'kill ${DIR}'`), true);
    assert.equal(isShellCommand(`/bin/zsh -c 'echo hi'`), true);
    assert.equal(isShellCommand(`/bin/sh ${DIR}/pkg/x`), false);
    assert.equal(isOrphanTarget(`/bin/sh -c 'cat ${LATEST}/dist/cli.mjs serve'`, markers), false);
    assert.equal(isOrphanTarget(`/bin/bash -c 'exec ${markers.exe}'`, markers), false);
    assert.equal(isOrphanTarget(`ssh -o BatchMode=yes mock-remote cat '${LATEST}/fleet-package-identity.json'`, markers), false);
  });

  test('owned app, console, and helper prefixes qualify', () => {
    assert.equal(isOrphanTarget(`${markers.exe} --remote-debugging-port=1`, markers), true);
    assert.equal(isOrphanTarget(markers.exe, markers), true);
    assert.equal(isOrphanTarget(`${CLI} --extra`, markers), true);
    assert.equal(isOrphanTarget(`${LATEST}/node_modules/node-pty/prebuilds/x/spawn-helper`, markers), true);
  });

  test('owned paths as mere arguments never qualify', () => {
    assert.equal(isOrphanTarget(`notes-for ${DIR}`, markers), false);
    assert.equal(isOrphanTarget(`less ${markers.exe}`, markers), false);
    assert.equal(isOrphanTarget(`tail -f ${LATEST}/dist/cli.mjs`, markers), false);
    assert.equal(isOrphanTarget(`node ${LATEST}/dist/cli.mjs`, markers), false);
    assert.equal(isOrphanTarget('/usr/bin/sleep 300', markers), false);
  });

  test('a sibling run prefix never matches anchored markers', () => {
    assert.equal(isOrphanTarget(`${DIR}2/pkg/Fleet Console.app/Contents/MacOS/Fleet Console`, markers), false);
    assert.equal(isOrphanTarget(`${NODEBIN} ${DIR}2/home/.fleet/desktop/runtime/console/latest/dist/cli.mjs serve`, markers), false);
  });

  test('scan splits tree members from reparented orphans and spares decoys', () => {
    const table = [
      `100 1 ${markers.exe} --remote-debugging-port=1`,
      `101 100 ${CLI}`,
      `102 1 ${CLI}`,
      `103 1 notes-for ${DIR}`,
      `104 1 less ${markers.exe}`,
      `105 1 /bin/sh -c 'cat ${LATEST}/dist/cli.mjs serve'`,
      `106 100 /bin/bash -c 'echo ${DIR}'`,
      `107 1 (node)`,
      `108 1 /usr/bin/sleep 300`,
    ].join('\n');
    const rows = parsePsTable(table);
    assert.equal(rows.length, 9);
    const live = scanOwnedProcesses(rows, { rootPid: 100, dir: DIR, markers });
    assert.deepEqual(live.tree, [100, 101]);
    assert.deepEqual(live.orphans, [102]);
    const gone = scanOwnedProcesses(rows.filter((row) => row.pid !== 100 && row.pid !== 101), {
      rootPid: 100, dir: DIR, markers,
    });
    assert.deepEqual(gone.tree, []);
    assert.deepEqual(gone.orphans, [102]);
  });
});
