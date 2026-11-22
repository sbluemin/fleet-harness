import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const main = 'with-owned-measurement.mjs';
const onDarwin = process.platform === 'darwin' && process.getuid() !== 0;

async function until(check, label) {
  const stop = performance.now() + 10_000;
  for (;;) {
    const result = check();
    if (result) return result;
    if (performance.now() >= stop) assert.fail(`not observed: ${label}`);
    await delay(25);
  }
}

function arrange(t) {
  const id = randomBytes(6).toString('hex');
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(process.env.FLEET_E2E_TEST_SCRATCH ?? tmpdir()), 'measurement-'));
  // The wrapper checks a Darwin Unix socket length even in a no-UI test. Use
  // repo-local owned fixtures when the harness's private scratch path is long.
  const short = Buffer.byteLength(path.join(scratch, '.fleet', 'e2e-a', 'tmp', `tsx-${process.getuid()}`, '9999999.pipe')) <= 103;
  const fixtureRepo = short ? scratch : fs.realpathSync(execFileSync('git', ['-C', scripts, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).split('\n')[0].slice(9));
  const fleet = path.join(fixtureRepo, '.fleet');
  if (short) execFileSync('git', ['init', '-q', fixtureRepo]);
  const lockRoot = fs.realpathSync(execFileSync('/usr/bin/getconf', ['DARWIN_USER_DIR'], { encoding: 'utf8' }).trim());
  const lockName = `fleet-e2e-measurement-test-${id}`;
  const lockDir = path.join(lockRoot, lockName);
  const lockFile = path.join(lockDir, 'focus.lock');
  const runs = [];
  const children = [];
  const measured = new Set();
  const released = [];
  t.after(async () => {
    for (const file of released) fs.writeFileSync(file, 'finish');
    for (const pid of measured) { try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ } }
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(children.map((child) => child.finished));
    for (const runDir of runs) fs.rmSync(runDir, { recursive: true });
    fs.rmSync(lockDir, { recursive: true, force: true }); // Unique test-only namespace, after owned processes are stopped.
    fs.rmSync(scratch, { recursive: true });
  });
  fs.mkdirSync(fleet, { mode: 0o700, recursive: true });
  const cache = path.join(scratch, 'cache');
  fs.mkdirSync(cache, { mode: 0o700 });
  function runFor(role) {
    const objective = `fixture-${role}`;
    const runDir = path.join(fleet, `e2e-m-${id}-${role}`);
    const receipt = path.join(scratch, `${role}.json`);
    const scriptDir = path.join(scratch, `source-${role}`);
    fs.mkdirSync(scriptDir);
    for (const file of [main, 'isolated-env.mjs', 'e2e-resources.mjs', 'stop-owned-desktop.mjs']) {
      fs.copyFileSync(path.join(scripts, file), path.join(scriptDir, file));
    }
    const source = fs.readFileSync(path.join(scripts, 'owned-measurement-lock.c'), 'utf8');
    fs.writeFileSync(path.join(scriptDir, 'owned-measurement-lock.c'), `#define LOCK_DIRECTORY "${lockName}"\n${source}`);
    const env = { ...process.env, FLEET_CONSOLE_WORKSPACE_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: `measurement-${role}`, TMPDIR: scriptDir };
    const init = spawnSync(process.execPath, [path.join(scriptDir, 'e2e-resources.mjs'), 'init', '--objective', objective, '--run-dir', runDir, '--receipt', receipt], { env, encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr + init.stdout);
    runs.push(runDir);
    return { env, runDir, command: [path.join(scriptDir, main), '--objective', objective, '--run-dir', runDir, '--receipt', receipt, '--scratch-dir', cache] };
  }
  const worker = path.join(scratch, 'fixture.mjs');
  fs.writeFileSync(worker, `
    import { spawn } from 'node:child_process';
    import fs from 'node:fs';
    import { setTimeout as sleep } from 'node:timers/promises';
    const log = (event, fields) => fs.writeSync(1, JSON.stringify({ event, ...fields }) + '\\n');
    log('module_imported', {});
    export default async ({args}) => {
      const [mode, finish, marker, heartbeat] = args;
      if (mode === 'descendant') {
        const script = 'const fs=require("fs");const [stop,marker,ping]=process.argv.slice(1);fs.writeFileSync(marker,"ready");setInterval(()=>{if(fs.existsSync(stop)){fs.writeFileSync(stop+".seen","");process.exit(0);}fs.appendFileSync(ping,"+");},25);setTimeout(()=>process.exit(2),15000).unref();';
        spawn(process.execPath, ['-e', script, finish + '.child', marker, heartbeat], { detached: true, stdio: 'ignore' }).unref();
      }
      log('work', { pid: process.pid, wrapperPid: process.ppid, tmpDir: process.env.TMPDIR });
      const deadline = Date.now() + 15000;
      while (finish && !fs.existsSync(finish) && Date.now() < deadline) await sleep(20);
    };
  `);
  function start(run, mode, ...args) {
    const child = spawn(process.execPath, [...run.command, '--module', worker, '--', mode, ...args], { env: run.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = [];
    const lines = [];
    for (const input of [child.stdout, child.stderr]) {
      createInterface({ input }).on('line', (line) => {
        lines.push(line);
        try {
          const row = JSON.parse(line);
          log.push(row);
          if (row.event === 'measurement_start') measured.add(row.pid);
          if (row.event === 'measurement_end') measured.delete(row.pid);
        } catch { /* the wrapper also emits human-readable status */ }
      });
    }
    child.finished = once(child, 'exit');
    const drained = once(child, 'close');
    children.push(child);
    return {
      wait: (event) => until(() => log.find((row) => row.event === event) ||
        (child.exitCode !== null && assert.fail(`${event} missing: ${lines.join('\n')}`)), event),
      log, exited: child.finished,
      async result(code) {
        await drained;
        assert.equal(child.exitCode, code, lines.join('\n'));
        return log;
      },
    };
  }
  const file = (name) => path.join(scratch, name);
  return { runFor, start, lockDir, lockFile, file, measured, onCleanupFinish: (name) => released.push(name) };
}

test('independent owned runners yield before import and recover after normal return and a killed measurement process', { skip: !onDarwin, timeout: 60_000 }, async (t) => {
  const { runFor, start, file, measured, onCleanupFinish } = arrange(t);
  const a = runFor('a');
  const b = runFor('b');
  const done = file('done');
  const first = start(a, 'held', done);
  const cold = await first.wait('measurement_start');
  assert.equal(cold.cacheHit, false);
  assert.equal((await first.wait('work')).tmpDir, path.join(a.runDir, 'tmp'));

  async function expectBusy() {
    const rows = await start(b, 'blocked').result(75);
    assert.deepEqual(rows.map((row) => row.event), ['measurement_busy']);
    assert.equal(rows[0].cacheHit, true);
    t.diagnostic(`warm busy prepare=${rows[0].prepareMs} ms lock=${rows[0].lockMs} ms`);
  }
  await expectBusy();
  fs.writeFileSync(done, 'finish');
  const firstLog = await first.result(0);
  assert.equal(firstLog.find((row) => row.event === 'measurement_end').outcome, 'completed');
  const next = await start(b, 'normal').result(0);
  assert.equal(next.find((row) => row.event === 'work').tmpDir, path.join(b.runDir, 'tmp'));
  const warm = next.find((row) => row.event === 'measurement_start');
  t.diagnostic(`cold prepare=${cold.prepareMs} ms lock=${cold.lockMs} ms; warm acquire prepare=${warm.prepareMs} ms lock=${warm.lockMs} ms`);

  const finish = file('aborted');
  onCleanupFinish(`${finish}.child`);
  const marker = file('descendant');
  const heartbeat = file('heartbeat');
  const aborted = start(a, 'descendant', finish, marker, heartbeat);
  const worker = await aborted.wait('work');
  await until(() => fs.existsSync(marker) && fs.existsSync(heartbeat), 'unrelated descendant running');
  // Kill only the captured inner wrapper from this fixture, not the actual worker.
  process.kill(worker.wrapperPid, 'SIGKILL');
  assert.deepEqual(await aborted.exited, [137, null]);
  await expectBusy();
  process.kill(worker.pid, 'SIGKILL');
  await until(() => {
    try { process.kill(worker.pid, 0); return false; }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  }, 'only this measurement PID exited');
  measured.delete(worker.pid);
  const before = fs.statSync(heartbeat).size;
  const recovered = await start(b, 'recovered').result(0);
  assert.ok(recovered.some(({ event }) => event === 'measurement_start'));
  await until(() => fs.statSync(heartbeat).size > before, 'unrelated descendant survived reacquisition');
  fs.writeFileSync(`${finish}.child`, 'finish');
  await until(() => fs.existsSync(`${finish}.child.seen`), 'unrelated descendant observed cleanup');
});

test('unsafe rendezvous paths fail closed rather than being reported as busy', { skip: !onDarwin, timeout: 45_000 }, async (t) => {
  const { runFor, start, lockDir, lockFile, file } = arrange(t);
  const run = runFor('a');
  const target = file('untouched');
  fs.writeFileSync(target, 'sentinel');
  fs.mkdirSync(lockDir, { mode: 0o700 });
  fs.symlinkSync(target, lockFile);
  const symlink = await start(run, 'no launch').result(2);
  assert.deepEqual(symlink.map(({ event, code }) => [event, code]), [['measurement_error', 'measurement_lock_failed']]);
  assert.equal(fs.readFileSync(target, 'utf8'), 'sentinel');
  assert.equal(fs.readlinkSync(lockFile), target);
  fs.unlinkSync(lockFile); // This fixture symlink was never an acquired lock.
  fs.writeFileSync(lockFile, '', { mode: 0o644 });
  fs.chmodSync(lockFile, 0o644);
  const publicFile = await start(run, 'no launch').result(2);
  assert.deepEqual(publicFile.map(({ event, code }) => [event, code]), [['measurement_error', 'measurement_lock_failed']]);
  assert.equal(fs.statSync(lockFile).mode & 0o777, 0o644);
});
