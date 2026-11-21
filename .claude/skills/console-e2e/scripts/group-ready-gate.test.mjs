import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'group-ready-gate.js'), 'utf8');

const ROOT = 'aaaaaaaa-0000-4000-8000-000000000001';
const MEMBER = 'aaaaaaaa-0000-4000-8000-000000000002';
const CONTROL = 'bbbbbbbb-0000-4000-8000-000000000001';
const OTHER = 'cccccccc-0000-4000-8000-000000000001';
const marker = (role, turn, side) => `GS-ALPHA-${role}-T${String(turn).padStart(3, '0')}-${side}`;

const expectLong = {
  rootObjectiveId: ROOT,
  shortControlIds: [CONTROL],
  participants: [
    { objectiveId: ROOT, role: 'commander', rows: 6, firstMarker: marker('commander', 1, 'Q'), lastMarker: marker('commander', 3, 'A') },
    { objectiveId: MEMBER, role: 'planner', rows: 4, firstMarker: marker('planner', 1, 'Q'), lastMarker: marker('planner', 2, 'A') },
  ],
};

function rowsFor(objectiveId, role, turns) {
  return Array.from({ length: turns }, (_, index) => [`Q`, `A`].map((side) => ({ id: `message:${objectiveId}:${index * 3 + (side === 'Q' ? 2 : 3)}`, text: `${marker(role, index + 1, side)} text`, height: 40 }))).flat();
}
const fullRows = () => [...rowsFor(ROOT, 'commander', 3), ...rowsFor(MEMBER, 'planner', 2)];

