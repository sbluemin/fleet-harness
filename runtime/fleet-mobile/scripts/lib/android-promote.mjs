import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPLICATION_ID,
  COMPILE_SDK,
  MIN_SDK,
  TARGET_SDK,
  fail,
  inspectAaptManifestTree,
  inspectBadging,
  requireAndroidPlatform,
  requireAndroidSdk,
  requireBuildTools,
  requireJavaMajor,
  requireReleaseKeystore,
  resolveJavaHome,
  run,
  verifyDebugSigner,
  verifyManifestContract,
  verifyReleaseSigner,
  withJavaNativeAccess,
} from "./android-tools.mjs";

export const BUILD_TYPES = Object.freeze(["debug", "release"]);
export const MANIFEST_SCHEMA_VERSION = 2;

const libRoot = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(libRoot, "../..");
export const repoRoot = path.resolve(packageRoot, "../..");
const androidRoot = path.join(packageRoot, "android");
const distRoot = path.join(packageRoot, "dist");

export function requireBuildType(buildType) {
  if (!BUILD_TYPES.includes(buildType)) fail(`Unknown Android build type: ${buildType}`);
  return buildType;
}

export function artifactPaths(buildType) {
  const name = `fleet-mobile-${requireBuildType(buildType)}.apk`;
  return {
    name,
    apk: path.join(distRoot, name),
    sha256: path.join(distRoot, `${name}.sha256`),
    manifest: path.join(distRoot, `fleet-mobile-${buildType}.manifest.json`),
  };
}

/** The one place that reads the shipped version, so the APK and its manifest can never disagree. */
export function readAppVersion() {
  const app = JSON.parse(readFileSync(path.join(packageRoot, "app.json"), "utf8"));
  const versionCode = app.expo?.android?.versionCode;
  const versionName = app.expo?.version;
  if (!Number.isInteger(versionCode) || versionCode < 1) fail("app.json must set an integer expo.android.versionCode");
  if (typeof versionName !== "string" || versionName.length === 0) fail("app.json must set expo.version");
  return { versionCode, versionName };
}

function androidEnvironment(buildType) {
  const sdkRoot = requireAndroidSdk();
  const javaHome = resolveJavaHome();
  const javaMajor = requireJavaMajor(javaHome);
  requireAndroidPlatform(sdkRoot);
  const buildTools = requireBuildTools(sdkRoot);
  return {
    buildTools,
    env: {
      ...process.env,
      ANDROID_HOME: sdkRoot,
      ANDROID_SDK_ROOT: sdkRoot,
      JAVA_HOME: javaHome,
      JAVA_TOOL_OPTIONS: withJavaNativeAccess(javaMajor, process.env.JAVA_TOOL_OPTIONS),
      CI: process.env.CI ?? "true",
    },
  };
}

