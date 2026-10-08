// Mark first-load onboarding as seen in an owned isolated Console before the first navigation, and optionally
// lay down the deputy and Wiki fixtures a scenario needs.
//
// Keys come from the current source, not a copied list: the core contributions, each built-in plugin's client
// entry (read the way the Console's plugin registry reads it), the seen-store key rules, and the seen keys that
// live outside any contribution. Run it with the Console package's tsx so the TypeScript sources resolve:
//
//   pnpm --dir <worktree>/runtime/fleet-console exec tsx \
//     <worktree>/.claude/skills/console-e2e/scripts/seed-onboarding.mts \
//     --console-dir "$E2E_DIR/console" [--keep <key> ...] [--init-script <file>] \
//     [--deputy <id> ...] [--wiki <entry-id> --theater <theater-id> --theater-dir <path>] [--dry-run]
//
// --keep leaves a key (or every key with that prefix, e.g. `objectives.`) unseeded, removing it if already stored, when that layer is under test.
// --init-script writes a page script setting the per-origin What's New watermark; pass it to the browser session.
// --deputy turns on a scuttlebutt deputy and marks the deputy introduction as shown, through the plugin's settings route.
// --wiki stages one Wiki entry through the product's wiki_ingest tool and approves it for the Theater registered from --theater-dir.
// Only loopback writes go to the owned Console named by its lock; no token is read or printed.
import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { OnboardingContribution } from "../../../../runtime/fleet-console/sdk/onboarding/types.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const consoleSrc = join(root, "runtime/fleet-console");
const pluginsDir = join(root, "runtime/fleet-plugins");
const load = (path: string) => import(pathToFileURL(path).href);

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const repeated = (name: string) => args.flatMap((arg, index) => (args[index - 1] === name ? [arg] : []));
const keep = repeated("--keep");
const deputies = repeated("--deputy");
const consoleDir = option("--console-dir");
const initScript = option("--init-script");
const wikiId = option("--wiki");
const theaterId = option("--theater");
const theaterDir = option("--theater-dir");
const dryRun = args.includes("--dry-run");
if (!consoleDir && !dryRun) throw new Error("Pass --console-dir <owned FLEET_CONSOLE_DATA_DIR> or --dry-run.");
if (wikiId && (!theaterId || !theaterDir)) throw new Error("--wiki needs --theater <id> and --theater-dir <the folder that Theater was added from>.");

// Plugin client entries import their stylesheets and some compile JSX in classic mode under tsx; neither
// matters for reading their exports, so stylesheets resolve to an empty module and React is made global.
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
  return /\\.css(\\?.*)?$/.test(specifier) ? { url: "data:text/javascript,export default {}", shortCircuit: true } : next(specifier, context);
}`)}`);
(globalThis as { React?: unknown }).React ??= (await load(createRequire(join(consoleSrc, "package.json")).resolve("react"))).default;

const { CORE_ONBOARDING } = await load(join(consoleSrc, "core/client/src/integration/onboarding.ts"));
const { hintSeenKey, tourSeenKey } = await load(join(consoleSrc, "features/onboarding/client/seen-store.ts"));
const { COMMISSIONING_SEEN_KEY } = await load(join(consoleSrc, "core/client/src/integration/store.ts"));
const { EFFORT_CONFIRM_TIP_SEEN_KEY } = await load(join(consoleSrc, "features/workspace/client/canvas/canvas-context-menu.tsx"));
const { WHATS_NEW_SEEN_VERSION_STORAGE_KEY } = await load(join(consoleSrc, "features/updates/client/release-state.ts"));

// The Console composes built-in plugins from each `client/index.tsx` `plugins` export (virtual:fleet-plugins in
// core/client/vite.config.ts), and its registry takes `onboarding` from each plugin definition.
const contributions: OnboardingContribution[] = [...CORE_ONBOARDING];
for (const plugin of readdirSync(pluginsDir)) {
  const entry = join(pluginsDir, plugin, "client/index.tsx");
  if (!existsSync(entry)) continue;
  const { plugins } = await load(entry) as { plugins?: readonly { onboarding?: OnboardingContribution }[] };
  if (!Array.isArray(plugins)) throw new Error(`${entry} has no plugins export; the registry contract changed.`);
  for (const definition of plugins) if (definition.onboarding) contributions.push(definition.onboarding);
}