/** A fake page. Counts geometry reads per row so a test can prove that only sampled rows were measured. */
function makePage(overrides = {}) {
  const page = {
    path: '/console/objectives',
    hidden: false,
    viewport: { width: 1280, height: 577 },
    active: [ROOT],
    activeCurrent: true,
    hasLog: true,
    inert: false,
    logBox: { left: 0, top: 0, width: 800, height: 500 },
    busy: 'false',
    notices: [],
    rows: fullRows(),
    visible: [0, 1, 2],
    deferRows: 0,
    covered: false,
    timeOrigin: 1000,
    ...overrides,
  };
  const reads = new Map();
  const wrap = (row, index) => ({
    index,
    getAttribute: (name) => (name === 'data-entry-id' ? row.id : null),
    get textContent() { return row.text; },
    getBoundingClientRect: () => { reads.set(index, (reads.get(index) ?? 0) + 1); return { height: row.height, width: 700, top: 0, left: 0 }; },
    checkVisibility: (options) => row.skipped !== true && !(row.faded && (options?.opacityProperty || options?.checkOpacity)),
    closest() { return this; },
  });
  const elements = () => page.rows.map(wrap);
  const log = () => {
    const list = elements();
    return {
      getBoundingClientRect: () => page.logBox,
      closest: () => (page.inert ? {} : null),
      getAttribute: (name) => (name === 'aria-busy' ? page.busy : null),
      querySelectorAll: (selector) => {
        if (selector === '.group-chat-column > [data-entry-id]') return list;
        if (selector === '.group-chat-column > [data-defer-layout]') return Array.from({ length: page.deferRows });
        if (selector === '.group-chat-notice') return page.notices.map((text) => ({ textContent: text }));
        return [];
      },
      contains: () => true,
      list,
    };
  };
  let current = null;
  let tick = 0;
  const document = {
    visibilityState: page.hidden ? 'hidden' : 'visible',
    hidden: page.hidden,
    querySelector: (selector) => {
      if (selector !== '.group-chat > .group-chat-log[role="log"]') return null;
      current = page.hasLog ? log() : null;
      return current;
    },
    querySelectorAll: (selector) => (selector === 'li.side-bar-cluster-row--active[data-side-bar-chip-id]'
      ? page.active.map((id) => ({ getAttribute: () => id, querySelector: () => (page.activeCurrent ? {} : null) }))
      : []),
    elementsFromPoint: () => {
      const index = page.visible.length === 0 ? null : page.visible[tick++ % page.visible.length];
      const element = index === null ? undefined : current.list[index];
      // A covering element (dock, dialog) is first in the stack; the row it covers is still in the stack, below it.
      return element ? (page.covered ? [{ closest: () => null }, element] : [element]) : [];
    },
  };
  const context = {
    window: { innerWidth: page.viewport.width, innerHeight: page.viewport.height },
    document,
    location: { pathname: page.path },
    performance: { timeOrigin: page.timeOrigin },
    matchMedia: () => ({ matches: true }),
    CSS: { supports: () => true },
    Date,
    Math,
    setTimeout,
    Promise,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { page, reads, gate: context.window.__fleetGroupReady, context };
}

const reasonOf = (overrides, expect = expectLong) => makePage(overrides).gate.judge(expect).reason;

// The gate's one job is to refuse a measurement start on the wrong or half-drawn screen; each test below is a distinct refusal mechanism.
describe('group-ready-gate', () => {
  test('passes only when the active group, its rows and the viewport agree, whatever the CSS deferral count', () => {
    for (const deferRows of [0, 997]) {
      const verdict = makePage({ deferRows }).gate.judge(expectLong);
      assert.equal(verdict.ok, true, JSON.stringify(verdict));
    }
    // Extra non-marker rows are fine: row counts are floors.
    const extra = [...fullRows(), { id: `membership:${ROOT}:${MEMBER}`, text: 'joined', height: 20 }];
    assert.equal(reasonOf({ rows: extra }), null);
  });

  test('another document, screen or active objective is refused with its own reason', () => {
    assert.equal(reasonOf({ path: '/console/settings' }), 'wrong-document');
    assert.equal(reasonOf({ hasLog: false }), 'wrong-screen');
    assert.equal(reasonOf({ active: [] }), 'no-active-group');
    assert.equal(reasonOf({ active: [CONTROL] }), 'short-control');
    assert.equal(reasonOf({ active: [OTHER] }), 'wrong-group');
  });

  test('the sidebar naming the target while the log still shows another group never passes', () => {
    assert.equal(reasonOf({ rows: rowsFor(CONTROL, 'commander', 3) }), 'wrong-group');
  });

  test('the target group with no, fewer or still-loading records is partial, not wrong-group or short-control', () => {
    assert.equal(reasonOf({ rows: [] }), 'partial');
    assert.equal(reasonOf({ rows: fullRows().slice(0, 7) }), 'partial');
    assert.equal(reasonOf({ rows: fullRows().filter((row) => !row.text.includes(marker('planner', 2, 'A'))) }), 'partial');
    // Unrelated records never make up for a missing one: another group's marker, an out-of-range turn, or a row of another participant.
    const swap = (patch) => fullRows().map((row, index) => (index === 5 ? { ...row, ...patch } : row));
    assert.equal(reasonOf({ rows: swap({ text: `${marker('commander', 99, 'A')} text` }) }), 'partial');
    assert.equal(reasonOf({ rows: swap({ text: 'GS-BETA-commander-T003-A text' }) }), 'partial');
    assert.equal(reasonOf({ rows: swap({ id: `message:${MEMBER}:77` }) }), 'partial');
    assert.equal(reasonOf({ busy: 'true' }), 'partial');
    assert.equal(reasonOf({ notices: ['unavailable'] }), 'partial');
  });

  test('rows at the viewport must be drawn: skipped, empty, absent or chrome-only rows are refused', () => {
    const rows = (patch) => fullRows().map((row, index) => (index < 3 ? { ...row, ...patch } : row));
    assert.equal(reasonOf({ rows: rows({ skipped: true }) }), 'viewport-unrendered');
    assert.equal(reasonOf({ rows: rows({ height: 0 }) }), 'viewport-unrendered');
    assert.equal(reasonOf({ visible: [] }), 'viewport-unrendered');
    assert.equal(reasonOf({ rows: fullRows().map((row) => ({ ...row, faded: true })) }), 'viewport-unrendered', 'a transparent row is not showing');
    assert.equal(reasonOf({}, { ...expectLong, viewport: { width: 1440, height: 900 } }), 'viewport-unrendered');
  });

  test('a row covered by something on top is not counted, even though it is in the hit-test stack', () => {
    assert.equal(reasonOf({ covered: true }), 'viewport-unrendered');
    assert.equal(reasonOf({ covered: false }), null);
  });

  test('a verdict from before a reload is stale-token, even when the reloaded group is fully drawn; a fresh verdict passes', () => {
    const verdict = makePage({ timeOrigin: 1000 }).gate.judge(expectLong);
    assert.equal(verdict.ok, true);
    const after = makePage({ timeOrigin: 2000 });
    assert.equal(after.gate.judge(expectLong).ok, true);
    assert.equal(after.gate.confirm(verdict, expectLong).reason, 'stale-token');
    const same = makePage();
    assert.equal(same.gate.confirm(same.gate.judge(expectLong), expectLong).ok, true);
  });

  test('a still-valid token is re-judged, not trusted', () => {
    const { gate, page } = makePage();
    const verdict = gate.judge(expectLong);
    page.rows = [];
    assert.equal(gate.confirm(verdict, expectLong).reason, 'partial');
  });

  test('geometry is read only from rows under the viewport sample points', () => {
    const more = Array.from({ length: 60 }, (_, index) => ({ id: `message:${ROOT}:${index}`, text: `${marker('commander', (index % 3) + 1, index % 2 ? 'A' : 'Q')} x`, height: 30 }));
    const { gate, reads } = makePage({ rows: [...fullRows(), ...more], visible: [0, 1] });
    gate.judge(expectLong);
    assert.equal(JSON.stringify([...reads.keys()].sort((a, b) => a - b)), JSON.stringify([0, 1]));
  });
});