export function buildPromotedApk(buildType) {
  requireBuildType(buildType);
  const packageJsonPath = path.join(packageRoot, "package.json");
  const appConfigPath = path.join(packageRoot, "app.json");
  if (!existsSync(packageJsonPath) || !existsSync(appConfigPath)) {
    fail("Fleet Mobile package.json and app.json must exist before Android prebuild");
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (packageJson.name !== "@dotobokuri/fleet-mobile") fail(`Unexpected package name: ${packageJson.name}`);

  // Fail on missing signing credentials before Gradle spends minutes reaching the same conclusion.
  if (buildType === "release") requireReleaseKeystore();
  const { env } = androidEnvironment(buildType);
  const paths = artifactPaths(buildType);
  const variant = `${buildType[0].toUpperCase()}${buildType.slice(1)}`;
  const sourceApk = path.join(androidRoot, "app", "build", "outputs", "apk", buildType, `app-${buildType}.apk`);

  rmSync(androidRoot, { recursive: true, force: true });
  // Only this build type's artifacts are cleared, so a promoted debug and release APK can coexist.
  for (const target of [paths.apk, paths.sha256, paths.manifest]) rmSync(target, { force: true });

  run(
    "pnpm",
    ["--dir", packageRoot, "exec", "expo", "prebuild", "--platform", "android", "--clean", "--no-install", "--non-interactive"],
    { cwd: repoRoot, env },
  );

  const gradlew = path.join(androidRoot, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  if (!existsSync(gradlew)) fail("Expo prebuild did not generate the Gradle wrapper");
  run(gradlew, ["--no-daemon", "--stacktrace", "--console=plain", `:app:assemble${variant}`], { cwd: androidRoot, env });
  if (!existsSync(sourceApk)) fail(`Gradle did not produce ${sourceApk}`);

  mkdirSync(distRoot, { recursive: true });
  cpSync(sourceApk, paths.apk);
  const bytes = readFileSync(paths.apk);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { versionCode, versionName } = readAppVersion();
  writeFileSync(paths.sha256, `${sha256}  ${paths.name}\n`);
  writeFileSync(
    paths.manifest,
    `${JSON.stringify(
      {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        artifact: paths.name,
        applicationId: APPLICATION_ID,
        buildType,
        minSdk: MIN_SDK,
        compileSdk: COMPILE_SDK,
        targetSdk: TARGET_SDK,
        versionCode,
        versionName,
        sha256,
        size: bytes.byteLength,
      },
      null,
      2,
    )}\n`,
  );

  run(process.execPath, [path.join(packageRoot, "scripts", `verify-android-${buildType}.mjs`), paths.apk], {
    cwd: repoRoot,
    env,
  });
  console.log(`Promoted ${path.relative(repoRoot, paths.apk)} (${sha256})`);
}

export function verifyPromotedApk(buildType, requestedArtifact) {
  requireBuildType(buildType);
  const paths = artifactPaths(buildType);
  const artifact = path.resolve(requestedArtifact ?? paths.apk);
  if (artifact !== paths.apk) fail(`Only the promoted artifact may be verified: ${paths.apk}`);
  if (!existsSync(artifact)) fail(`APK does not exist: ${artifact}`);

  const { buildTools, env } = androidEnvironment(buildType);
  const { aapt, apksigner } = buildTools;
  const badging = inspectBadging(run(aapt, ["dump", "badging", artifact], { capture: true, env }));
  const manifest = inspectAaptManifestTree(
    run(aapt, ["dump", "xmltree", artifact, "AndroidManifest.xml"], { capture: true, env }),
  );
  verifyManifestContract(manifest, badging, { buildType });

  const signer = run(apksigner, ["verify", "--verbose", "--print-certs", artifact], { capture: true, env });
  const signerSha256 = buildType === "release" ? verifyReleaseSigner(signer) : (verifyDebugSigner(signer), undefined);

  const entries = run("unzip", ["-Z1", artifact], { capture: true }).split(/\r?\n/).filter(Boolean);
  const bundleEntries = entries.filter((entry) => entry === "assets/index.android.bundle");
  if (bundleEntries.length !== 1) {
    fail(`APK must embed exactly one assets/index.android.bundle; got ${bundleEntries.length}`);
  }
  const bundleSize = Number(run("unzip", ["-l", artifact, bundleEntries[0]], { capture: true }).match(/^\s*(\d+)\s/m)?.[1]);
  if (!Number.isFinite(bundleSize) || bundleSize < 1024) {
    fail("Embedded JavaScript bundle is missing or unexpectedly small");
  }

  const bytes = readFileSync(artifact);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (readFileSync(paths.sha256, "utf8").trim() !== `${sha256}  ${paths.name}`) {
    fail("APK SHA-256 sidecar does not match the artifact");
  }
  const { versionCode, versionName } = readAppVersion();
  const manifestFile = JSON.parse(readFileSync(paths.manifest, "utf8"));
  if (
    manifestFile.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    manifestFile.artifact !== paths.name ||
    manifestFile.applicationId !== APPLICATION_ID ||
    manifestFile.buildType !== buildType ||
    manifestFile.minSdk !== MIN_SDK ||
    manifestFile.compileSdk !== COMPILE_SDK ||
    manifestFile.targetSdk !== TARGET_SDK ||
    manifestFile.versionCode !== versionCode ||
    manifestFile.versionName !== versionName ||
    manifestFile.sha256 !== sha256 ||
    manifestFile.size !== bytes.byteLength
  ) {
    fail("APK build manifest does not match the promoted artifact and fixed Android contract");
  }
  // The APK itself must carry the version the manifest claims; testers upgrade by versionCode.
  if (badging.versionCode !== versionCode || badging.versionName !== versionName) {
    fail(`APK reports version ${badging.versionName} (${badging.versionCode}); app.json declares ${versionName} (${versionCode})`);
  }
  console.log(`Verified ${artifact} (${sha256})${signerSha256 ? ` signed by ${signerSha256}` : ""}`);
}
