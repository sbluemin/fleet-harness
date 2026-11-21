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
    /**
     * Per-commodore advanced options of a RUNNING Console through the product's own routes (they own the stored shape, migration
     * markers and versioning). Only "on" | "off" are accepted here: "unset" is not producible in a running Console (see fixtures.mjs
     * and `--offline`). Reports `requested`, `stored` (raw auto-memory field; the prompt/subagents keys are not readable over the API)
     * and `effective` (the product's reading), kept apart because an absent key is not "never saved".
     */
    async advanced(commodoreId, want) {
      const put = (route, body) => api("PUT", `/api/v1/agent/${route}?commodoreId=${encodeURIComponent(commodoreId)}`, body);
      for (const key of ["autoMemory", "basePrompt", "subagents"]) {
        if (want[key] !== "on" && want[key] !== "off") throw new Error(`advanced: ${key} must be "on" or "off" on a running Console, got ${JSON.stringify(want[key])}; for "unset" seed a data dir before its Console starts: seed.mjs --offline.`);
      }
      await api("POST", "/api/v1/commodore/auto-memory", { commodoreId, autoMemoryEnabled: want.autoMemory === "on" });
      await put("commodore-system-prompt", { basePromptEnabled: want.basePrompt === "on" });
      await put("commodore-subagents", { subagentsKept: want.subagents === "on" });
      const stored = await api("POST", "/api/v1/commodore/state", { commodoreId });
      const read = (route) => api("GET", `/api/v1/agent/${route}?commodoreId=${encodeURIComponent(commodoreId)}`);
      return {
        requested: want,
        stored: { autoMemoryEnabled: (stored.state ?? stored).autoMemoryEnabled ?? "absent" },
        effective: { autoMemory: (stored.state ?? stored).autoMemoryEnabled !== false, basePrompt: (await read("commodore-system-prompt")).basePromptEnabled, subagents: (await read("commodore-subagents")).subagentsKept },
      };
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
    /** Commodore sidebar preview: the last assistant line (`lastResponse`), not the person's message. Null until the fake turn records one. */
    async commodoreRow(commodoreId) {
      const { commodores } = await api("POST", "/api/v1/commodore/list", {});
      return commodores?.find((item) => item.commodoreId === commodoreId) ?? null;
    },
    /** Commence through the public route. The owned Console's fake agent runs the turn; this does not call a provider. */
    async commence(objectiveId) {
      return await api("POST", "/api/v1/objectives/commander/start", { objectiveId });
    },
    /** One local sidebar section, with this commodore moved into it. Not a remote-host registration. */
    async section(name, rowId) {
      return await api("POST", "/api/v1/commodore/sidebar", { op: "create", name, rowId });
    },
    /**
     * Turn on only the taskforce experiment of this owned slot, then create one taskforce from the commodores just made.
     * GET experiments are sent back with `taskforce: true` so computerUse stays as stored. This makes no provider call itself, but creating the taskforce wakes its members: the caller must run the Console on the owned fake agent.
     */
    async taskforce({ name, topic, members }) {
      const current = await api("GET", "/api/v1/settings/global");
      const before = current?.experiments ?? {};
      const saved = await api("PUT", "/api/v1/settings/global", { experiments: { ...before, taskforce: true } });
      const after = saved?.state?.experiments;
      if (after?.taskforce !== true) throw new Error("taskforce experiment was not enabled");
      if ((after.computerUse === true) !== (before.computerUse === true)) throw new Error("taskforce seed changed computerUse");
      const created = await api("POST", "/api/v1/taskforce/create", { name, topic, members });
      const taskforceId = created?.taskforce?.id;
      if (typeof taskforceId !== "string") throw new Error("taskforce was not created");
      return { taskforceId, members: [...members] };
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
