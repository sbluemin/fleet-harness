import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { run } from './e2e-resources.mjs';
import { callerHash } from './isolated-env.mjs';
import { requestControl, servePair } from './owned-focus-pair.mjs';

function arrange(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'f-'));
  t.after(() => fs.rmSync(base, { recursive: true }));
  execFileSync('git', ['init', '-q', base]);
  const fleet = path.join(base, '.fleet');
  fs.mkdirSync(fleet, { mode: 0o700 });
  const env = { FLEET_CONSOLE_WORKSPACE_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: 'focus-test-session' };
  for (const [key, value] of Object.entries(env)) {
    const prior = process.env[key];
    process.env[key] = value;
    t.after(() => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; });
  }
  let index = 0;
  let pid = 500;
  const newRun = () => {
    index++;
    const opts = { objective: 'focus-test', runDir: path.join(fleet, `e2e-${index}`), receiptFile: path.join(base, `${index}.json`) };
    const initialized = run(['init', '--objective', opts.objective, '--run-dir', opts.runDir, '--receipt', opts.receiptFile]);
    assert.equal(initialized.exit, 0, JSON.stringify(initialized));
    fs.mkdirSync(path.join(opts.runDir, 'tmp'), { mode: 0o700 });
    return opts;
  };
  function start(opts, { partial = false } = {}) {
    const children = {};
    const reports = [];
    let setReady;
    const readiness = new Promise((resolve) => { setReady = resolve; });
    const task = servePair(opts, callerHash(), async (_, runId) => (role) => {
      pid++;
      const identity = { pid, runId, role, startedAt: '1795306459.118947', windowId: pid + 1000 };
      let finish;
      const child = {
        role, pid, identity, outcome: null, requests: [], leaseClosed: false,
        done: new Promise((resolve) => { finish = resolve; }),
        closeLease() { child.leaseClosed = true; end({ code: 0 }); },
        async send(request) {
          child.requests.push(request.action);
          if (partial && role === 'target') {
            end({ code: 1 });
            throw Object.assign(new Error('launch failure'), { code: 'fixture_channel_ended' });
          }
          if (request.action === 'snapshot') return { snapshot: { identity: child.identity, text: '' } };
          if (request.action === 'stop') { end({ code: 0 }); return { stopping: true }; }
          if (request.action === 'input') return { posted: true };
          throw new Error('unexpected request');
        },
      };
      function end(outcome) { if (!child.outcome) { child.outcome = outcome; finish(outcome); } }
      children[role] = child;
      return child;
    }, (event) => {
      reports.push(event);
      if (event.state === 'ready') setReady(event);
    });
    return { children, reports, task, ready: Promise.race([readiness, task]) };
  }
  return { newRun, start };
}

test('cross-run input and stop refuse; a changed observed identity prevents stopping either member', async (t) => {
  const { newRun, start } = arrange(t);
  const a = newRun();
  const b = newRun();
  const first = start(a);
  const second = start(b);
  const [, bStatus] = await Promise.all([first.ready, second.ready]);
  const stop = (opts) => requestControl({ ...opts, action: 'stop' });
  try {
    await assert.rejects(requestControl({ ...a, action: 'input', expected: bStatus.windows[0].identity, marker: 'foreign' }), { code: 'fixture_identity_mismatch' });
    await assert.rejects(stop({ ...a, receiptFile: b.receiptFile }), { code: 'receipt_mismatch' });
    const target = first.children.target;
    const original = target.identity;
    target.identity = { ...original, startedAt: '1795306459.118948' };
    try {
      await assert.rejects(stop(a), { code: 'fixture_identity_mismatch' });
      assert.ok(Object.values(first.children).every((child) => child.outcome === null && !child.requests.includes('stop') && !child.requests.includes('input')));
    } finally { target.identity = original; }
    const stopped = await stop(a);
    assert.equal(stopped.outcome, 'stopped');
    await first.task;
    assert.deepEqual(await stop(a), { ...stopped, alreadyStopped: true });
    assert.deepEqual(await requestControl({ ...b, action: 'status' }), { runId: bStatus.runId, windows: bStatus.windows });
    assert.ok(Object.values(second.children).every((child) => child.outcome === null && !child.requests.includes('stop')));
  } finally {
    await Promise.all([stop(a), stop(b)]);
    await Promise.all([first.task, second.task]);
  }
});

test('partial startup closes only leased children, verifies exit, and permits a read-only repeat stop', async (t) => {
  const { newRun, start } = arrange(t);
  const opts = newRun();
  const attempt = start(opts, { partial: true });
  await assert.rejects(attempt.ready, { code: 'fixture_channel_ended' });
  assert.ok(attempt.children['stand-in'].leaseClosed);
  assert.deepEqual(attempt.reports.map(({ outcome, windows }) => [outcome, windows.map(({ exit }) => exit.code)]), [['start_failed', [0, 1]]]);
  assert.equal(fs.existsSync(path.join(opts.runDir, 'tmp', 'focus.sock')), false);
  assert.deepEqual(fs.readdirSync(path.join(opts.runDir, 'tmp')), ['focus-stopped.json']);
  assert.deepEqual(await requestControl({ ...opts, action: 'stop' }), { ...attempt.reports[0], alreadyStopped: true });
});