// Seen keys outside the contributions: the ones "Replay onboarding" also clears. Their list is the unexported drop set
// in forgetAllOnboarding (core/client/src/chrome/components/command-band-system-cluster.tsx), so a key added there
// needs adding here; --dry-run shows what is covered.
const derived = [COMMISSIONING_SEEN_KEY as string, EFFORT_CONFIRM_TIP_SEEN_KEY as string];
for (const contribution of contributions) {
  const hint = hintSeenKey(contribution);
  if (hint) derived.push(hint);
  for (const tour of contribution.tours ?? []) derived.push(tourSeenKey(tour.id, "spotlight"), tourSeenKey(tour.id, "walkthrough"));
}
const kept = (key: string) => keep.some((entry) => key === entry || (entry.endsWith(".") && key.startsWith(entry)));
const keys = [...new Set(derived)].filter((key) => !kept(key));

// Deputy ids come from the plugin's own settings shape, so a renamed or added deputy is refused or accepted as the product does.
const { getScuttlebuttSettings } = await load(join(pluginsDir, "scuttlebutt/client/settings-store.ts"));
const deputyIds = Object.keys(getScuttlebuttSettings().docked);
const unknownDeputies = deputies.filter((id) => !deputyIds.includes(id));
if (unknownDeputies.length > 0) throw new Error(`Unknown deputy: ${unknownDeputies.join(", ")} (known: ${deputyIds.join(", ")}).`);

// A wrong --theater-dir would let the Wiki resolver migrate that folder's .fleet/knowledge and label it, so the folder
// must hash to the registered Theater id (the id rule in features/workspace/host/theaters/theater-domain.ts) before
// anything is written.
let wikiCwd: string | null = null;
if (wikiId) {
  const { canonicalizeTheaterPathSync, workspaceHash } = await load(join(consoleSrc, "features/workspace/host/theaters/theater-domain.ts"));
  wikiCwd = canonicalizeTheaterPathSync(theaterDir!) as string;
  if (workspaceHash(wikiCwd) !== theaterId) throw new Error(`--theater-dir ${wikiCwd} is not the folder of Theater ${theaterId}; nothing was written.`);
}

if (dryRun) {
  console.log(JSON.stringify({
    keys, kept: derived.filter(kept), whatsNewStorageKey: WHATS_NEW_SEEN_VERSION_STORAGE_KEY,
    deputies: { requested: deputies, known: deputyIds },
    wiki: wikiId ? { entry: wikiId, theater: theaterId } : null,
  }, null, 2));
  process.exit(0);
}

