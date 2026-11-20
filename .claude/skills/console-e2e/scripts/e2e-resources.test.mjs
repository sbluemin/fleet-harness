import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'e2e-resources.mjs');
const wrapper = path.join(here, 'isolated-env.mjs');

// Short names: the wrapper's tsx socket path limit is checked against the run directory length.
const base = (() => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = path.join(realpathSync(tmpdir()), `e${randomBytes(2).toString('hex').slice(0, 3)}`);
    try { mkdirSync(candidate, { mode: 0o700 }); return candidate; } catch { /* Name taken; try another. */ }
  }
  throw new Error('no short fixture directory');
})();
const repo = path.join(base, 'r');
const fleet = path.join(repo, '.fleet');
const receipts = path.join(base, 'x');
let counter = 0;

before(() => {
  mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
  mkdirSync(fleet, { mode: 0o700 });
  mkdirSync(receipts, { mode: 0o700 });
});
after(() => {
  spawnSync('chmod', ['-R', 'u+rwx', base]);
  rmSync(base, { recursive: true, force: true });
});

function cli(args, env = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'session-a', FLEET_CONSOLE_WORKSPACE_SESSION_ID: '', ...env },
  });
  let document;
  try { document = JSON.parse(result.stdout); } catch { /* Left undefined for the assertion. */ }
  return { status: result.status, document, stdout: result.stdout, stderr: result.stderr };
}

