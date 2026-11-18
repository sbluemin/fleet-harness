#!/usr/bin/env node
/**
 * Write an agent-browser --init-script that synthesizes Codex and xAI
 * groups into the page's GET /api/v1/models/roster responses (references/agent-browser.md,
 * "Mock page API responses before navigation").
 *
 *   node model-picker-fixture.mjs --out <absolute-path.js>
 *
 * The groups come from the product catalog via buildModelRoster(target, {claude:'ok',
 * codex:'ok', xai:'ok', 'muse-code':'signed_out'}) — host source,
 * loaded through the worktree's tsx, not a product change. Muse Code is marked
 * signed_out only so an omitted status is not treated as unknown and kept visible.
 * The generated wrapper still forwards every roster request to the real host and
 * appends only the groups the live response does not already contain.
 *
 * SYNTHETIC page fixture. This is not a provider login, device-code, token refresh,
 * or launch. A merged row does not block a real provider call, so do not launch a
 * session on one. The init script's comment and window.__fleetModelPickerFixture
 * say the same thing.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROSTER_SOURCE = 'runtime/fleet-console/features/ai-gateway/host/model-roster.ts';
const TSX_REGISTER = 'runtime/fleet-console/node_modules/tsx/dist/esm/index.mjs';
const SYNTHETIC_IDS = ['gateway:codex', 'gateway:xai'];

function fail(message) {
  process.stderr.write(`model-picker-fixture: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith('--')) fail(`unexpected argument ${JSON.stringify(flag)}`);
    const name = flag.slice(2);
    const value = argv[++i];
    if (!value || value.startsWith('--')) fail(`--${name} needs a value`);
    out[name] = value;
  }
  return out;
}

function worktreeRoot() {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 8; i += 1) {
    if (path.basename(dir) === '.claude') return path.dirname(dir);
    dir = path.dirname(dir);
  }
  return fail('could not resolve the worktree from this script');
}

function catalogGroups(root) {
  const rosterFile = path.join(root, ROSTER_SOURCE);
  const tsx = path.join(root, TSX_REGISTER);
  const loader = `
    import { buildModelRoster } from ${JSON.stringify(pathToFileURL(rosterFile).href)};
    const statuses = { claude: 'ok', codex: 'ok', xai: 'ok', 'muse-code': 'signed_out' };
    const want = new Set(${JSON.stringify(SYNTHETIC_IDS)});
    const pick = (target) => buildModelRoster(target, statuses).filter((group) => want.has(group.id));
    process.stdout.write(JSON.stringify({ launch: pick('launch'), agent: pick('agent') }));
  `;
  let raw;
  try {
    raw = execFileSync(process.execPath, ['--import', tsx, '--input-type=module', '-e', loader], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
  } catch (error) {
    const stderr = error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    return fail(`could not load buildModelRoster (${stderr || error.message})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('buildModelRoster did not return JSON');
  }
  for (const target of ['launch', 'agent']) {
    const groups = parsed[target];
    if (!Array.isArray(groups) || groups.map((group) => group.id).join(',') !== SYNTHETIC_IDS.join(',')) {
      return fail(`${target} catalog groups were ${JSON.stringify(groups?.map?.((group) => group?.id))}, expected ${SYNTHETIC_IDS.join(',')}`);
    }
    for (const group of groups) {
      if (!Array.isArray(group.rows) || group.rows.length === 0) fail(`${target} ${group.id} has no rows`);
    }
  }
  return parsed;
}

function initScript(groups) {
  const embedded = JSON.stringify(groups);
  return `/* SYNTHETIC page fixture — not a provider login.
   Codex and xAI groups below were copied from the product catalog
   (buildModelRoster with those providers marked ok) and are merged into this
   page's GET /api/v1/models/roster responses only. The live host is still called.
   A merged row does not block a real provider call: do not launch on one.
   window.__fleetModelPickerFixture.synthetic is the same marker. */
(() => {
  const SYNTHETIC = ${embedded};
  const nativeFetch = window.fetch.bind(window);
  const hits = (window.__fleetE2EMockHits = []);
  window.__fleetModelPickerFixture = {
    synthetic: true,
    providers: ['codex', 'xai'],
    note: 'page response merge only; not a login and not safe to launch',
  };
  window.fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input), location.href);
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    if (url.origin !== location.origin || method !== 'GET' || url.pathname !== '/api/v1/models/roster') {
      return nativeFetch(input, init);
    }
    const signal = init?.signal ?? request?.signal;
    if (signal?.aborted) throw signal.reason;
    const asked = url.searchParams.get('target');
    const target = asked === 'agent' ? 'agent' : asked === 'launch' || asked == null ? 'launch' : null;
    const live = await nativeFetch(input, init);
    if (target === null) return live;
    const copy = live.clone();
    let body;
    try {
      body = await copy.json();
    } catch {
      return live;
    }
    if (!live.ok || !body || !Array.isArray(body.roster)) return live;
    const present = new Set(body.roster.map((group) => group && group.id));
    const extra = SYNTHETIC[target].filter((group) => group && !present.has(group.id));
    hits.push({ method, pathname: url.pathname, target, merged: extra.map((group) => group.id) });
    const headers = new Headers(live.headers);
    headers.set('content-type', 'application/json');
    headers.delete('content-length');
    return new Response(JSON.stringify({ ...body, roster: body.roster.concat(extra) }), {
      status: live.status,
      statusText: live.statusText,
      headers,
    });
  };
})();
`;
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.out || !path.isAbsolute(opts.out)) fail('--out <absolute path> is required');
const root = worktreeRoot();
const groups = catalogGroups(root);
const destination = path.resolve(opts.out);
mkdirSync(path.dirname(destination), { recursive: true });
writeFileSync(destination, initScript(groups), 'utf8');
const summary = ['launch', 'agent'].map((target) => {
  const parts = groups[target].map((group) => `${group.id}(${group.rows.length})`);
  return `${target}: ${parts.join(' ')}`;
}).join('; ');
process.stdout.write(`model-picker-fixture: wrote ${destination}\nSYNTHETIC page merge only, not a login. ${summary}\n`);