const lock = JSON.parse(readFileSync(join(consoleDir!, "console.lock"), "utf8")) as { port?: number };
if (!lock.port) throw new Error("console.lock has no port yet; wait for the owned server to finish starting.");
const origin = `http://127.0.0.1:${lock.port}`;
const headers = { Origin: origin, "Content-Type": "application/json" };
const getJson = async <T,>(path: string): Promise<T> => {
  const response = await fetch(`${origin}${path}`, { headers });
  if (!response.ok) throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
  return await response.json() as T;
};
const send = async <T,>(method: "PUT" | "POST", path: string, body: unknown): Promise<T> => {
  const response = await fetch(`${origin}${path}`, { method, headers, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
  return await response.json() as T;
};

const status = await getJson<{ version?: string }>("/api/v1/status");
const current = await getJson<{ seenFeatureTours?: string[] }>("/api/v1/settings/global");
// A kept key comes off the stored list too, so a reused slot still shows the layer under test.
const seen = [...new Set([...(current.seenFeatureTours ?? []).filter((key) => !kept(key)), ...keys])];
await send("PUT", "/api/v1/settings/global", { seenFeatureTours: seen });
const after = await getJson<{ seenFeatureTours?: string[] }>("/api/v1/settings/global");
const stored = after.seenFeatureTours ?? [];
const missing = keys.filter((key) => !stored.includes(key));
if (missing.length > 0) throw new Error(`Settings did not keep: ${missing.join(", ")} (the field is bounded; check its limit).`);
const lingering = stored.filter(kept);
if (lingering.length > 0) throw new Error(`Settings still mark kept keys as seen: ${lingering.join(", ")}.`);

if (initScript) {
  if (!status.version) throw new Error("/api/v1/status returned no version for the What's New watermark.");
  writeFileSync(initScript, `localStorage.setItem(${JSON.stringify(WHATS_NEW_SEEN_VERSION_STORAGE_KEY)}, ${JSON.stringify(status.version)});\n`);
}

// The deputy document is written whole, as the plugin's own settings store writes it; unrelated fields survive.
let deputy: Record<string, unknown> | null = null;
if (deputies.length > 0) {
  const settingsPath = "/api/v1/settings/plugins/scuttlebutt";
  const { value } = await getJson<{ value: Record<string, unknown> | null }>(settingsPath);
  const patch = Object.fromEntries(deputies.map((id) => [id, true]));
  await send("PUT", settingsPath, { ...value, ...patch, introduced: true });
  deputy = (await getJson<{ value: Record<string, unknown> | null }>(settingsPath)).value;
  const off = [...deputies, "introduced"].filter((field) => deputy?.[field] !== true);
  if (off.length > 0) throw new Error(`Deputy settings did not keep: ${off.join(", ")}.`);
}

// Wiki entries are written only through the approval queue. The fixture stages one with the product's wiki_ingest
// tool and approves it programmatically, as Cowork's final Apply does, in the knowledge root that Codex resolves
// for this Theater. Reading it back through the Theater's Codex route proves the server serves the same root.
let wiki: { entry: string; patch: string | null; reused: boolean } | null = null;
if (wikiId) {
  const theaters = (await getJson<{ theaters: { id: string }[] }>("/api/v1/theaters")).theaters;
  if (!theaters.some((theater) => theater.id === theaterId)) throw new Error(`Theater ${theaterId} is not registered in the owned Console.`);
  await send("POST", "/api/v1/plugins/codex/workspace", { theaterId });
  const { ensureWorkspaceDirectory, withDirectoryLock } = await load(join(consoleSrc, "foundation/infra/src/index.ts"));
  const { createWikiWorkspaceResolver } = await load(join(pluginsDir, "codex/server/wiki/workspace-resolver.ts"));
  const { buildIngestToolConfig } = await load(join(pluginsDir, "codex/server/wiki/tools/ingest.ts"));
  const { approvePatch } = await load(join(pluginsDir, "codex/server/wiki/patch.ts"));
  const { readWikiEntry } = await load(join(pluginsDir, "codex/server/wiki/store.ts"));
  // Same injected ports as the Codex plugin's register() in runtime/fleet-plugins/codex/routes.ts (MIGRATION_LOCK).
  const cwd = wikiCwd!;
  const paths = createWikiWorkspaceResolver({
    ensureWorkspace: (dir: string) => ensureWorkspaceDirectory(consoleDir, dir),
    withMigrationLock: <T,>(workspace: { path: string }, operation: () => T): T =>
      withDirectoryLock({ lockDir: join(workspace.path, "knowledge.migration.lock") }, operation),
  }).resolve(cwd);
  let patch: string | null = null;
  const reused = Boolean(await readWikiEntry(wikiId, paths));
  if (!reused) {
    const staged = await buildIngestToolConfig().execute("console-e2e-seed", {
      id: wikiId,
      title: `E2E fixture ${wikiId}`,
      body: [
        `This entry is a console-e2e fixture for ${wikiId}.`,
        "It exists so a scenario can open the Wiki panel and find a real, approved entry without a model turn.",
        "Nothing in it is project knowledge; delete the owned run directory to discard it.",
      ].join("\n\n"),
      tags: ["console-e2e"],
      source: "console-e2e seed-onboarding fixture",
      proposer: "console-e2e:seed-onboarding",
      mode: "create",
    }, undefined, undefined, { cwd, paths });
    const result = JSON.parse(staged.content[0].text) as { patch_id?: string };
    if (!result.patch_id) throw new Error(`wiki_ingest staged no patch: ${staged.content[0].text}`);
    await approvePatch(result.patch_id, paths);
    patch = result.patch_id;
  }
  const served = await fetch(`${origin}/console/codex/w/${encodeURIComponent(theaterId!)}/api/entry/${encodeURIComponent(wikiId)}`);
  if (!served.ok) throw new Error(`The Theater's Codex route does not serve ${wikiId} (${served.status}); --theater-dir may not be that Theater's folder.`);
  wiki = { entry: wikiId, patch, reused };
}

console.log(JSON.stringify({
  origin, seeded: keys, kept: derived.filter(kept),
  whatsNew: initScript ? { script: initScript, version: status.version } : null,
  deputy: deputy ? Object.fromEntries([...deputies, "introduced"].map((field) => [field, deputy![field]])) : null,
  wiki,
}, null, 2));