function newRun(objective = 'obj-1', env = {}) {
  counter += 1;
  const runDir = path.join(fleet, `e2e-${counter}`);
  const receipt = path.join(receipts, `t${counter}.json`);
  const result = cli(['init', '--objective', objective, '--run-dir', runDir, '--receipt', receipt], env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return { runDir, receipt, objective, init: result };
}

const evidenceFile = path.join(receipts, 'evidence.txt');
writeFileSync(evidenceFile, 'cleanup evidence\n');
const args = (run, ...rest) => [...rest, '--objective', run.objective, '--receipt', run.receipt];
const resource = (result, index = 0) => result.document.results[index].resources[0];
const reclaimApply = (run, ...extra) => cli(args(run, 'reclaim', '--apply', '--evidence', evidenceFile, ...extra));
const stateDigest = (run) => resource(cli(args(run, 'list'))).inventory.stateDigest;
/** Review-and-accept in one step: the digest of exactly what a `list` just showed. */
const reclaimAll = (run) => {
  const digest = stateDigest(run);
  return reclaimApply(run, ...(digest ? ['--accept-state', digest, '--accept-ref', 'test:separate-authority'] : []));
};

function populate(runDir) {
  for (const dir of ['home', 'tmp', 'root', 'console', 'claude', 'pathbin']) mkdirSync(path.join(runDir, dir), { recursive: true });
  writeFileSync(path.join(runDir, 'home', '.zsh_history'), ': 1;ls\n');
  writeFileSync(path.join(runDir, 'console', 'state.json'), '{}');
  writeFileSync(path.join(runDir, 'serve.log'), 'log\n');
  mkdirSync(path.join(runDir, 'pathbin', 'call-abc'));
  symlinkSync('/usr/bin/true', path.join(runDir, 'pathbin', 'call-abc', 'node'));
  mkdirSync(path.join(runDir, 'tmp', 'tsx-501'));
}

function deadPid() {
  const child = spawnSync(process.execPath, ['-e', '0']);
  return child.pid;
}

function writeLock(runDir, pid, token = 'SECRET-TOKEN-VALUE') {
  mkdirSync(path.join(runDir, 'console'), { recursive: true });
  writeFileSync(path.join(runDir, 'console', 'console.lock'), JSON.stringify({ pid, host: '127.0.0.1', port: 4321, endpoint: 'x', startedAt: Date.now(), token, version: '0' }));
}

describe('init', () => {
  test('creates only a new directory, a marker, an owner record, and an external receipt', () => {
    const run = newRun();
    assert.deepEqual(readdirSync(run.runDir).sort(), ['.e2e-run.json', 'owner']);
    assert.equal(lstatSync(run.runDir).mode & 0o777, 0o700);
    assert.equal(lstatSync(run.receipt).mode & 0o777, 0o600);
    const receipt = JSON.parse(readFileSync(run.receipt, 'utf8'));
    const marker = JSON.parse(readFileSync(path.join(run.runDir, '.e2e-run.json'), 'utf8'));
    assert.equal(receipt.nonce, marker.nonce);
    assert.equal(receipt.objective, 'obj-1');
    assert.ok(!run.init.stdout.includes(receipt.nonce), 'the nonce is never printed');
    assert.ok(Array.isArray(run.init.document.delegated));
  });

  test('refuses an existing path, an existing receipt, and never adopts', () => {
    const run = newRun();
    for (const [dir, receipt] of [[run.runDir, path.join(receipts, 'other.json')], [path.join(fleet, 'e2e-new'), run.receipt]]) {
      const result = cli(['init', '--objective', 'obj-1', '--run-dir', dir, '--receipt', receipt]);
      assert.equal(result.status, 2);
    }
    const preexisting = path.join(fleet, 'e2e-pre');
    mkdirSync(preexisting);
    writeFileSync(path.join(preexisting, 'keep'), 'x');
    const adopt = cli(['init', '--objective', 'obj-1', '--run-dir', preexisting, '--receipt', path.join(receipts, 'adopt.json')]);
    assert.equal(adopt.status, 2);
    assert.equal(adopt.document.error.code, 'path_exists');
    assert.deepEqual(readdirSync(preexisting), ['keep']);
    assert.equal(existsSync(path.join(receipts, 'adopt.json')), false);
  });

  test('refuses layouts outside <main checkout>/.fleet/e2e-*', () => {
    const cases = [
      path.join(fleet, 'worktrees', 'e2e-x'),
      path.join(fleet, 'plain'),
      path.join(repo, 'e2e-x'),
      path.join(base, '.fleet', 'e2e-x'),
      `${fleet}/e2e-a/../e2e-b`,
    ];
    mkdirSync(path.join(base, '.fleet'));
    for (const dir of cases) {
      const result = cli(['init', '--objective', 'obj-1', '--run-dir', dir, '--receipt', path.join(receipts, 'layout.json')]);
      assert.equal(result.status, 2, dir);
      assert.equal(existsSync(path.join(receipts, 'layout.json')), false);
    }
    assert.equal(existsSync(path.join(fleet, 'worktrees')), false);
  });

  test('refuses a symlinked .fleet, a linked worktree checkout, and a receipt inside .fleet', () => {
    const linkedRepo = path.join(base, 'lr');
    mkdirSync(linkedRepo);
    symlinkSync(fleet, path.join(linkedRepo, '.fleet'));
    spawnSync('git', ['init', '-q', linkedRepo]);
    assert.equal(cli(['init', '--objective', 'o', '--run-dir', path.join(linkedRepo, '.fleet', 'e2e-z'), '--receipt', path.join(receipts, 'z.json')]).status, 2);
    assert.equal(cli(['init', '--objective', 'o', '--run-dir', path.join(fleet, 'e2e-in'), '--receipt', path.join(fleet, 'receipt.json')]).status, 2);
    assert.equal(existsSync(path.join(fleet, 'e2e-in')), false);
  });

  test('refuses without a caller identity and with a group-writable receipt directory', () => {
    const noId = cli(['init', '--objective', 'o', '--run-dir', path.join(fleet, 'e2e-noid'), '--receipt', path.join(receipts, 'noid.json')], { CLAUDE_CODE_SESSION_ID: '' });
    assert.equal(noId.status, 2);
    assert.equal(noId.document.error.code, 'no_caller_identity');
    const open = path.join(base, 'open');
    mkdirSync(open, { mode: 0o700 });
    chmodSync(open, 0o770);
    assert.equal(cli(['init', '--objective', 'o', '--run-dir', path.join(fleet, 'e2e-open'), '--receipt', path.join(open, 'r.json')]).status, 2);
    assert.equal(existsSync(path.join(fleet, 'e2e-open')), false);
  });
});

describe('wrapper --fresh with a freshly initialised run directory', () => {
  const freshArgs = (run, ...tail) => [wrapper, '--fresh', '--run-dir', run.runDir, ...tail];
  const wrapperEnv = { ...process.env, CLAUDE_CODE_SESSION_ID: 'session-a', FLEET_CONSOLE_WORKSPACE_SESSION_ID: '' };

  test('passes --check and the first run, then refuses the same directory as an earlier run', () => {
    const run = newRun();
    const check = spawnSync(process.execPath, freshArgs(run, '--check'), { encoding: 'utf8', env: wrapperEnv });
    assert.equal(check.status, 0, check.stderr);
    const first = spawnSync(process.execPath, freshArgs(run, '--', process.execPath, '-e', '0'), { encoding: 'utf8', env: wrapperEnv });
    assert.equal(first.status, 0, first.stderr);
    const again = spawnSync(process.execPath, freshArgs(run, '--check'), { encoding: 'utf8', env: wrapperEnv });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /--fresh/);
  });

  test('accepts an empty serve.log redirect but not output, other files, another caller, or a malformed marker', () => {
    const run = newRun();
    writeFileSync(path.join(run.runDir, 'serve.log'), '');
    assert.equal(spawnSync(process.execPath, freshArgs(run, '--check'), { encoding: 'utf8', env: wrapperEnv }).status, 0);
    writeFileSync(path.join(run.runDir, 'serve.log'), 'earlier output');
    assert.equal(spawnSync(process.execPath, freshArgs(run, '--check'), { encoding: 'utf8', env: wrapperEnv }).status, 1);
    writeFileSync(path.join(run.runDir, 'serve.log'), '');
    writeFileSync(path.join(run.runDir, 'stray'), '');
    assert.equal(spawnSync(process.execPath, freshArgs(run, '--check'), { encoding: 'utf8', env: wrapperEnv }).status, 1);
    rmSync(path.join(run.runDir, 'stray'));
    const other = spawnSync(process.execPath, freshArgs(run, '--check'), { encoding: 'utf8', env: { ...wrapperEnv, CLAUDE_CODE_SESSION_ID: 'session-b' } });
    assert.equal(other.status, 1, 'another session is refused by the owner check');
    writeFileSync(path.join(run.runDir, '.e2e-run.json'), JSON.stringify({ schema: 1, runId: 'x', nonce: 'y' }));
    assert.equal(spawnSync(process.execPath, freshArgs(run, '--check'), { encoding: 'utf8', env: wrapperEnv }).status, 1);
  });
});

