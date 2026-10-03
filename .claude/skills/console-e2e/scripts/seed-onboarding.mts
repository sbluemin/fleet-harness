// Mark first-load onboarding as seen in an owned isolated Console before the first navigation.
//
// Keys come from the current source, not a copied list: the core contributions, every built-in plugin's
// client/onboarding module, the commissioning key, and the seen-store key rules. Run it with the Console
// package's tsx so the TypeScript sources resolve:
//
//   pnpm --dir <worktree>/runtime/fleet-console exec tsx \
//     <worktree>/.claude/skills/console-e2e/scripts/seed-onboarding.mts \
//     --console-dir "$E2E_DIR/console" [--keep <key> ...] [--init-script <file>] [--dry-run]
//
// --keep leaves a key (or every key with that prefix, e.g. `objectives.`) unseeded, removing it if already stored, when that layer is under test.
// --init-script writes a page script setting the per-origin What's New watermark; pass it to the browser session.
// Only loopback writes go to the owned Console named by its lock; no token is read or printed.
import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { OnboardingContribution } from "../../../../runtime/fleet-console/sdk/onboarding/types.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const consoleSrc = join(root, "runtime/fleet-console");

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const keep = args.flatMap((arg, index) => (args[index - 1] === "--keep" ? [arg] : []));
const consoleDir = option("--console-dir");
const initScript = option("--init-script");
const dryRun = args.includes("--dry-run");
if (!consoleDir && !dryRun) throw new Error("Pass --console-dir <owned FLEET_CONSOLE_DATA_DIR> or --dry-run.");

const { CORE_ONBOARDING } = await import(pathToFileURL(join(consoleSrc, "core/client/src/integration/onboarding.ts")).href);
const { welcomeSeenKey, hintSeenKey, tourSeenKey } = await import(pathToFileURL(join(consoleSrc, "features/onboarding/client/seen-store.ts")).href);
const { COMMISSIONING_SEEN_KEY } = await import(pathToFileURL(join(consoleSrc, "core/client/src/integration/store.ts")).href);
const { WHATS_NEW_SEEN_VERSION_STORAGE_KEY } = await import(pathToFileURL(join(consoleSrc, "features/updates/client/release-state.ts")).href);

const contributions: OnboardingContribution[] = [...CORE_ONBOARDING];
const pluginsDir = join(root, "runtime/fleet-plugins");
for (const plugin of readdirSync(pluginsDir)) {
  for (const file of ["client/onboarding.tsx", "client/onboarding.ts"]) {
    const path = join(pluginsDir, plugin, file);
    if (!existsSync(path)) continue;
    const module = await import(pathToFileURL(path).href);
    for (const value of Object.values(module)) {
      if (value && typeof value === "object" && typeof (value as OnboardingContribution).id === "string") contributions.push(value as OnboardingContribution);
    }
  }
}

const derived = [COMMISSIONING_SEEN_KEY as string];
for (const contribution of contributions) {
  for (const key of [welcomeSeenKey(contribution), hintSeenKey(contribution)]) if (key) derived.push(key);
  for (const tour of contribution.tours ?? []) derived.push(tourSeenKey(tour.id, "spotlight"), tourSeenKey(tour.id, "walkthrough"));
}
const kept = (key: string) => keep.some((entry) => key === entry || (entry.endsWith(".") && key.startsWith(entry)));
const keys = [...new Set(derived)].filter((key) => !kept(key));

if (dryRun) {
  console.log(JSON.stringify({ keys, kept: derived.filter(kept), whatsNewStorageKey: WHATS_NEW_SEEN_VERSION_STORAGE_KEY }, null, 2));
  process.exit(0);
}

const lock = JSON.parse(readFileSync(join(consoleDir!, "console.lock"), "utf8")) as { port?: number };
if (!lock.port) throw new Error("console.lock has no port yet; wait for the owned server to finish starting.");
const origin = `http://127.0.0.1:${lock.port}`;
const headers = { Origin: origin, "Content-Type": "application/json" };

const status = await fetch(`${origin}/api/v1/status`, { headers }).then((response) => response.json()) as { version?: string };
const current = await fetch(`${origin}/api/v1/settings/global`, { headers }).then((response) => response.json()) as { seenFeatureTours?: string[] };
// A kept key comes off the stored list too, so a reused slot still shows the layer under test.
const seen = [...new Set([...(current.seenFeatureTours ?? []).filter((key) => !kept(key)), ...keys])];
const put = await fetch(`${origin}/api/v1/settings/global`, { method: "PUT", headers, body: JSON.stringify({ seenFeatureTours: seen }) });
if (!put.ok) throw new Error(`PUT /api/v1/settings/global failed: ${put.status} ${await put.text()}`);
const after = await fetch(`${origin}/api/v1/settings/global`, { headers }).then((response) => response.json()) as { seenFeatureTours?: string[] };
const stored = after.seenFeatureTours ?? [];
const missing = keys.filter((key) => !stored.includes(key));
if (missing.length > 0) throw new Error(`Settings did not keep: ${missing.join(", ")} (the field is bounded; check its limit).`);
const lingering = stored.filter(kept);
if (lingering.length > 0) throw new Error(`Settings still mark kept keys as seen: ${lingering.join(", ")}.`);

if (initScript) {
  if (!status.version) throw new Error("/api/v1/status returned no version for the What's New watermark.");
  writeFileSync(initScript, `localStorage.setItem(${JSON.stringify(WHATS_NEW_SEEN_VERSION_STORAGE_KEY)}, ${JSON.stringify(status.version)});\n`);
}
console.log(JSON.stringify({ origin, seeded: keys, kept: derived.filter(kept), whatsNew: initScript ? { script: initScript, version: status.version } : null }, null, 2));
