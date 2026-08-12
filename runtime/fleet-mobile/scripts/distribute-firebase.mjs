#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { artifactPaths, readAppVersion, repoRoot, verifyPromotedApk } from "./lib/android-promote.mjs";
import { fail, run } from "./lib/android-tools.mjs";

/**
 * Firebase App Distribution keys a release by applicationId + versionCode + versionName. Uploading
 * the same triple replaces the existing release instead of notifying testers of a new one, so
 * app.json's versionCode has to move before each round goes out.
 */
export const FIREBASE_ENV = Object.freeze({
  appId: "FIREBASE_APP_ID",
  project: "FIREBASE_PROJECT",
  groups: "FIREBASE_TESTER_GROUPS",
  testers: "FIREBASE_TESTERS",
});

function readNotesArgument(argv) {
  const index = argv.indexOf("--notes");
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail("--notes requires a value");
  return value;
}

function requireFirebaseCli() {
  const probe = spawnSync("firebase", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    fail(
      "Firebase CLI not found on PATH. Install it with `npm install -g firebase-tools`, then authenticate with `firebase login`",
    );
  }
  return probe.stdout.trim();
}

const appId = process.env[FIREBASE_ENV.appId];
if (!appId) fail(`${FIREBASE_ENV.appId} must be set to the Firebase Android app id (1:<number>:android:<hash>)`);
if (!/^1:\d+:android:[0-9a-f]+$/.test(appId)) fail(`${FIREBASE_ENV.appId} is not a Firebase Android app id: ${appId}`);

const groups = process.env[FIREBASE_ENV.groups];
const testers = process.env[FIREBASE_ENV.testers];
if (!groups && !testers) {
  fail(`Set ${FIREBASE_ENV.groups} or ${FIREBASE_ENV.testers}; an upload nobody receives is not a distribution`);
}

// Re-verify rather than trust the artifact on disk: the promoted APK is the thing testers install.
verifyPromotedApk("release");

const paths = artifactPaths("release");
const { versionCode, versionName } = readAppVersion();
const sha256 = readFileSync(paths.sha256, "utf8").trim().split(/\s+/)[0];
const notes = readNotesArgument(process.argv.slice(2)) ?? `Fleet Mobile ${versionName} (versionCode ${versionCode})\nsha256 ${sha256}`;

const cliVersion = requireFirebaseCli();
const args = ["appdistribution:distribute", paths.apk, "--app", appId, "--release-notes", notes];
const project = process.env[FIREBASE_ENV.project];
if (project) args.push("--project", project);
if (groups) args.push("--groups", groups);
if (testers) args.push("--testers", testers);

console.log(`Distributing ${paths.name} ${versionName} (${versionCode}) via firebase-tools ${cliVersion}`);
run("firebase", args, { cwd: repoRoot });
console.log(`Distributed ${paths.name} (${sha256})`);