describe('list, check, and a reclaim plan are read-only', () => {
  test('report a reclaimable run without changing anything', () => {
    const run = newRun();
    populate(run.runDir);
    const before = readdirSync(run.runDir).sort();
    const receiptBefore = readFileSync(run.receipt, 'utf8');
    for (const command of [['list'], ['check'], ['reclaim']]) {
      const result = cli(args(run, ...command));
      assert.equal(result.status, 1, command.join(' '));
      assert.equal(resource(result).status, 'blocked');
      assert.equal(resource(result).reason, 'unattributed_state');
      assert.equal(resource(result).reclaimable, 'partial');
      assert.equal(result.document.complete, false);
    }
    assert.deepEqual(readdirSync(run.runDir).sort(), before);
    assert.equal(readFileSync(run.receipt, 'utf8'), receiptBefore);
    const list = cli(args(run, 'list'));
    assert.ok(resource(list).inventory.state.length > 0);
    assert.match(resource(list).inventory.stateDigest, /^[0-9a-f]{64}$/);
  });

  test('a receipt of another objective is refused with exit 2 and nothing else is read', () => {
    const run = newRun('obj-1');
    const result = cli(['list', '--objective', 'obj-2', '--receipt', run.receipt]);
    assert.equal(result.status, 2);
    assert.equal(result.document.results[0].error.code, 'objective_mismatch');
    assert.equal(reclaimApplyWith(run, 'obj-2').status, 2);
    assert.equal(existsSync(run.runDir), true);
  });
});

function reclaimApplyWith(run, objective) {
  return cli(['reclaim', '--apply', '--evidence', evidenceFile, '--objective', objective, '--receipt', run.receipt]);
}

describe('reclaim --apply', () => {
  test('needs evidence outside the run and removes a run only with it', () => {
    const run = newRun();
    populate(run.runDir);
    assert.equal(cli(args(run, 'reclaim', '--apply')).status, 2);
    const inside = path.join(run.runDir, 'evidence.txt');
    writeFileSync(inside, 'inside');
    assert.equal(cli(args(run, 'reclaim', '--apply', '--evidence', inside)).status, 2);
    const link = path.join(receipts, 'evidence-link');
    symlinkSync(evidenceFile, link);
    assert.equal(cli(args(run, 'reclaim', '--apply', '--evidence', link)).status, 2);
    assert.equal(existsSync(path.join(run.runDir, 'console')), true, 'a refused call changed nothing');
    rmSync(inside);
    const done = reclaimAll(run);
    assert.equal(done.status, 0, done.stdout);
    assert.equal(resource(done).status, 'reclaimed');
    assert.equal(done.document.complete, true);
    assert.equal(resource(done).evidence.sha256.length, 64);
    assert.equal(existsSync(run.runDir), false);
  });

  test('is safe to run again, and a later directory at the same path is not touched', () => {
    const run = newRun();
    assert.equal(resource(reclaimApply(run)).status, 'reclaimed');
    const again = reclaimApply(run);
    assert.equal(again.status, 0);
    assert.equal(resource(again).status, 'already_gone');
    mkdirSync(run.runDir);
    writeFileSync(path.join(run.runDir, 'theirs'), 'x');
    const reused = cli(args(run, 'check'));
    assert.equal(reused.status, 0);
    assert.equal(resource(reused).status, 'already_gone');
    assert.equal(reclaimApply(run).status, 0);
    assert.deepEqual(readdirSync(run.runDir), ['theirs']);
  });

  test('never prints the nonce or a lock token', () => {
    const run = newRun();
    writeLock(run.runDir, deadPid(), 'TOKEN-MUST-NOT-APPEAR');
    const receipt = JSON.parse(readFileSync(run.receipt, 'utf8'));
    for (const result of [cli(args(run, 'list')), reclaimApply(run)]) {
      assert.ok(!result.stdout.includes('TOKEN-MUST-NOT-APPEAR'));
      assert.ok(!result.stdout.includes(receipt.nonce));
      assert.ok(!result.stderr.includes(receipt.nonce));
    }
  });

  test('leaves other receipts, other objectives, and unrelated e2e directories alone', () => {
    const mine = newRun('obj-1');
    const theirs = newRun('obj-2', { CLAUDE_CODE_SESSION_ID: 'session-b' });
    populate(theirs.runDir);
    const stray = path.join(fleet, 'e2e-stray');
    mkdirSync(stray);
    writeFileSync(path.join(stray, 'data'), 'x');
    assert.equal(resource(reclaimApply(mine)).status, 'reclaimed');
    assert.equal(existsSync(path.join(theirs.runDir, 'console')), true);
    assert.deepEqual(readdirSync(stray), ['data']);
    // The other objective's receipt, called with this objective's id, is refused.
    assert.equal(cli(['reclaim', '--apply', '--evidence', evidenceFile, '--objective', 'obj-1', '--receipt', theirs.receipt]).status, 2);
  });
});

