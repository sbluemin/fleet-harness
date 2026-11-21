import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MARKER_FILE, marker, planGroups, splitTurns, turnsFor, validateTurns } from './group-scale.mjs';
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
const run = (slot, extra = [], configDir = slot.config) => spawnSync(process.execPath, [script, '--dir', slot.dir, '--claude-config-dir', configDir, ...extra], { encoding: 'utf8' });
const lines = (file) => readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

describe('group-scale', () => {
  test('plans a long group and a short control inside the product history cap, with unique markers', () => {
    assert.equal(JSON.stringify(splitTurns(500, 3)), JSON.stringify([167, 167, 166]));
    assert.equal(marker('ALPHA', 'planner', 7, 'Q'), 'GS-ALPHA-planner-T007-Q');
    assert.equal(new Set(turnsFor('ALPHA', 'planner', 4).flatMap((turn) => [turn.user, turn.assistant])).size, 8);
    validateTurns({ longTurns: 500, shortTurns: 30 });
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

  test('refuses a live Console, a second run, the real claude home and a transcript the record does not bind, writing nothing', () => {
    const live = makeSlot();
    writeFileSync(path.join(live.dir, 'console.lock'), '{}');
    assert.match(run(live).stderr, /stop the owned Console first/);
    assert.equal(existsSync(path.join(live.dir, MARKER_FILE)), false);

    const again = makeSlot();
    assert.equal(run(again).status, 0);
    assert.match(run(again).stderr, /already exists/);

    const home = makeSlot();
    assert.match(run(home, [], path.join(os.homedir(), '.claude')).stderr, /real ~\/\.claude/);
    assert.equal(existsSync(path.join(home.dir, MARKER_FILE)), false);

    const slot = makeSlot();
    const recordFile = path.join(slot.dir, 'commodore', slot.commodoreId, 'objectives', slot.objectives[1].objectiveId, 'objective.json');
    const record = JSON.parse(readFileSync(recordFile, 'utf8'));
    const elsewhere = path.join(slot.root, 'elsewhere.jsonl');
    writeFileSync(elsewhere, readFileSync(record.session.transcriptPath, 'utf8'));
    record.session.transcriptPath = elsewhere;
    writeFileSync(recordFile, JSON.stringify(record));
    assert.match(run(slot).stderr, /record binds/);
    assert.equal(existsSync(path.join(slot.dir, MARKER_FILE)), false);
    const alphaRecord = JSON.parse(readFileSync(path.join(slot.dir, 'commodore', slot.commodoreId, 'objectives', slot.objectives[0].objectiveId, 'objective.json'), 'utf8'));
    assert.ok(readFileSync(alphaRecord.session.transcriptPath, 'utf8').includes('seed note'), 'a refusal in the second group leaves the first group untouched');
  });
});
