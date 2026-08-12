#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail } from "./lib/android-tools.mjs";

/**
 * app.json is the only version the APK carries. `package.json` in this package is swept into the
 * workspace-wide release sync and does not reach the app, so bumping it would change nothing a
 * tester sees. Firebase App Distribution keys a release by versionCode + versionName, so the
 * integer has to move on every distributed build or the previous release is silently replaced.
 */
const appConfigPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "app.json");

export function nextVersion(version, bump) {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    fail(`app.json version is not a three-part version: ${version}`);
  }
  const [major, minor, patch] = parts;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  return fail(`Unknown bump: ${bump}`);
}

function parseArguments(argv) {
  const bump = argv[argv.indexOf("--bump") + 1];
  if (!argv.includes("--bump") || !bump || bump.startsWith("--")) fail("--bump <minor|patch> is required");
  return { bump, dryRun: argv.includes("--dry-run") };
}

function main(argv) {
  const { bump, dryRun } = parseArguments(argv);
  const raw = readFileSync(appConfigPath, "utf8");
  const config = JSON.parse(raw);
  const currentVersion = config.expo?.version;
  const currentVersionCode = config.expo?.android?.versionCode;
  if (typeof currentVersion !== "string") fail("app.json must set expo.version");
  if (!Number.isInteger(currentVersionCode)) fail("app.json must set an integer expo.android.versionCode");

  const version = nextVersion(currentVersion, bump);
  const versionCode = currentVersionCode + 1;

  if (!dryRun) {
    config.expo.version = version;
    config.expo.android.versionCode = versionCode;
    const updated = `${JSON.stringify(config, null, 2)}\n`;
    if (updated === raw) fail("app.json was not modified by the version bump");
    writeFileSync(appConfigPath, updated);
  }

  console.log(`version=${version}`);
  console.log(`versionCode=${versionCode}`);
}

// Importing this module must not bump anything — the tests exercise nextVersion() directly.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