describe('live, unknown, and replaced runs are not deleted', () => {
  test('a live lock blocks everything, including a reused pid, and nothing is removed', async () => {
    const run = newRun();
    populate(run.runDir);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      writeLock(run.runDir, child.pid);
      const before = readFileSync(path.join(run.runDir, 'console', 'console.lock'), 'utf8');
      const result = reclaimApply(run);
      assert.equal(result.status, 1);
      assert.equal(resource(result).reason, 'live_lock');
      assert.equal(existsSync(path.join(run.runDir, 'home', '.zsh_history')), true);
      assert.equal(readFileSync(path.join(run.runDir, 'console', 'console.lock'), 'utf8'), before);
      assert.equal(process.kill(child.pid, 0), true, 'the tool never signalled the process');
    } finally {
      child.kill();
    }
  });

  test('a dead lock, an unreadable lock, a lock symlink, a staging marker, and a running update', () => {
    const run = newRun();
    populate(run.runDir);
    const lock = path.join(run.runDir, 'console', 'console.lock');
    writeFileSync(lock, 'not json');
    assert.equal(resource(cli(args(run, 'check'))).reason, 'lock_unreadable');
    rmSync(lock);
    symlinkSync('/etc/hosts', lock);
    assert.equal(resource(cli(args(run, 'check'))).reason, 'lock_unsafe');
    rmSync(lock);
    writeFileSync(path.join(run.runDir, 'console', '.console.lock.claim-abc'), '');
    assert.equal(resource(cli(args(run, 'check'))).reason, 'lock_pending');
    rmSync(path.join(run.runDir, 'console', '.console.lock.claim-abc'));
    writeFileSync(path.join(run.runDir, 'console', 'update-progress.json'), JSON.stringify({ phase: 'installing', updatedAt: new Date().toISOString() }));
    assert.equal(resource(cli(args(run, 'check'))).reason, 'update_active');
    rmSync(path.join(run.runDir, 'console', 'update-progress.json'));
    writeLock(run.runDir, deadPid());
    assert.equal(resource(cli(args(run, 'check'))).reason, 'unattributed_state');
    assert.equal(resource(reclaimAll(run)).status, 'reclaimed');
  });

  test('a replaced directory or symlink at the recorded path is reported and left untouched', () => {
    const run = newRun();
    populate(run.runDir);
    const moved = `${run.runDir}-moved`;
    renameSync(run.runDir, moved);
    mkdirSync(run.runDir);
    writeFileSync(path.join(run.runDir, 'impostor'), 'x');
    let result = reclaimApply(run);
    assert.equal(result.status, 1);
    assert.equal(resource(result).reason, 'path_replaced');
    assert.deepEqual(readdirSync(run.runDir), ['impostor']);
    assert.equal(existsSync(path.join(moved, 'console')), true, 'the original was not claimed or removed');
    rmSync(run.runDir, { recursive: true });
    symlinkSync(moved, run.runDir);
    result = reclaimApply(run);
    assert.equal(resource(result).reason, 'path_replaced');
    assert.equal(existsSync(path.join(moved, 'console')), true);
    assert.equal(lstatSync(run.runDir).isSymbolicLink(), true);
  });

  test('a marker that does not match the receipt blocks, even in the same inode', () => {
    const run = newRun();
    populate(run.runDir);
    const marker = path.join(run.runDir, '.e2e-run.json');
    const body = JSON.parse(readFileSync(marker, 'utf8'));
    writeFileSync(marker, JSON.stringify({ ...body, nonce: 'f'.repeat(64) }));
    const result = reclaimApply(run);
    assert.equal(resource(result).reason, 'marker_mismatch');
    assert.equal(existsSync(path.join(run.runDir, 'console')), true);
  });

  test('another session\'s owner record blocks', () => {
    const run = newRun();
    writeFileSync(path.join(run.runDir, 'owner'), `${'0'.repeat(16)}\n`);
    assert.equal(resource(reclaimApply(run)).reason, 'owner_mismatch');
    assert.equal(existsSync(path.join(run.runDir, 'owner')), true);
  });

  test('a canonical-slot record blocks', () => {
    const run = newRun();
    writeFileSync(path.join(run.runDir, 'canonical-console.pid'), '123\n');
    assert.equal(resource(reclaimApply(run)).reason, 'canonical_slot');
    assert.equal(existsSync(path.join(run.runDir, 'canonical-console.pid')), true);
  });
});

