#!/usr/bin/env node
/**
 * Seed an owned, isolated Fleet Console with commodores, theaters and (optionally) objectives. Procedure: ../../references/seed.md
 *
 *   node seed.mjs --dir <FLEET_CONSOLE_DATA_DIR> --profile empty|basic|multi|objectives
 *        [--commodores N] [--theaters M] [--objectives K]
 *        [--root <dir for theater folders>]          default: <dir>/../seed-theaters (created)
 *        [--fake-claude-dir <FAKE_CLAUDE_DIR>]       required by objectives: the fake agent adds the objectives
 *
 * Prints one JSON object (the ids) on stdout and writes it to <dir>/seed-ids.json; progress goes to stderr.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROFILES } from "./fixtures.mjs";
import { assemble, openConsole, parseArgs, until, writeIds } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const fail = (message) => { console.error(`seed: ${message}`); process.exit(1); };
const dir = args.get("dir");
if (typeof dir !== "string") fail("--dir <console-data-dir> is required");
const name = args.get("profile");
const profile = PROFILES[name];
if (!profile) fail(`--profile must be one of ${Object.keys(PROFILES).join(", ")}`);
const count = (flag, fallback) => (typeof args.get(flag) === "string" ? Number(args.get(flag)) : fallback);
const spec = { ...profile, commodores: count("commodores", profile.commodores), theaters: count("theaters", profile.theaters), objectives: count("objectives", profile.objectives) };
for (const key of ["commodores", "theaters", "objectives"]) if (!Number.isInteger(spec[key]) || spec[key] < 0 || spec[key] > 20) fail(`${key} must be an integer 0..20`);
const fakeDir = args.get("fake-claude-dir");
if (spec.objectives > 0 && typeof fakeDir !== "string") fail("objectives needs --fake-claude-dir (the fake agent creates them through the Commodore tool)");

try {
  const { api } = openConsole(dir);
  const make = assemble(api);
  const root = typeof args.get("root") === "string" ? args.get("root") : path.join(path.dirname(path.resolve(dir)), "seed-theaters");
  const model = spec.objectives > 0 ? await make.model() : null;
  const ids = { profile: name, commodores: [] };
  for (let c = 1; c <= spec.commodores; c += 1) {
    const commodoreId = await make.commodore(`Seed ${c}`);
    const entry = { commodoreId, theaters: [], objectives: [] };
    for (let t = 1; t <= spec.theaters; t += 1) {
      const folder = path.join(root, `c${c}-t${t}`);
      mkdirSync(folder, { recursive: true });
      entry.theaters.push({ theaterId: await make.theater(commodoreId, folder), path: folder });
    }
    for (let o = 1; o <= spec.objectives; o += 1) {
      const title = `Seed objective ${c}.${o}`;
      // The Commodore's `objectives` tool is the only creator: queue one in-process call for the fake agent's next turn, then wake it.
      mkdirSync(fakeDir, { recursive: true });
      writeFileSync(path.join(fakeDir, "sdk-calls"), JSON.stringify({ calls: [{ server: "fleet-commodore", tool: "objectives", args: { action: "add", title, commanderModel: model, theaterId: entry.theaters[0].theaterId } }] }));
      await api("POST", "/api/v1/commodore/message", { commodoreId, text: `Create ${title}` });
      const found = await until(async () => (await make.objectives(commodoreId)).find((item) => item.title === title), 60_000, `objective "${title}"`);
      for (const member of spec.members ?? []) await make.member(found.id, member);
      for (const mission of spec.missions ?? []) await make.mission(found.id, mission);
      entry.objectives.push({ objectiveId: found.id, title });
    }
    ids.commodores.push(entry);
    console.error(`seed: commodore ${c}/${spec.commodores} ready`);
  }
  writeIds(dir, ids);
  console.log(JSON.stringify(ids, null, 2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
