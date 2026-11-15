// Offline half of the `advanced` seed: write per-commodore advanced options into a Console data dir that has never started,
// by running the product's own storage code (not a copy of its JSON shapes). Run through the Console package's tsx, the way
// ../seed-onboarding.mts is, so the TypeScript sources resolve:
//
//   pnpm --dir <worktree>/runtime/fleet-console exec tsx --tsconfig <worktree>/.claude/skills/console-e2e/scripts/seed/offline.tsconfig.json <worktree>/.claude/skills/console-e2e/scripts/seed/offline.mts \
//     --dir <FLEET_CONSOLE_DATA_DIR> --states '<json: [{alias, autoMemory, basePrompt, subagents}]>'
//
// Values are "on" | "off" | "unset". "unset" runs none of the product's setters, so the stored key stays absent (what a
// commodore saved before the option existed looks like). The product's Console-start hooks that store auto memory false and
// base prompt off at creation (commodore/host/index.ts `create`, bootstrap `created`) are the ones deliberately not run.
// Prints one JSON array of { commodoreId, alias, stored, effective } on stdout. Never run it against a Console that is up: its store caches state.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const consoleSrc = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../runtime/fleet-console");
const load = (path: string) => import(pathToFileURL(join(consoleSrc, path)).href);
const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
const dir = option("--dir");
const states = JSON.parse(option("--states") ?? "[]") as { alias: string; autoMemory: string; basePrompt: string; subagents: string }[];
if (!dir || !states.length) throw new Error("--dir and --states are required");
if (existsSync(join(dir, "console.lock"))) throw new Error(`${dir} has a console.lock: offline seeding is only for a data dir whose Console has not started`);
for (const state of states) for (const key of ["autoMemory", "basePrompt", "subagents"] as const) {
  if (!["on", "off", "unset"].includes(state[key])) throw new Error(`${key} must be on, off or unset`);
}

const { createConsoleDataPaths } = await load("core/host/bootstrap/paths.ts");
const { createCommodoreEntities } = await load("features/commodore/host/entities.ts");
const { createCommodoreStore } = await load("features/commodore/host/store.ts");
const { createConsoleSettingsStore } = await load("features/settings/host/settings-domain.ts");
const { createAgentOptionsService, createCommodoreSystemPromptService } = await load("features/settings/host/agent-options.ts");
const { workspaceHash } = await load("features/workspace/host/theaters/theater-domain.ts");

const paths = createConsoleDataPaths({ env: { FLEET_CONSOLE_DATA_DIR: dir } });
const entities = createCommodoreEntities(join(dir, "commodore"), workspaceHash);
const store = createCommodoreStore({ dirOf: entities.dirOf, commodoreIds: entities.ids, theatersOf: entities.theatersOf, theaterIdsOf: entities.theaterIds, replaceTheatersInIndex: entities.replaceTheatersInIndex, emit: () => {} });
const options = createAgentOptionsService({ store: createConsoleSettingsStore({ paths }), legacyDirs: [] });
const prompts = createCommodoreSystemPromptService(options, (id: string) => entities.dirOf(id) != null);

const out = [];
for (const state of states) {
  const id: string = entities.create();
  store.setAlias(id, state.alias);
  // Auto memory: the store ignores `true` while the field is absent, so "on" is the product's own false -> true transition.
  if (state.autoMemory !== "unset") { store.setAutoMemoryEnabled(id, false); if (state.autoMemory === "on") store.setAutoMemoryEnabled(id, true); }
  if (state.basePrompt !== "unset") prompts.setBasePromptEnabled(id, state.basePrompt === "on");
  if (state.subagents !== "unset") prompts.keepSubagents(id, state.subagents === "on");
  // Read back through the product's own readers. `stored` is what is on disk (absent is not "never saved": setting a default deletes the key);
  // `effective` is the product's interpretation. "on"/"off" requests are not raw true/false keys.
  const agent = options.load();
  out.push({
    commodoreId: id, alias: state.alias,
    stored: { autoMemoryEnabled: store.read(id)?.autoMemoryEnabled ?? "absent", systemPromptMode: agent.claudeCodeCommodoreSystemPrompts?.[id]?.mode ?? "absent", subagentsKey: agent.claudeCodeCommodoreSubagents?.[id] ?? "absent", migrated: agent.commodoreSettingsMigrated?.[id] === true },
    effective: { autoMemory: store.read(id)?.autoMemoryEnabled !== false, basePrompt: prompts.basePromptEnabled(id), subagents: prompts.subagentsKept(id) },
  });
}
console.log(JSON.stringify(out));