describe('unrecognised data, nested user artifacts, and partial failure', () => {
  test('a default reclaim removes only attributable files and keeps all state, including nested user artifacts', () => {
    const run = newRun();
    populate(run.runDir);
    mkdirSync(path.join(run.runDir, 'console', 'exports', 'deep'), { recursive: true });
    writeFileSync(path.join(run.runDir, 'console', 'exports', 'deep', 'report.md'), 'a person produced this during the handoff');
    mkdirSync(path.join(run.runDir, 'home', '.cache', 'mine'), { recursive: true });
    writeFileSync(path.join(run.runDir, 'home', '.cache', 'mine', 'notes.txt'), 'and this');
    writeFileSync(path.join(run.runDir, 'tmp', 'scratch.txt'), 'and this one');
    const result = reclaimApply(run);
    assert.equal(result.status, 1);
    assert.equal(resource(result).reason, 'unattributed_state');
    assert.equal(readFileSync(path.join(run.runDir, 'console', 'exports', 'deep', 'report.md'), 'utf8'), 'a person produced this during the handoff');
    assert.equal(readFileSync(path.join(run.runDir, 'home', '.cache', 'mine', 'notes.txt'), 'utf8'), 'and this');
    assert.equal(readFileSync(path.join(run.runDir, 'tmp', 'scratch.txt'), 'utf8'), 'and this one');
    assert.equal(existsSync(path.join(run.runDir, 'serve.log')), false, 'an attributable log was removed');
    assert.equal(existsSync(path.join(run.runDir, 'pathbin', 'call-abc')), false, 'the wrapper\'s per-call links were removed');
    assert.equal(existsSync(path.join(run.runDir, '.e2e-run.json')), true, 'the run stays identifiable');
    assert.equal(existsSync(path.join(run.runDir, '.e2e-reclaiming')), false, 'the claim is released');
    assert.ok(resource(result).remaining.some((entry) => entry.endsWith(`${path.sep}console`)));
    // The evidence file alone, a wrong digest, and a digest of different content all leave it untouched.
    for (const extra of [[], ['--accept-state', 'a'.repeat(64), '--accept-ref', 'r']]) {
      const again = reclaimApply(run, ...extra);
      assert.equal(again.status, 1);
      assert.equal(existsSync(path.join(run.runDir, 'console', 'exports', 'deep', 'report.md')), true);
    }
    assert.equal(resource(reclaimApply(run, '--accept-state', 'a'.repeat(64), '--accept-ref', 'r')).reason, 'state_changed');
  });

  test('an accepted digest is pinned to what was reviewed: a file added afterwards stops removal', () => {
    const run = newRun();
    populate(run.runDir);
    const digest = stateDigest(run);
    writeFileSync(path.join(run.runDir, 'console', 'added-after-review.md'), 'new work');
    const result = reclaimApply(run, '--accept-state', digest, '--accept-ref', 'r');
    assert.equal(result.status, 1);
    assert.equal(resource(result).reason, 'state_changed');
    assert.equal(readFileSync(path.join(run.runDir, 'console', 'added-after-review.md'), 'utf8'), 'new work');
    assert.equal(existsSync(path.join(run.runDir, 'home', '.zsh_history')), true);
    // Reviewing again and accepting the new listing is the only way through.
    assert.equal(resource(reclaimAll(run)).status, 'reclaimed');
  });

  test('a tsx or call directory holding anything but sockets or links is state, not attributable', () => {
    const run = newRun();
    populate(run.runDir);
    writeFileSync(path.join(run.runDir, 'tmp', 'tsx-501', 'keep.txt'), 'x');
    writeFileSync(path.join(run.runDir, 'pathbin', 'call-abc', 'extra.sh'), 'x');
    const result = reclaimApply(run);
    assert.equal(readFileSync(path.join(run.runDir, 'tmp', 'tsx-501', 'keep.txt'), 'utf8'), 'x');
    assert.equal(readFileSync(path.join(run.runDir, 'pathbin', 'call-abc', 'extra.sh'), 'utf8'), 'x');
    assert.equal(resource(result).reason, 'unattributed_state');
  });

  test('names this tool does not recognise are never removed, even with evidence and an accepted digest', () => {
    const run = newRun();
    populate(run.runDir);
    writeFileSync(path.join(run.runDir, 'my-notes.txt'), 'a person wrote this');
    writeFileSync(path.join(run.runDir, 'home', 'report.md'), 'a person wrote this too');
    const result = reclaimAll(run);
    assert.equal(result.status, 1);
    assert.equal(resource(result).reason, 'unrecognized_content');
    assert.deepEqual(resource(result).remaining.sort(), [path.join(run.runDir, 'home', 'report.md'), path.join(run.runDir, 'my-notes.txt')].sort());
    assert.equal(readFileSync(path.join(run.runDir, 'my-notes.txt'), 'utf8'), 'a person wrote this');
    assert.equal(existsSync(path.join(run.runDir, 'console')), true, 'with something unrecognised, state is not removed either');
    assert.equal(reclaimAll(run).status, 1);
    rmSync(path.join(run.runDir, 'my-notes.txt'));
    rmSync(path.join(run.runDir, 'home', 'report.md'));
    const done = reclaimAll(run);
    assert.equal(resource(done).status, 'reclaimed');
    assert.equal(existsSync(run.runDir), false);
  });

  test('a symlink in a known place is never followed; one at a recognised name is removed as a link only after review', () => {
    const run = newRun();
    populate(run.runDir);
    const outside = path.join(base, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'precious'), 'x');
    symlinkSync(outside, path.join(run.runDir, 'tmp', 'link'));
    symlinkSync(outside, path.join(run.runDir, 'claude-link'));
    const result = reclaimAll(run);
    assert.equal(resource(result).reason, 'unrecognized_content');
    assert.equal(existsSync(path.join(run.runDir, 'claude-link')), true);
    rmSync(path.join(run.runDir, 'claude-link'));
    assert.equal(resource(reclaimAll(run)).status, 'reclaimed');
    assert.equal(readFileSync(path.join(outside, 'precious'), 'utf8'), 'x');
  });

  test('a partial failure shows in the remaining list and a repeat of the same call finishes it', () => {
    const run = newRun();
    populate(run.runDir);
    const locked = path.join(run.runDir, 'root', 'locked');
    mkdirSync(locked);
    writeFileSync(path.join(locked, 'f'), 'x');
    chmodSync(locked, 0o500);
    const first = reclaimAll(run);
    assert.equal(first.status, 1);
    assert.equal(resource(first).status, 'blocked');
    assert.ok(resource(first).actions.failed.length > 0, JSON.stringify(resource(first)));
    assert.equal(existsSync(run.runDir), true);
    assert.equal(existsSync(path.join(run.runDir, '.e2e-run.json')), true, 'marker kept so the retry can prove identity');
    assert.equal(cli(args(run, 'check')).status, 1);
    chmodSync(locked, 0o700);
    const second = reclaimAll(run);
    assert.equal(second.status, 0, second.stdout);
    assert.equal(resource(second).status, 'reclaimed');
    assert.equal(reclaimApply(run).status, 0);
  });

  test('an interrupted final step is resumable by the same inode, and new content after it is not touched', () => {
    const run = newRun();
    const receipt = JSON.parse(readFileSync(run.receipt, 'utf8'));
    writeFileSync(run.receipt, JSON.stringify({ ...receipt, closing: { at: new Date().toISOString() } }), { mode: 0o600 });
    rmSync(path.join(run.runDir, '.e2e-run.json'));
    assert.equal(resource(cli(args(run, 'check'))).reason, 'reclaim_pending', 'resumable');
    assert.equal(resource(reclaimApply(run)).status, 'reclaimed');
    const other = newRun();
    const receipt2 = JSON.parse(readFileSync(other.receipt, 'utf8'));
    writeFileSync(other.receipt, JSON.stringify({ ...receipt2, closing: { at: new Date().toISOString() } }), { mode: 0o600 });
    rmSync(path.join(other.runDir, '.e2e-run.json'));
    mkdirSync(path.join(other.runDir, 'console'));
    writeFileSync(path.join(other.runDir, 'console', 'restarted.json'), '{}');
    const refused = reclaimApply(other);
    assert.equal(resource(refused).reason, 'marker_mismatch');
    assert.equal(existsSync(path.join(other.runDir, 'console', 'restarted.json')), true);
  });
});

