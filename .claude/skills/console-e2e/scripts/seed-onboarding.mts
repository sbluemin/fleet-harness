// Mark first-load onboarding as seen in an owned isolated Console before the first navigation, and optionally
// lay down the deputy and Wiki fixtures a scenario needs.
//
// Keys come from the current source, not a copied list: the core contributions, the feature registry's
// contributions (read from the registry the Console itself composes), the seen-store key rules, and the seen keys
// that live outside any contribution. Run it with the Console package's tsx so the TypeScript sources resolve:
//
//   pnpm --dir <worktree>/runtime/fleet-console exec tsx \
//     <worktree>/.claude/skills/console-e2e/scripts/seed-onboarding.mts \
//     --console-dir "$E2E_DIR/console" [--keep <key> ...] \
//     [--deputy <id> ...] [--wiki <entry-id> --theater <theater-id>] [--dry-run]
//
// --keep leaves a key (or every key with that prefix, e.g. `objectives.`) unseeded, removing it if already stored, when that layer is under test.
// --deputy turns on a scuttlebutt deputy and marks the deputy introduction as shown, through the Scuttlebutt settings route.
// --wiki writes one Wiki entry through the product's wiki_ingest tool into the knowledge of the --theater's commodore.
// Only loopback writes go to the owned Console named by its lock; no token is read or printed.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { OnboardingContribution } from "../../../../runtime/fleet-console/features/onboarding/shared/types.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const consoleSrc = join(root, "runtime/fleet-console");
const featuresDir = join(consoleSrc, "features");
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
const wikiId = option("--wiki");
const theaterId = option("--theater");
const dryRun = args.includes("--dry-run");
if (!consoleDir && !dryRun) throw new Error("Pass --console-dir <owned FLEET_CONSOLE_DATA_DIR> or --dry-run.");
if (wikiId && !theaterId) throw new Error("--wiki needs --theater <id>.");

// Feature client modules import their stylesheets and some compile JSX in classic mode under tsx; neither
// matters for reading their exports, so stylesheets resolve to an empty module and React is made global.
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
  return /\\.css(\\?.*)?$/.test(specifier) ? { url: "data:text/javascript,export default {}", shortCircuit: true } : next(specifier, context);
}`)}`);
(globalThis as { React?: unknown }).React ??= (await load(createRequire(join(consoleSrc, "package.json")).resolve("react"))).default;

const { CORE_ONBOARDING } = await load(join(consoleSrc, "core/client/src/integration/onboarding.ts"));
const { EFFORT_CONFIRM_TIP_SEEN_KEY, hintSeenKey, tourSeenKey } = await load(join(consoleSrc, "features/onboarding/client/seen-store.ts"));
const { COMMISSIONING_SEEN_KEY } = await load(join(consoleSrc, "core/client/src/integration/store.ts"));

