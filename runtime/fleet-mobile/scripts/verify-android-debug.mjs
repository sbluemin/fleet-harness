#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPLICATION_ID,
  COMPILE_SDK,
  inspectAaptManifestTree,
  inspectBadging,
  requireAndroidSdk,
  requireBuildTools,
  resolveJavaHome,
  run,
  verifyDebugSigner,
  verifyManifestContract,
} from "./lib/android-tools.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedArtifact = path.join(packageRoot, "dist", "fleet-mobile-debug.apk");
const artifact = path.resolve(process.argv[2] ?? expectedArtifact);
if (artifact !== expectedArtifact) throw new Error(`Only the promoted artifact may be verified: ${expectedArtifact}`);
if (!existsSync(artifact)) throw new Error(`APK does not exist: ${artifact}`);

const sdkRoot = requireAndroidSdk();
const javaHome = resolveJavaHome();
const env = { ...process.env, JAVA_HOME: javaHome };
const { aapt, apksigner } = requireBuildTools(sdkRoot);
const badging = inspectBadging(run(aapt, ["dump", "badging", artifact], { capture: true, env }));
const manifest = inspectAaptManifestTree(
  run(aapt, ["dump", "xmltree", artifact, "AndroidManifest.xml"], { capture: true, env }),
);
verifyManifestContract(manifest, badging);

const signer = run(apksigner, ["verify", "--verbose", "--print-certs", artifact], { capture: true, env });
verifyDebugSigner(signer);

const entries = run("unzip", ["-Z1", artifact], { capture: true }).split(/\r?\n/).filter(Boolean);
const bundleEntries = entries.filter((entry) => entry === "assets/index.android.bundle");
if (bundleEntries.length !== 1) {
  throw new Error(`APK must embed exactly one assets/index.android.bundle; got ${bundleEntries.length}`);
}
const bundleSize = Number(run("unzip", ["-l", artifact, bundleEntries[0]], { capture: true }).match(/^\s*(\d+)\s/m)?.[1]);
if (!Number.isFinite(bundleSize) || bundleSize < 1024) {
  throw new Error("Embedded JavaScript bundle is missing or unexpectedly small");
}

const bytes = readFileSync(artifact);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const shaFile = readFileSync(`${artifact}.sha256`, "utf8").trim();
if (shaFile !== `${sha256}  fleet-mobile-debug.apk`) throw new Error("APK SHA-256 sidecar does not match the artifact");
const manifestFile = JSON.parse(
  readFileSync(path.join(path.dirname(artifact), "fleet-mobile-debug.manifest.json"), "utf8"),
);
if (
  manifestFile.schemaVersion !== 1 ||
  manifestFile.artifact !== "fleet-mobile-debug.apk" ||
  manifestFile.applicationId !== APPLICATION_ID ||
  manifestFile.buildType !== "debug" ||
  manifestFile.minSdk !== 24 ||
  manifestFile.compileSdk !== COMPILE_SDK ||
  manifestFile.targetSdk !== 36 ||
  manifestFile.sha256 !== sha256 ||
  manifestFile.size !== bytes.byteLength
) {
  throw new Error("APK build manifest does not match the promoted artifact and fixed Android contract");
}
console.log(`Verified ${artifact} (${sha256})`);