describe('accepting state is a narrow, per-run, reviewed act', () => {
  test('--accept-state needs --accept-ref, exactly one receipt, and a plan never suggests a digest', () => {
    const a = newRun();
    const b = newRun();
    populate(a.runDir);
    populate(b.runDir);
    const digest = stateDigest(a);
    assert.equal(cli(args(a, 'reclaim', '--apply', '--evidence', evidenceFile, '--accept-state', digest)).status, 2, 'no authority ref');
    assert.equal(cli(args(a, 'reclaim', '--apply', '--evidence', evidenceFile, '--accept-ref', 'r')).status, 2, 'a ref alone names nothing');
    const many = cli(['reclaim', '--apply', '--evidence', evidenceFile, '--accept-state', digest, '--accept-ref', 'r', '--objective', 'obj-1', '--receipt', a.receipt, '--receipt', b.receipt]);
    assert.equal(many.status, 2);
    assert.equal(existsSync(path.join(a.runDir, 'console')), true);
    assert.equal(existsSync(path.join(b.runDir, 'console')), true);
    assert.equal(cli(['reclaim', '--accept-state', digest, '--accept-ref', 'r', '--objective', 'obj-1', '--receipt', a.receipt]).status, 2, 'only with --apply');
    for (const command of [['reclaim'], ['check'], ['reclaim', '--apply', '--evidence', evidenceFile]]) {
      const result = cli(args(a, ...command));
      assert.ok(!result.stdout.includes(digest), `${command.join(' ')} must not print a ready-to-use digest`);
    }
    // A digest from one run never selects another's state.
    const other = reclaimApply(b, '--accept-state', digest, '--accept-ref', 'r');
    assert.equal(resource(other).reason, 'state_changed');
    assert.equal(existsSync(path.join(b.runDir, 'console')), true);
  });

  test('the accepted ref is recorded with the closed receipt', () => {
    const run = newRun();
    populate(run.runDir);
    assert.equal(resource(reclaimAll(run)).status, 'reclaimed');
    assert.equal(JSON.parse(readFileSync(run.receipt, 'utf8')).closed.acceptRef, 'test:separate-authority');
  });

  test('a truncated listing can never be accepted as a whole', () => {
    const run = newRun();
    populate(run.runDir);
    mkdirSync(path.join(run.runDir, 'root', 'many'));
    for (let i = 0; i < 2100; i += 1) writeFileSync(path.join(run.runDir, 'root', 'many', `f${i}`), '');
    const list = resource(cli(args(run, 'list')));
    assert.equal(list.inventory.listingComplete, false);
    assert.ok(list.inventory.state.some((entry) => entry.listingTruncated > 0));
    const result = reclaimAll(run);
    assert.equal(result.status, 1);
    assert.equal(resource(result).reason, 'listing_truncated');
    assert.equal(existsSync(path.join(run.runDir, 'root', 'many', 'f0')), true);
    assert.equal(existsSync(path.join(run.runDir, 'console', 'state.json')), true);
  });

  test('an edit that keeps the size, a rename, and a mode change after review all stop the removal', () => {
    for (const change of [
      (run) => writeFileSync(path.join(run.runDir, 'console', 'state.json'), '[]'),
      (run) => renameSync(path.join(run.runDir, 'console', 'state.json'), path.join(run.runDir, 'console', 'state2.json')),
      (run) => chmodSync(path.join(run.runDir, 'console', 'state.json'), 0o640),
    ]) {
      const run = newRun();
      populate(run.runDir);
      const digest = stateDigest(run);
      change(run);
      const result = reclaimApply(run, '--accept-state', digest, '--accept-ref', 'r');
      assert.equal(resource(result).reason, 'state_changed');
      assert.equal(existsSync(path.join(run.runDir, 'console')), true);
      assert.equal(existsSync(path.join(run.runDir, 'home', '.zsh_history')), true);
    }
  });

  test('names with tabs and newlines are listed unambiguously and covered by the digest', () => {
    const run = newRun();
    populate(run.runDir);
    writeFileSync(path.join(run.runDir, 'console', 'a\tb\nc'), 'x');
    const listing = resource(cli(args(run, 'list'))).inventory.state.find((entry) => entry.name === 'console').listing;
    assert.ok(listing.some((entry) => entry.path === path.join('console', 'a\tb\nc')));
    const digest = stateDigest(run);
    renameSync(path.join(run.runDir, 'console', 'a\tb\nc'), path.join(run.runDir, 'console', 'a\tb\nd'));
    assert.equal(resource(reclaimApply(run, '--accept-state', digest, '--accept-ref', 'r')).reason, 'state_changed');
  });
});