// The app passes CORE_ONBOARDING and the feature registry's `onboarding` (core/client/src/app/app.tsx). The registry
// module itself pulls browser-only libraries (xterm), so read every `export const <name>: OnboardingContribution`
// under features/*/client instead; contributions CORE_ONBOARDING already holds are not added twice.
const contributions: OnboardingContribution[] = [...CORE_ONBOARDING];
const declaration = /export const (\w+): OnboardingContribution\b/g;
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? walk(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []);
for (const feature of readdirSync(featuresDir)) {
  const clientDir = join(featuresDir, feature, "client");
  if (!existsSync(clientDir)) continue;
  for (const file of walk(clientDir)) {
    const names = [...readFileSync(file, "utf8").matchAll(declaration)].map((match) => match[1]!);
    if (names.length === 0) continue;
    const module = await load(file) as Record<string, OnboardingContribution | undefined>;
    for (const name of names) {
      const contribution = module[name];
      if (!contribution) throw new Error(`${file} declares ${name} but does not export it.`);
      if (!contributions.includes(contribution)) contributions.push(contribution);
    }
  }
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

// Deputy ids come from the Scuttlebutt feature's own settings shape, so a renamed or added deputy is refused or accepted as the product does.
const { getScuttlebuttSettings } = await load(join(featuresDir, "scuttlebutt/client/settings-store.ts"));
const deputyIds = Object.keys(getScuttlebuttSettings().docked);
const unknownDeputies = deputies.filter((id) => !deputyIds.includes(id));
if (unknownDeputies.length > 0) throw new Error(`Unknown deputy: ${unknownDeputies.join(", ")} (known: ${deputyIds.join(", ")}).`);

if (dryRun) {
  console.log(JSON.stringify({
    keys, kept: derived.filter(kept),
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

// The deputy document is written whole, as the Scuttlebutt settings store writes it; unrelated fields survive.
let deputy: Record<string, unknown> | null = null;
if (deputies.length > 0) {
  const settingsPath = "/api/v1/settings/scuttlebutt";
  const { value } = await getJson<{ value: Record<string, unknown> | null }>(settingsPath);
  const patch = Object.fromEntries(deputies.map((id) => [id, true]));
  await send("PUT", settingsPath, { ...value, ...patch, introduced: true });
  deputy = (await getJson<{ value: Record<string, unknown> | null }>(settingsPath)).value;
  const off = [...deputies, "introduced"].filter((field) => deputy?.[field] !== true);
  if (off.length > 0) throw new Error(`Deputy settings did not keep: ${off.join(", ")}.`);
}

// The fixture writes one entry with the product's wiki_ingest tool in the knowledge root of the commodore that Codex
// resolves for this Theater. Reading it back through that commodore's Codex route proves the server serves the same root.
let wiki: { entry: string; version: number; reused: boolean } | null = null;
if (wikiId) {
  const theaters = (await getJson<{ theaters: { id: string }[] }>("/api/v1/theaters")).theaters;
  if (!theaters.some((theater) => theater.id === theaterId)) throw new Error(`Theater ${theaterId} is not registered in the owned Console.`);
  // Opening the workspace lets the Console issue the commodore and finish any old-wiki migration; the script only writes
  // into the resulting root and never migrates on its own.
  const workspace = await send<{ hasWiki: boolean; id: string | null }>("POST", "/api/v1/codex/workspace", { theaterId });
  if (!workspace.hasWiki || !workspace.id) throw new Error(`Theater ${theaterId} has no commodore knowledge root.`);
  const commodoreId = workspace.id;
  const { createMemoryPaths } = await load(join(featuresDir, "codex/host/wiki/paths.ts"));
  const { buildIngestToolConfig } = await load(join(featuresDir, "codex/host/wiki/tools/ingest.ts"));
  const { readWikiEntry } = await load(join(featuresDir, "codex/host/wiki/store.ts"));
  const paths = createMemoryPaths(join(consoleDir!, "commodore", commodoreId, "knowledge"));
  const reused = Boolean(await readWikiEntry(wikiId, paths));
  if (!reused) {
    const written = await buildIngestToolConfig().execute("console-e2e-seed", {
      id: wikiId,
      title: `E2E fixture ${wikiId}`,
      body: [
        `This entry is a console-e2e fixture for ${wikiId}.`,
        "It exists so a scenario can open the Wiki panel and find a real entry without a model turn.",
        "Nothing in it is project knowledge; delete the owned run directory to discard it.",
      ].join("\n\n"),
      tags: ["console-e2e"],
      source: "console-e2e seed-onboarding fixture",
      proposer: "console-e2e:seed-onboarding",
      mode: "create",
    }, undefined, undefined, { paths });
    const result = JSON.parse(written.content[0].text) as { entry_id?: string; version?: number };
    if (!result.entry_id || !result.version) throw new Error(`wiki_ingest wrote no entry: ${written.content[0].text}`);
  }
  const served = await fetch(`${origin}/console/codex/c/${encodeURIComponent(commodoreId)}/api/entry/${encodeURIComponent(wikiId)}`);
  if (!served.ok) throw new Error(`The commodore's Codex route does not serve ${wikiId} (${served.status}).`);
  wiki = { entry: wikiId, version: (await readWikiEntry(wikiId, paths))!.version, reused };
}

console.log(JSON.stringify({
  origin, seeded: keys, kept: derived.filter(kept),
  deputy: deputy ? Object.fromEntries([...deputies, "introduced"].map((field) => [field, deputy![field]])) : null,
  wiki,
}, null, 2));
