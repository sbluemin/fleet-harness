import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseLsofOwnership } from './launch-remote-desktop.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// .../worktrees/<name>/.claude/skills/console-e2e/scripts -> worktree root.
const worktreeRoot = path.resolve(here, '..', '..', '..', '..');

describe('parseLsofOwnership', () => {
  test('accepts an owned loopback listener, tolerating the LISTEN suffix', () => {
    const out = 'cElectron\np111\nf12\ntTCP\nn127.0.0.1:19322 (LISTEN)\n';
    assert.deepEqual(parseLsofOwnership(out, 19322, 111), { ownLoopback: true, foreign: [] });
  });
  test('refuses a listener owned by another PID', () => {
    const out = 'cOther\np424242\nf9\ntTCP\nn127.0.0.1:19322 (LISTEN)\n';
    const parsed = parseLsofOwnership(out, 19322, 111);
    assert.equal(parsed.ownLoopback, false);
    assert.equal(parsed.foreign.length, 1);
    assert.equal(parsed.foreign[0].reason, 'other-pid');
  });
  test('refuses an owned but non-loopback listener', () => {
    const out = 'cElectron\np111\nf12\ntTCP\nn10.0.0.2:19322 (LISTEN)\n';
    const parsed = parseLsofOwnership(out, 19322, 111);
    assert.equal(parsed.ownLoopback, false);
    assert.equal(parsed.foreign[0].reason, 'not-loopback');
  });
  test('ignores other ports and accepts ::1', () => {
    const out = 'cElectron\np111\nf12\ntTCP\nn127.0.0.1:9999 (LISTEN)\n';
    assert.deepEqual(parseLsofOwnership(out, 19322, 111), { ownLoopback: false, foreign: [] });
    const v6 = 'cElectron\np111\nf12\ntTCP\nn[::1]:19322 (LISTEN)\n';
    assert.equal(parseLsofOwnership(v6, 19322, 111).ownLoopback, true);
  });
});

describe('packaged Desktop environment contract (source cross-check)', () => {
  const read = (rel) => fs.readFileSync(path.join(worktreeRoot, rel), 'utf8');
  test('isolation overrides exist in environment.ts', () => {
    const source = read('runtime/fleet-desktop/src/environment.ts');
    for (const name of ['FLEET_CONSOLE_DATA_DIR', 'FLEET_DESKTOP_DATA_DIR', 'FLEET_DATA_DIR']) {
      assert.ok(source.includes(name), `missing ${name}`);
    }
    assert.ok(source.includes('resolveConsoleDirectoryOverride'));
    assert.ok(source.includes('resolveDesktopDataDirectoryOverride'));
  });
  test('an invalid release tag disables remote Console procurement', () => {
    const release = read('runtime/fleet-console/protocol/release/index.ts');
    assert.ok(release.includes('"FLEET_CONSOLE_RELEASE_TAG"'));
    const check = read('runtime/fleet-desktop/src/runtime/release-check.ts');
    assert.ok(check.includes('options.environment ?? process.env'));
    assert.ok(check.includes('unavailable'));
    const main = read('runtime/fleet-desktop/src/main.ts');
    assert.ok(main.includes('createReleaseChecker()'));
  });
  test('the managed child is node cli.mjs serve with cwd at latest', () => {
    const supervisor = read('runtime/fleet-desktop/src/sidecar-supervisor.ts');
    assert.ok(supervisor.includes('[runtime.cliPath, "serve"]'));
    assert.ok(supervisor.includes('cwd: path.dirname(path.dirname(runtime.cliPath))'));
  });
});