describe('mutual exclusion between reclaim and a starting run', () => {
  const wrapperEnv = { ...process.env, CLAUDE_CODE_SESSION_ID: 'session-a', FLEET_CONSOLE_WORKSPACE_SESSION_ID: '' };

  test('a live reclaim claim blocks another reclaim and the wrapper; a stale claim is replaced', async () => {
    const run = newRun();
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      writeFileSync(path.join(run.runDir, '.e2e-reclaiming'), JSON.stringify({ schema: 1, pid: sleeper.pid, nonce: 'n' }));
      const blocked = reclaimApply(run);
      assert.equal(resource(blocked).reason, 'reclaim_in_progress');
      assert.equal(existsSync(path.join(run.runDir, '.e2e-reclaiming')), true, 'it never removes a claim it does not hold');
      const started = spawnSync(process.execPath, [wrapper, '--run-dir', run.runDir, '--', process.execPath, '-e', '0'], { encoding: 'utf8', env: wrapperEnv });
      assert.equal(started.status, 1);
      assert.match(started.stderr, /being reclaimed/);
      assert.deepEqual(readdirSync(run.runDir).sort(), ['.e2e-reclaiming', '.e2e-run.json', 'owner'], 'the wrapper created nothing');
    } finally {
      sleeper.kill();
    }
    await new Promise((resolve) => sleeper.once('exit', resolve));
    writeFileSync(path.join(run.runDir, '.e2e-reclaiming'), JSON.stringify({ schema: 1, pid: sleeper.pid, nonce: 'n' }));
    assert.equal(resource(reclaimApply(run)).status, 'reclaimed');
  });

  test('a wrapper-run command records itself while it runs, and a reclaim refuses while it is active', () => {
    const run = newRun();
    const probe = `const fs=require('fs');const f=${JSON.stringify(path.join(run.runDir, '.e2e-active.'))}+process.ppid;process.exit(fs.existsSync(f)?0:3)`;
    const result = spawnSync(process.execPath, [wrapper, '--run-dir', run.runDir, '--', process.execPath, '-e', probe], { encoding: 'utf8', env: wrapperEnv });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readdirSync(run.runDir).some((name) => name.startsWith('.e2e-active.')), false, 'removed when the command ends');
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      writeFileSync(path.join(run.runDir, `.e2e-active.${sleeper.pid}`), `${sleeper.pid}\n`);
      const blocked = reclaimAll(run);
      assert.equal(resource(blocked).reason, 'wrapper_active');
      assert.equal(existsSync(path.join(run.runDir, 'home')), true);
      assert.equal(existsSync(path.join(run.runDir, '.e2e-reclaiming')), false);
    } finally {
      sleeper.kill();
    }
  });

  test('a missing wrapper process is not proof that its command or descendants stopped', () => {
    const run = newRun();
    const dead = deadPid();
    const active = path.join(run.runDir, `.e2e-active.${dead}`);
    writeFileSync(active, `${dead}\n`);
    writeFileSync(path.join(run.runDir, 'serve.log'), 'must remain while process ownership is uncertain\n');
    const result = reclaimApply(run);
    assert.equal(result.status, 1);
    assert.equal(resource(result).reason, 'wrapper_exit_unverified');
    assert.equal(existsSync(active), true);
    assert.equal(existsSync(path.join(run.runDir, 'serve.log')), true);
  });
});

