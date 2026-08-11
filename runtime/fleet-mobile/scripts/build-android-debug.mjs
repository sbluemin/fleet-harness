#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPLICATION_ID,
  COMPILE_SDK,
  requireAndroidPlatform,
  requireAndroidSdk,
  requireBuildTools,
  requireJavaMajor,
  resolveJavaHome,
  run,
  withJavaNativeAccess,
} from "./lib/android-tools.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");
const androidRoot = path.join(packageRoot, "android");
const distRoot = path.join(packageRoot, "dist");
const artifact = path.join(distRoot, "fleet-mobile-debug.apk");
const sourceApk = path.join(androidRoot, "app", "build", "outputs", "apk", "debug", "app-debug.apk");

if (process.env.FLEET_ANDROID_RELEASE === "1") {
  throw new Error("Production Android signing and release assembly are intentionally unsupported");
}

const packageJsonPath = path.join(packageRoot, "package.json");
const appConfigPath = path.join(packageRoot, "app.json");
if (!existsSync(packageJsonPath) || !existsSync(appConfigPath)) {
  throw new Error("Fleet Mobile package.json and app.json must exist before Android prebuild");
}
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
if (packageJson.name !== "@dotobokuri/fleet-mobile") throw new Error(`Unexpected package name: ${packageJson.name}`);

const sdkRoot = requireAndroidSdk();
const javaHome = resolveJavaHome();
const javaMajor = requireJavaMajor(javaHome);
requireAndroidPlatform(sdkRoot);
requireBuildTools(sdkRoot);

rmSync(androidRoot, { recursive: true, force: true });
rmSync(distRoot, { recursive: true, force: true });

const env = {
  ...process.env,
  ANDROID_HOME: sdkRoot,
  ANDROID_SDK_ROOT: sdkRoot,
  JAVA_HOME: javaHome,
  JAVA_TOOL_OPTIONS: withJavaNativeAccess(javaMajor, process.env.JAVA_TOOL_OPTIONS),
  CI: process.env.CI ?? "true",
};
run("pnpm", ["--dir", packageRoot, "exec", "expo", "prebuild", "--platform", "android", "--clean", "--no-install", "--non-interactive"], {
  cwd: repoRoot,
  env,
});

const gradlew = path.join(androidRoot, process.platform === "win32" ? "gradlew.bat" : "gradlew");
if (!existsSync(gradlew)) throw new Error("Expo prebuild did not generate the Gradle wrapper");
run(gradlew, ["--no-daemon", "--stacktrace", "--console=plain", ":app:assembleDebug"], { cwd: androidRoot, env });
if (!existsSync(sourceApk)) throw new Error(`Gradle did not produce ${sourceApk}`);

mkdirSync(distRoot, { recursive: true });
cpSync(sourceApk, artifact);
const bytes = readFileSync(artifact);
const sha256 = createHash("sha256").update(bytes).digest("hex");
writeFileSync(`${artifact}.sha256`, `${sha256}  fleet-mobile-debug.apk\n`);
writeFileSync(
  path.join(distRoot, "fleet-mobile-debug.manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      artifact: "fleet-mobile-debug.apk",
      applicationId: APPLICATION_ID,
      buildType: "debug",
      minSdk: 24,
      compileSdk: 36,
      targetSdk: 36,
      sha256,
      size: bytes.byteLength,
    },
    null,
    2,
  )}\n`,
);

run(process.execPath, [path.join(packageRoot, "scripts", "verify-android-debug.mjs"), artifact], { cwd: repoRoot, env });
console.log(`Promoted ${path.relative(repoRoot, artifact)} (${sha256})`);
