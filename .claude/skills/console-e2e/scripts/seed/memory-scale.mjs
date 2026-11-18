#!/usr/bin/env node
/**
 * Seed three commodores on a running owned Console with fixed fleet-memory and intel scales.
 * Procedure: ../../references/seed.md
 *
 *   node memory-scale.mjs --dir <FLEET_CONSOLE_DATA_DIR>
 *
 * POST /api/v1/commodore/memory is read-only (only the Commodore writes). Entries are files
 * under <dir>/commodore/<id>/memory/<branch>/<topic>/<slug>.md in the shape parseEntryFile
 * accepts (runtime/fleet-console/features/commodore/host/memory.ts serializeEntry). This does
 * not write MEMORY.md. Description and intel use the product routes, which wake the commodore,
 * so the Console must be on the owned fake agent. No provider call.
 *
 * stdout is one JSON object (counts and branch distribution read back from the API), also
 * saved as <dir>/memory-scale.json. A second run stops. Refuses the real ~/.fleet root.
 */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openConsole, parseArgs } from "./lib.mjs";

const MARKER = "memory-scale.json";
const BRANCHES = ["person", "theater", "lessons", "crew"];
const TOPICS = {
  person: ["선호", "소통", "역할", "일정", "검토", "언어", "알림"],
  theater: ["구조", "배포", "테스트", "빌드", "의존성"],
  lessons: ["배치", "API", "UI", "운영", "성능", "보안", "데이터", "CI", "릴리스", "문서", "접근성", "캐시", "로그", "마이그레이션"],
  crew: ["지휘관"],
};
// Measured branch mix of a large commodore (person 34, theater 12, lessons 34, crew 1).
const WEIGHTS = [["person", 0.42], ["theater", 0.15], ["lessons", 0.41], ["crew", 0.02]];
const SCALES = [
  { alias: "규모 21", memory: 21, intel: 5, seed: 21 },
  { alias: "규모 80", memory: 80, intel: 12, seed: 80 },
  { alias: "규모 200", memory: 200, intel: 40, seed: 200 },
];
const DAY = 86_400_000;

const fail = (message) => { console.error(`memory-scale: ${message}`); process.exit(1); };

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function plan(count, seed) {
  const r = rng(seed);
  const objectives = Array.from({ length: Math.max(4, Math.round(count / 4)) }, (_, i) => ({ objectiveId: `obj-${seed}-${i}`, title: `합성 목표 ${i + 1}` }));
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    let x = r();
    let branch = "lessons";
    for (const [name, weight] of WEIGHTS) {
      if (x < weight) { branch = name; break; }
      x -= weight;
    }
    if (i < BRANCHES.length) branch = BRANCHES[i];
    const topics = TOPICS[branch];
    const topic = topics[Math.floor(r() * Math.min(topics.length, 1 + Math.ceil(count / 15)))];
    const nSources = r() < 0.75 ? 1 + Math.floor(r() * 2) : 0;
    const sources = [...new Set(Array.from({ length: nSources }, () => objectives[Math.floor(r() * objectives.length)]))];
    entries.push({ branch, topic, slug: `m-${i}`, title: `합성 기억 ${i + 1} (${topic})`, description: `${topic} 갈래의 합성 예시 사실 ${i + 1}.`, sources, links: [], i });
  }
  for (const entry of entries) {
    if (r() >= 0.12) continue;
    const other = entries[Math.floor(r() * entries.length)];
    if (other !== entry) entry.links.push(`${other.branch}/${other.topic}/${other.slug}`);
  }
  return entries;
}

function writeEntries(dir, commodoreId, entries, now) {
  const root = path.join(dir, "commodore", commodoreId, "memory");
  for (const entry of entries) {
    const updated = now - (entry.i % 11) * 2 * DAY;
    const verified = entry.i % 6 === 0 ? now - 40 * DAY : updated;
    const head = {
      title: entry.title,
      description: entry.description,
      sources: entry.sources.map((source) => ({ objectiveId: source.objectiveId, title: source.title })),
      links: entry.links,
      created: new Date(now - 90 * DAY + entry.i * 3_600_000).toISOString(),
      updated: new Date(updated).toISOString(),
      verified: new Date(verified).toISOString(),
    };
    const file = path.join(root, entry.branch, entry.topic, `${entry.slug}.md`);
    mkdirSync(path.dirname(file), { recursive: true });
    const body = ["---", ...Object.entries(head).map(([key, value]) => `${key}: ${JSON.stringify(value)}`), "---", "", "## Why", `${entry.description} 합성 예시.`, "", "## How to apply", "관련 임무에서 이 사실을 먼저 확인한다.", ""];
    writeFileSync(file, body.join("\n"));
  }
}

function tally(entries) {
  const branches = Object.fromEntries(BRANCHES.map((branch) => [branch, 0]));
  let linked = 0;
  for (const entry of entries) {
    if (!Object.hasOwn(branches, entry.branch)) fail(`unexpected branch ${entry.branch}`);
    branches[entry.branch] += 1;
    if (entry.links?.length) linked += 1;
  }
  return { branches, linked };
}

const args = parseArgs(process.argv.slice(2));
const dir = args.get("dir");
if (typeof dir !== "string") fail("--dir <console-data-dir> is required");
const resolved = realpathSync(dir);
const homeFleet = path.join(os.homedir(), ".fleet");
if (resolved === homeFleet || resolved.startsWith(homeFleet + path.sep)) fail(`refusing the real Fleet root under ${homeFleet}`);
const marker = path.join(resolved, MARKER);
try { realpathSync(marker); fail(`${MARKER} already exists; take a fresh slot`); } catch (error) {
  if (error && error.code !== "ENOENT") throw error;
}

const { api } = openConsole(resolved);
const now = Date.now();
const commodores = [];
for (const scale of SCALES) {
  const { commodoreId } = await api("POST", "/api/v1/commodore/create", { alias: scale.alias });
  if (typeof commodoreId !== "string") fail("commodore/create returned no commodoreId");
  await api("POST", "/api/v1/commodore/description", { commodoreId, text: `${scale.alias} — 합성 사령관. 기억 ${scale.memory}개, 정보 ${scale.intel}개.` });
  for (let k = 0; k < scale.intel; k += 1) await api("POST", "/api/v1/commodore/intel/add", { commodoreId, text: `합성 정보 ${k + 1}: 검증용 예시 사실.` });
  writeEntries(resolved, commodoreId, plan(scale.memory, scale.seed), now);
  const listed = await api("POST", "/api/v1/commodore/memory", { commodoreId });
  const entries = listed?.entries ?? [];
  const state = await api("POST", "/api/v1/commodore/state", { commodoreId });
  const intel = state?.state?.intel ?? [];
  if (entries.length !== scale.memory) fail(`${scale.alias}: memory API returned ${entries.length}, expected ${scale.memory}`);
  if (intel.length !== scale.intel) fail(`${scale.alias}: intel API returned ${intel.length}, expected ${scale.intel}`);
  const { branches, linked } = tally(entries);
  commodores.push({ alias: scale.alias, commodoreId, memory: entries.length, intel: intel.length, branches, linked });
}
const ids = { profile: "memory-scale", commodores };
writeFileSync(marker, `${JSON.stringify(ids, null, 2)}\n`);
console.log(JSON.stringify(ids));