describe('preserve', () => {
  test('needs a request, keeper, and release; protects the whole run; reports remaining paths; can be cleared', () => {
    const run = newRun();
    populate(run.runDir);
    assert.equal(cli(args(run, 'preserve', '--request-ref', 'ask:1', '--keeper', 'commander')).status, 2);
    const kept = cli(args(run, 'preserve', '--request-ref', 'ask:1', '--keeper', 'the person', '--release', 'when they say so'));
    assert.equal(kept.status, 0, kept.stdout);
    assert.equal(resource(kept).status, 'preserved');
    assert.equal(kept.document.preserved[0].requestRef, 'ask:1');
    assert.ok(kept.document.preserved[0].remaining.includes(run.runDir));
    const refused = reclaimApply(run);
    assert.equal(refused.status, 0);
    assert.equal(resource(refused).status, 'preserved');
    assert.equal(existsSync(path.join(run.runDir, 'console', 'state.json')), true);
    assert.equal(cli(args(run, 'check')).document.complete, true);
    assert.equal(cli(args(run, 'preserve', '--clear', '--request-ref', 'ask:2')).status, 1, 'cleared: the run is a residual again');
    assert.equal(resource(reclaimAll(run)).status, 'reclaimed');
  });

  test('refuses to preserve a replaced path and a run that no longer exists', () => {
    const run = newRun();
    renameSync(run.runDir, `${run.runDir}-m`);
    mkdirSync(run.runDir);
    const replaced = cli(args(run, 'preserve', '--request-ref', 'r', '--keeper', 'k', '--release', 'x'));
    assert.equal(replaced.status, 2);
    assert.equal(JSON.parse(readFileSync(run.receipt, 'utf8')).preserved, undefined);
    const gone = newRun();
    assert.equal(resource(reclaimApply(gone)).status, 'reclaimed');
    assert.equal(cli(args(gone, 'preserve', '--request-ref', 'r', '--keeper', 'k', '--release', 'x')).status, 2);
  });
});

describe('receipt handling', () => {
  test('refuses a receipt that is readable by others, a symlink, or tampered', () => {
    const run = newRun();
    chmodSync(run.receipt, 0o644);
    assert.equal(cli(args(run, 'list')).status, 2);
    chmodSync(run.receipt, 0o600);
    const link = path.join(receipts, 'link.json');
    symlinkSync(run.receipt, link);
    assert.equal(cli(['list', '--objective', 'obj-1', '--receipt', link]).status, 2);
    const receipt = JSON.parse(readFileSync(run.receipt, 'utf8'));
    writeFileSync(run.receipt, JSON.stringify({ ...receipt, runDir: { ...receipt.runDir, path: path.join(repo, 'src') } }), { mode: 0o600 });
    const tampered = cli(args(run, 'list'));
    assert.equal(tampered.status, 2);
    assert.equal(existsSync(path.join(run.runDir, 'owner')), true);
  });

  test('each of several receipts is judged on its own', () => {
    const a = newRun('obj-1');
    const b = newRun('obj-1');
    writeFileSync(path.join(b.runDir, 'canonical-console.pid'), '1\n');
    const result = cli(['reclaim', '--apply', '--evidence', evidenceFile, '--objective', 'obj-1', '--receipt', a.receipt, '--receipt', b.receipt]);
    assert.equal(result.status, 1);
    assert.equal(result.document.results[0].resources[0].status, 'reclaimed');
    assert.equal(result.document.results[1].resources[0].reason, 'canonical_slot');
    assert.equal(result.document.unexpected.length, 1);
  });

  test('works from a receipt directory like the objective evidence directory (canonical, owner-only)', () => {
    const evidenceLike = path.join(base, 'objectives', 'shared');
    mkdirSync(evidenceLike, { recursive: true, mode: 0o700 });
    chmodSync(path.join(base, 'objectives'), 0o700);
    const runDir = path.join(fleet, 'e2e-ev');
    const receipt = path.join(evidenceLike, 'run.receipt.json');
    assert.equal(cli(['init', '--objective', 'b21e5966-9400-40cb-87b8-8dc6ae1b39aa', '--run-dir', runDir, '--receipt', receipt]).status, 0);
    assert.equal(cli(['check', '--objective', 'b21e5966-9400-40cb-87b8-8dc6ae1b39aa', '--receipt', receipt]).status, 1);
  });
});