describe('mock-SSH remote flow (no real target; loopback only)', () => {
  const MOCK_TARGET = 'mock-remote';
  const REVISION = 'b'.repeat(40);

  const mockSources = {
    // NOTE: these files are named `ssh`/`scp` (no extension), so Node loads
    // them as CommonJS: require() below, no top-level await.
    ssh: `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const argv = process.argv.slice(2);
const env = process.env;
const HOME = env.MOCK_REMOTE_HOME;
let tunnel = false;
let forward = null;
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-o') { i++; continue; }
  if (a === '-N') { tunnel = true; continue; }
  if (a === '-L') { forward = argv[++i]; continue; }
  rest.push(a);
}
const [target, ...cmdParts] = rest;
const MOCK_BIN = path.dirname(process.argv[1]);
if (target !== env.MOCK_TARGET) process.exit(255);
const hold = () => { process.on('SIGTERM', () => process.exit(0)); process.on('SIGINT', () => process.exit(0)); setInterval(() => {}, 1000); };
if (tunnel || cmdParts.length === 0) {
  if (forward && env.MOCK_FORWARD === '1') {
    const m = /^127\\.0\\.0\\.1:(\\d+):127\\.0\\.0\\.1:(\\d+)$/.exec(forward);
    if (!m) process.exit(42);
    const server = net.createServer((client) => {
      const upstream = net.connect({ host: '127.0.0.1', port: Number(m[2]) });
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.pipe(upstream).pipe(client);
    });
    server.listen(Number(m[1]), '127.0.0.1');
  }
  hold();
  return;
}
const cmd = cmdParts.join(' ');
if (env.MOCK_HANG && cmd.includes(env.MOCK_HANG)) { hold(); return; }
if (cmd.includes('connect_ex')) process.exit(env.MOCK_PORT_PROBE === 'occupied' ? 1 : 0);
if (cmd === 'printf %s "$HOME"') {
  if (env.MOCK_FAIL_HOME === '1') process.exit(1);
  process.stdout.write(HOME);
  return;
}
if (cmd.includes('lsof') && /-iTCP:\\d+/.test(cmd) && env.MOCK_LSOF) {
  process.stdout.write(env.MOCK_LSOF);
  return;
}
if (cmd.includes('unzip -q')) {
  materialize(cmd);
  process.stdout.write('Fleet Console.app\\nconsole\\nfleet-package-identity.json\\n');
  return;
}
if (env.MOCK_RM_FAIL === '1' && cmd.includes('rm -rf --') && env.MOCK_RUNID && cmd.includes('e2e-remote-' + env.MOCK_RUNID) && cmd.startsWith('test ! -L')) process.exit(1);
const child = spawn('sh', ['-c', cmd], {
  env: Object.assign({}, process.env, { HOME: HOME, PATH: MOCK_BIN + ':' + process.env.PATH }),
  stdio: ['inherit', 'pipe', 'pipe'],
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on('exit', (code) => process.exit(code ?? 1));
function materialize(cmd) {
  const m = /^cd '([^']+)'/.exec(cmd);
  if (!m) process.exit(99);
  const dir = m[1];
  const rev = env.MOCK_REVISION;
  const identity = env.MOCK_IDENTITY === 'wrong-kind'
    ? JSON.stringify({ schemaVersion: 1, kind: 'something-else', sourceRevision: rev, bundleId: 'com.dotobokuri.fleet-console', productName: 'Fleet Console' })
    : JSON.stringify({ schemaVersion: 1, kind: 'fleet-remote-mac-package', sourceRevision: rev, bundleId: 'com.dotobokuri.fleet-console', productName: 'Fleet Console' });
  const macos = path.join(dir, 'pkg', 'Fleet Console.app', 'Contents', 'MacOS');
  const res = path.join(dir, 'pkg', 'Fleet Console.app', 'Contents', 'Resources');
  const consoleDir = path.join(dir, 'pkg', 'console', 'dist');
  mkdirSync(macos, { recursive: true });
  mkdirSync(res, { recursive: true });
  mkdirSync(consoleDir, { recursive: true });
  const exe = env.MOCK_APP === 'full' ? fullExe() : '#!/bin/sh\\nsleep 300\\n';
  writeFileSync(path.join(macos, 'Fleet Console'), exe, { mode: 0o755 });
  writeFileSync(path.join(res, 'fleet-package-identity.json'), identity + '\\n');
  writeFileSync(path.join(dir, 'pkg', 'fleet-package-identity.json'), identity + '\\n');
  writeFileSync(path.join(dir, 'pkg', 'console', 'fleet-package-identity.json'), identity + '\\n');
  writeFileSync(path.join(dir, 'pkg', 'console', 'package.json'), JSON.stringify({ name: 'fleet-console-staged', version: '9.9.9-test', engines: { node: '>=22' } }));
  writeFileSync(path.join(consoleDir, 'cli.mjs'), '// staged cli\\n');
  writeFileSync(path.join(dir, 'pkg', 'Fleet Console.app', 'Contents', 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?>\\n<plist version="1.0"><dict>\\n' +
    '<key>CFBundleIdentifier</key><string>com.dotobokuri.fleet-console</string>\\n' +
    '<key>CFBundleShortVersionString</key><string>0.0.0-test</string>\\n' +
    '<key>CFBundleExecutable</key><string>Fleet Console</string>\\n' +
    '<key>FleetSourceRevision</key><string>' + rev + '</string>\\n</dict></plist>\\n');
}
function fullExe() {
  return '#!' + process.execPath + '\\n' +
    "const { spawn } = require('child_process');\\n" +
    "const http = require('http');\\n" +
    "const path = require('path');\\n" +
    'let port = 0;\\n' +
    'for (const a of process.argv.slice(2)) { const m = /^--remote-debugging-port=(\\\\d+)$/.exec(a); if (m) port = Number(m[1]); }\\n' +
    'const remoteDir = path.resolve(process.argv[1], "..", "..", "..", "..", "..");\\n' +
    'const latest = path.join(remoteDir, "home", ".fleet", "desktop", "runtime", "console", "latest");\\n' +
    'const child = spawn("/bin/sh", ["-c", "cd " + JSON.stringify(latest) + " && exec -a " + JSON.stringify("node " + latest + "/dist/cli.mjs serve") + " /bin/sleep 300"], { stdio: "ignore" });\\n' +
    'child.on("error", () => {});\\n' +
    'const server = http.createServer((req, res) => {\\n' +
    '  if (req.url === "/json/version") { res.writeHead(200, {"content-type": "application/json"}); res.end(JSON.stringify({ Browser: "Fleet Console Test/0.0.0-test", "Protocol-Version": "1.3" })); }\\n' +
    '  else if (req.url === "/json/list") { res.writeHead(200, {"content-type": "application/json"}); res.end(JSON.stringify([{ id: "MOCKPAGE1", type: "page", url: "http://127.0.0.1:1/console/objectives" }])); }\\n' +
    '  else { res.writeHead(404); res.end(); }\\n' +
    '});\\n' +
    'server.listen(port, "127.0.0.1");\\n' +
    'const die = () => { try { child.kill("SIGKILL"); } catch {} process.exit(0); };\\n' +
    'process.on("SIGTERM", die); process.on("SIGINT", die);\\n';
}
`,
    scp: `#!/usr/bin/env node
const { copyFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const argv = process.argv.slice(2).filter((a, i, all) => a !== '-o' && all[i - 1] !== '-o');
  const [src, dst] = argv.slice(-2);
  const m = /^([^:]+):(.+)$/.exec(dst);
  if (!m || m[1] !== process.env.MOCK_TARGET) process.exit(255);
  if (process.env.MOCK_SCP_SLEEP) await sleep(Number(process.env.MOCK_SCP_SLEEP) * 1000);
  mkdirSync(path.dirname(m[2]), { recursive: true });
  copyFileSync(src, m[2]);
}
process.on('SIGTERM', () => process.exit(0));
main().then(() => {}, () => process.exit(1));
`,
  };

  async function arrange(t, { app = 'sleep', extraEnv = {} } = {}) {
    const base = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'rmtmock-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const bin = path.join(base, 'bin');
    fs.mkdirSync(bin);
    for (const [name, source] of Object.entries(mockSources)) {
      const file = path.join(bin, name);
      fs.writeFileSync(file, source, { mode: 0o755 });
    }
    // `rm` stub: refuses exactly the owned run directory while MOCK_RM_FAIL=1
    // (children like the staged latest stay removable) so both the launcher
    // reclaim and the watchdog backstop observe the failure.
    // Plain sh (no backslash escapes) to keep the nested template intact.
    fs.writeFileSync(path.join(bin, 'rm'), [
      '#!/bin/sh',
      'if [ -n "$MOCK_RUNID" ] && [ "$MOCK_RM_FAIL" = 1 ]; then',
      '  for a in "$@"; do',
      '    case "$a" in',
      '    */.fleet/e2e-remote-"$MOCK_RUNID"|*/.fleet/e2e-remote-"$MOCK_RUNID"/) exit 1;;',
      '    esac;',
      '  done;',
      'fi',
      'exec /bin/rm "$@"',
      '',
    ].join(String.fromCharCode(10)), { mode: 0o755 });
    const remoteHome = path.join(base, 'remote-home');
    fs.mkdirSync(remoteHome, { mode: 0o700 });
    const pkg = path.join(base, 'pkg.zip');
    fs.writeFileSync(pkg, 'mock-zip-bytes');
    const sha = createHash('sha256').update('mock-zip-bytes').digest('hex');
    const freePort = () => new Promise((resolve) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
    });
    const localPort = await freePort();
    const remotePort = await freePort();
    const runId = `m${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`.replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FLEET_E2E_SSH_TARGET: MOCK_TARGET,
      MOCK_TARGET,
      MOCK_REMOTE_HOME: remoteHome,
      MOCK_REVISION: REVISION,
      MOCK_APP: app,
      MOCK_RUNID: runId,
      ...extraEnv,
    };
    const args = [path.join(worktreeRoot, '.claude/skills/console-e2e/scripts/launch-remote-desktop.mjs'),
      base, '--package', pkg, '--package-sha256', sha, '--package-revision', REVISION,
      '--run-id', runId, '--local-port', String(localPort), '--remote-port', String(remotePort),
      '--cdp-timeout-ms', '8000'];
    const remoteDir = path.join(remoteHome, '.fleet', `e2e-remote-${runId}`);
    return { base, bin, remoteHome, pkg, sha, localPort, remotePort, runId, env, args, remoteDir };
  }

  function launch(args, env) {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const done = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    return {
      child, done,
      output: () => ({ stdout, stderr }),
      waitReady: async (timeoutMs = 40000) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const line = stdout.split('\n').find((entry) => entry.includes('"status":"ready"'));
          if (line) return JSON.parse(line);
          if (Date.now() > deadline) throw new Error(`no READY in time; stdout=${stdout.slice(-500)} stderr=${stderr.slice(-2000)}`);
          await new Promise((r) => setTimeout(r, 200));
        }
      },
    };
  }

  const localConnects = (port) => new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });

  const psMatches = async (runId) => {
    const { spawnSync } = await import('node:child_process');
    const out = spawnSync('ps', ['-ax', '-o', 'pid=', '-o', 'ppid=', '-o', 'command='], { encoding: 'utf8' });
    return out.stdout.split('\n').filter((line) => line.includes(`e2e-remote-${runId}`));
  };
  const psHasRun = async (runId) => (await psMatches(runId)).length > 0;
  // Payload processes must be gone; the supervisor shell (matched by its own
  // template) has a bounded drain after the launcher exits, so ignore it while
  // waiting, then require total silence.
  const awaitNoPayload = async (runId, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    let rest = [];
    for (;;) {
      rest = (await psMatches(runId)).filter((line) => !line.includes('sh -c DIR=$1; RUNID='));
      if (rest.length === 0) {
        const lingering = await psMatches(runId);
        if (lingering.length === 0) return [];
        if (Date.now() > deadline) return lingering;
      } else if (Date.now() > deadline) {
        return rest;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  test('full flow reaches READY and reclaims everything on SIGTERM', async (t) => {
    const ctx = await arrange(t, { app: 'full', extraEnv: { MOCK_FORWARD: '1' } });
    const proc = launch(ctx.args, ctx.env);
    const ready = await proc.waitReady();
    assert.equal(ready.runId, ctx.runId);
    assert.equal(ready.packageRevision, REVISION);
    assert.equal(ready.appBundleVersion, '0.0.0-test');
    assert.equal(ready.stagedConsoleVersion, '9.9.9-test');
    assert.ok(ready.browser.includes('Fleet Console Test'));
    assert.equal(ready.consoleTarget.urlPath, '/console/objectives');
    assert.ok(!('worktree' in ready), 'READY must not carry the worktree path');
    assert.ok(fs.existsSync(ctx.remoteDir), 'owned remote dir exists while held');
    const { stdout, stderr } = proc.output();
    assert.equal(stdout.trim().split('\n').length, 1, 'stdout carries only the READY line');
    assert.ok(!stderr.includes(MOCK_TARGET), 'stderr must not expose the SSH target');
    assert.ok(!stderr.includes(ctx.remoteHome), 'stderr must not expose the remote home');
    proc.child.kill('SIGTERM');
    const { code } = await proc.done;
    assert.equal(code, 0);
    assert.ok(!fs.existsSync(ctx.remoteDir), 'owned remote dir reclaimed');
    assert.deepEqual(await awaitNoPayload(ctx.runId), [], 'no owned payload processes remain');
    assert.ok(!(await localConnects(ctx.localPort)), 'tunnel is down');
    const final = proc.output();
    const summaries = final.stderr.split('\n').filter((line) => line.startsWith('remote-reclaim: '));
    assert.ok(summaries.length >= 1);
    const last = JSON.parse(summaries.at(-1).slice('remote-reclaim: '.length));
    assert.equal(last.appGone, true);
    assert.equal(last.dirGone, true);
  });

  test('a listener owned by another PID fails fast without READY', async (t) => {
    const ctx = await arrange(t, {
      app: 'sleep',
      extraEnv: {},
    });
    ctx.env.MOCK_LSOF = `cOther\np424242\nf9\ntTCP\nn127.0.0.1:${ctx.remotePort} (LISTEN)\n`;
    const proc = launch(ctx.args, ctx.env);
    const started = Date.now();
    const { code } = await proc.done;
    assert.equal(code, 1);
    assert.ok(Date.now() - started < 30000, 'fails fast, not at the gate timeout');
    const { stdout, stderr } = proc.output();
    assert.equal(stdout, '', 'no READY line');
    assert.ok(stderr.includes('cdp-listener-owner-mismatch'));
    assert.ok(!fs.existsSync(ctx.remoteDir), 'owned dir still reclaimed');
  });

  test('an identity with the right revision but wrong kind refuses exactly', async (t) => {
    const ctx = await arrange(t, { app: 'sleep', extraEnv: { MOCK_IDENTITY: 'wrong-kind' } });
    const proc = launch(ctx.args, ctx.env);
    const { code } = await proc.done;
    assert.equal(code, 1);
    const { stdout, stderr } = proc.output();
    assert.equal(stdout, '', 'no READY line');
    assert.ok(stderr.includes('package-identity-mismatch'), 'exact field check, not a substring');
    const summaries = stderr.split('\n').filter((line) => line.startsWith('remote-reclaim: '));
    const last = JSON.parse(summaries.at(-1).slice('remote-reclaim: '.length));
    assert.equal(last.appGone, 'not-started', 'nothing launched');
    assert.ok(!fs.existsSync(ctx.remoteDir), 'owned dir still reclaimed');
  });

  test('SIGTERM during transfer reclaims the claimed dir and exits 0', async (t) => {
    const ctx = await arrange(t, { app: 'sleep', extraEnv: { MOCK_SCP_SLEEP: '10' } });
    const proc = launch(ctx.args, ctx.env);
    // Event-driven: the claim finished (dir + marker exist) but the scp sleep
    // means package.zip has not landed yet, so the transfer is in flight.
    const deadline = Date.now() + 30000;
    for (;;) {
      const claimed = fs.existsSync(path.join(ctx.remoteDir, '.e2e-remote-run.json'));
      const landed = fs.existsSync(path.join(ctx.remoteDir, 'package.zip'));
      if (claimed && !landed) break;
      if (Date.now() > deadline) throw new Error('transfer never went in flight');
      await new Promise((r) => setTimeout(r, 200));
    }
    proc.child.kill('SIGTERM');
    const { code } = await proc.done;
    assert.equal(code, 0);
    assert.ok(!fs.existsSync(ctx.remoteDir), 'claimed dir reclaimed after abort');
    const { stderr } = proc.output();
    assert.ok(!stderr.includes(MOCK_TARGET));
  });

  test('SIGTERM while waiting reclaims the app tree and exits 0', async (t) => {
    const ctx = await arrange(t, { app: 'sleep' });
    const proc = launch(ctx.args, ctx.env);
    const deadline = Date.now() + 45000;
    for (;;) {
      if (fs.existsSync(ctx.remoteDir) && await psHasRun(ctx.runId)) break;
      if (Date.now() > deadline) throw new Error('fake app never launched');
      await new Promise((r) => setTimeout(r, 300));
    }
    proc.child.kill('SIGTERM');
    const { code } = await proc.done;
    assert.equal(code, 0);
    assert.ok(!fs.existsSync(ctx.remoteDir));
    assert.deepEqual(await awaitNoPayload(ctx.runId), [], 'owned app tree is gone');
  });

  test('a failed reclaim exits abnormally and reports the remainder', async (t) => {
    const ctx = await arrange(t, { app: 'sleep', extraEnv: { MOCK_RM_FAIL: '1' } });
    const proc = launch(ctx.args, ctx.env);
    const { code } = await proc.done;
    assert.equal(code, 1, 'incomplete reclaim is never exit 0');
    const { stdout, stderr } = proc.output();
    assert.equal(stdout, '', 'no READY line');
    assert.ok(stderr.includes('failed ('));
    assert.ok(!stderr.includes('was not started'), 'the app was started: must not record a clean refusal');
    const summaries = stderr.split('\n').filter((line) => line.startsWith('remote-reclaim: '));
    const last = JSON.parse(summaries.at(-1).slice('remote-reclaim: '.length));
    assert.equal(last.appGone, true, 'the app tree is still stopped');
    assert.equal(last.dirGone, false, 'the launcher reports what it could not remove itself');
  });

  test('an unreachable target fails stable with no selector or home in output', async (t) => {
    const ctx = await arrange(t, { app: 'sleep', extraEnv: { MOCK_FAIL_HOME: '1' } });
    const proc = launch(ctx.args, ctx.env);
    const { code } = await proc.done;
    assert.equal(code, 20);
    const { stdout, stderr } = proc.output();
    assert.equal(stdout, '');
    assert.ok(stderr.includes('ssh-unreachable'));
    assert.ok(!stderr.includes(MOCK_TARGET));
    assert.ok(!stderr.includes(ctx.remoteHome));
  });
});
