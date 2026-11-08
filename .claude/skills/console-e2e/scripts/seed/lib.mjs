// Shared helpers for the console-e2e seed set: reach an owned Console, call its HTTP API, keep the seeded ids.
// Loopback only; no token is read or printed. Procedure: ../../references/seed.md
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const IDS_FILE = "seed-ids.json";

export function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args.set(argv[i].slice(2), true);
    else { args.set(argv[i].slice(2), next); i += 1; }
  }
  return args;
}

/** Open the Console owned by `dir` (its FLEET_CONSOLE_DATA_DIR) and return `{ origin, api }`. */
export function openConsole(dir) {
  let lock;
  try { lock = JSON.parse(readFileSync(path.join(dir, "console.lock"), "utf8")); } catch { throw new Error(`no console.lock under ${dir}; is the owned Console running?`); }
  if (!lock.port) throw new Error("console.lock has no port yet; wait for the Console to finish starting.");
  const origin = `http://127.0.0.1:${lock.port}`;
  const api = async (method, pathname, body) => {
    const res = await fetch(`${origin}${pathname}`, { method, headers: { Origin: origin, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status} ${text.slice(0, 300)}`);
    try { return text ? JSON.parse(text) : null; } catch { return null; }
  };
  return { origin, api };
}

/** Ownership assembly in one place: commodore -> theaters -> objectives -> members/missions. Each returns the created ids. */
export function assemble(api) {
  return {
    async commodore(alias) {
      const { commodoreId } = await api("POST", "/api/v1/commodore/create", { alias });
      return commodoreId;
    },
    async theater(commodoreId, folder) {
      const grant = await api("POST", "/api/v1/theaters/folder-grants", { path: folder });
      const { theaterId } = await api("POST", "/api/v1/commodore/theaters/add", { commodoreId, folderGrantId: grant.folderGrantId });
      return theaterId;
    },
    async member(objectiveId, member) {
      return await api("POST", "/api/v1/objectives/member/add", { objectiveId, member });
    },
    async mission(objectiveId, mission) {
      return await api("POST", "/api/v1/objectives/mission/add", { objectiveId, mission });
    },
    /** The first model the Console offers; the objective tool and members must name a catalog model. */
    async model() {
      const { candidates } = await api("GET", "/api/v1/ai-gateway/candidates");
      if (!candidates?.length) throw new Error("the Console offers no model candidates");
      return candidates[0].model;
    },
    async objectives(commodoreId) {
      return (await api("POST", "/api/v1/objectives/state", { commodoreId, language: "en" })).objectives ?? [];
    },
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(read, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

/** Seeding twice into one slot would mix states; refuse before anything is created. */
export function assertFreshSlot(dir) {
  const file = path.join(dir, IDS_FILE);
  if (existsSync(file)) throw new Error(`${file} already exists; use a fresh slot (seeding is not additive).`);
}

export function writeIds(dir, ids) {
  const file = path.join(dir, IDS_FILE);
  assertFreshSlot(dir);
  writeFileSync(file, `${JSON.stringify(ids, null, 2)}\n`);
  return file;
}
