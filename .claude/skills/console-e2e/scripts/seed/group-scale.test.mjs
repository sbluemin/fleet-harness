import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MARKER_FILE, planGroups, validateTurns } from './group-scale.mjs';
import { writeTranscript } from './transcript.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'group-scale.mjs');
const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gs-')));
after(() => rmSync(base, { recursive: true, force: true }));

let counter = 0;
/** A slot shaped like the ledger profile's output: seed-ids.json, objective records binding transcripts, and the 2-turn transcripts. */
function makeSlot() {
  counter += 1;
  const root = path.join(base, `slot${counter}`);
  const dir = path.join(root, 'console');
  const config = path.join(root, 'claude');
  const theater = path.join(root, 'theater');
  for (const folder of [dir, config, theater]) mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(root, '.e2e-run.json'), JSON.stringify({ schema: 1, runId: 'x', nonce: 'y' }));
  writeFileSync(path.join(root, 'owner'), 'test');
  const commodoreId = randomUUID();
  const objectives = [['Ledger Alpha', ['planner', 'builder']], ['Ledger Beta', ['scout', 'writer']]].map(([title, roles]) => {
    const objectiveId = randomUUID();
    const members = roles.map((role) => ({ id: randomUUID(), role, sessionId: '' }));
    const sessions = [objectiveId, ...members.map((member) => member.id)].map((id) => ({
      id,
      session: { id, harness: 'claude-code', transcriptPath: writeTranscript({ configDir: config, cwd: theater, sessionId: id, turns: [{ user: 'seed note', assistant: 'seed reply' }] }).path },
    }));
    const recordDir = path.join(dir, 'commodore', commodoreId, 'objectives', objectiveId);
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(path.join(recordDir, 'objective.json'), JSON.stringify({ id: objectiveId, session: sessions[0].session, sessions: sessions.slice(1) }));
    return { objectiveId, title, sessionId: objectiveId, members, turns: 1 };
  });
  writeFileSync(path.join(dir, 'seed-ids.json'), JSON.stringify({ profile: 'ledger', commodores: [{ commodoreId, theaters: [{ theaterId: 't', path: theater }], objectives }] }));
  return { root, dir, config, objectives, commodoreId };
}
// The wrapper's environment, built by hand from the temp slot: the test never reads or uses the real home.
const wrapperEnv = (slot) => ({ PATH: process.env.PATH, HOME: slot.root, FLEET_CONSOLE_DATA_DIR: slot.dir, CLAUDE_CONFIG_DIR: slot.config });
const run = (slot, extra = [], env = wrapperEnv(slot)) => spawnSync(process.execPath, [script, '--dir', slot.dir, '--claude-config-dir', slot.config, ...extra], { encoding: 'utf8', env });
const recordFile = (slot, objective) => path.join(slot.dir, 'commodore', slot.commodoreId, 'objectives', objective.objectiveId, 'objective.json');
const transcripts = (slot) => slot.objectives.flatMap((objective) => {
  const record = JSON.parse(readFileSync(recordFile(slot, objective), 'utf8'));
  return [record.session.transcriptPath, ...record.sessions.map((row) => row.session.transcriptPath)];
});
const snapshotOf = (slot) => JSON.stringify(transcripts(slot).map((file) => readFileSync(file, 'utf8')));
const lines = (file) => readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

describe('group-scale', () => {
  test('refuses scales outside the history and contrast bounds or without a ledger', () => {
    // 3 history events per turn and 600 kept per participant: past that the screen truncates; the pair must also straddle 100 rows.
    assert.throws(() => validateTurns({ longTurns: 900, shortTurns: 30 }), /history cap/);
    assert.throws(() => validateTurns({ longTurns: 50, shortTurns: 30 }), /long group needs/);
    assert.throws(() => validateTurns({ longTurns: 500, shortTurns: 80 }), /short control/);
    assert.throws(() => planGroups({ objectives: [] }, { longTurns: 500, shortTurns: 30 }), /seed the ledger profile first/);
  });

  test('rewrites the bound transcripts in place and records ids, units and the expect objects', () => {
    const slot = makeSlot();
    const result = run(slot);
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    const [alpha, beta] = out.groups;
    assert.equal(alpha.rootObjectiveId, slot.objectives[0].objectiveId);
    assert.equal(alpha.rows, 1000);
    assert.equal(beta.rows, 60);
    assert.equal(JSON.stringify(alpha.participants.map((person) => person.turns)), JSON.stringify([167, 167, 166]));
    for (const person of alpha.participants) {
      const rows = lines(person.transcriptPath);
      assert.equal(rows.length, person.rows);
      assert.ok(rows[0].message.content.startsWith(person.firstMarker));
    }
    assert.equal('transcriptPath' in alpha.expect.participants[0], false, 'expect carries only what the gate judges');
    const stamps = alpha.participants.flatMap((person) => lines(person.transcriptPath).slice(0, 4).map((row) => row.timestamp));
    assert.equal(new Set(stamps).size, stamps.length, 'merged timeline has no timestamp ties');
  });

  test('refuses invalid scale or ownership before the first transcript write', () => {
    const refuse = (slot, pattern, options = {}) => {
      const before = snapshotOf(slot);
      const result = run(slot, options.args, options.env);
      assert.equal(result.status, 1, `${pattern}: ${result.stdout.slice(0, 80)}`);
      assert.match(result.stderr, pattern);
      assert.equal(existsSync(path.join(slot.dir, MARKER_FILE)), false);
      assert.equal(snapshotOf(slot), before, 'a refusal writes nothing');
    };
    refuse(makeSlot(), /--short-turns needs at least 3 turns/, { args: ['--short-turns', '2'] });

    const other = makeSlot();
    refuse(makeSlot(), /isolated-env\.mjs/, { env: { PATH: process.env.PATH } });
    refuse(makeSlot(), /not the wrapper's FLEET_CONSOLE_DATA_DIR/, { env: { ...wrapperEnv(other), PATH: process.env.PATH } });

    const unregistered = makeSlot();
    rmSync(path.join(unregistered.root, '.e2e-run.json'));
    refuse(unregistered, /registration records/);

    const live = makeSlot();
    writeFileSync(path.join(live.dir, 'console.lock'), '{}');
    refuse(live, /stop the owned Console first/);

    // The second group's last participant is bad: the first group must stay untouched too.
    const linked = makeSlot();
    const last = JSON.parse(readFileSync(recordFile(linked, linked.objectives[1]), 'utf8')).sessions[1].session.transcriptPath;
    const target = path.join(linked.root, 'victim.jsonl');
    writeFileSync(target, readFileSync(last, 'utf8'));
    rmSync(last);
    symlinkSync(target, last);
    refuse(linked, /regular file/);

    const elsewhere = makeSlot();
    const record = JSON.parse(readFileSync(recordFile(elsewhere, elsewhere.objectives[1]), 'utf8'));
    for (const place of [path.join(elsewhere.root, 'outside.jsonl'), path.join(elsewhere.config, 'projects', 'other', path.basename(record.session.transcriptPath))]) {
      mkdirSync(path.dirname(place), { recursive: true });
      writeFileSync(place, readFileSync(record.session.transcriptPath, 'utf8'));
      const moved = { ...record, session: { ...record.session, transcriptPath: place } };
      writeFileSync(recordFile(elsewhere, elsewhere.objectives[1]), JSON.stringify(moved));
      refuse(elsewhere, /is not the expected/);
    }

    const again = makeSlot();
    assert.equal(run(again).status, 0);
    assert.match(run(again).stderr, /already exists/);
  });
});
