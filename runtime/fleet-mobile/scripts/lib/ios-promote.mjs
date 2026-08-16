import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail, run } from "./android-tools.mjs";
import {
  BUNDLE_ID,
  IOS_MANIFEST_SCHEMA_VERSION,
  DEPLOYMENT_TARGET,
  requireXcode,
  requireReleaseSigning,
  inspectInfoPlist,
  inspectCodesign,
  verifyReleaseInfoPlist,
  verifyReleaseSigning,
  verifyEmbeddedBundle,
} from "./ios-tools.mjs";

// android-promote.mjs의 iOS 대응. prebuild(ios) → xcodebuild archive → exportArchive(서명)로
// 릴리스 IPA를 만들고 dist로 승격한 뒤 검증한다. xcodebuild/codesign은 macOS에서만 돈다.
// 서명 자재가 없으면 Gradle 릴리스 가드와 동형으로 빌드 전에 멈춘다(fail-closed).

const libRoot = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(libRoot, "../..");
export const repoRoot = path.resolve(packageRoot, "../..");

export const BUILD_TYPES = Object.freeze(["release"]);

export function artifactPaths(buildType) {
  requireBuildType(buildType);
  const distRoot = path.join(packageRoot, "dist");
  const name = `fleet-mobile-${buildType}.ipa`;
  return {
    name,
    distRoot,
    ipa: path.join(distRoot, name),
    sha256: path.join(distRoot, `${name}.sha256`),
    manifest: path.join(distRoot, `fleet-mobile-${buildType}.manifest.json`),
  };
}

function requireBuildType(buildType) {
  if (!BUILD_TYPES.includes(buildType)) fail(`Unknown iOS build type: ${buildType}`);
  return buildType;
}

export function readAppVersion() {
  const app = JSON.parse(readFileSync(path.join(packageRoot, "app.json"), "utf8"));
  const versionName = app.expo?.version;
  const buildNumber = app.expo?.ios?.buildNumber;
  if (typeof versionName !== "string" || versionName.length === 0) fail("app.json must set expo.version");
  if (typeof buildNumber !== "string" || !/^\d+$/.test(buildNumber)) fail("app.json must set a numeric-string expo.ios.buildNumber");
  return { versionName, buildNumber };
}

export function buildPromotedIpa(buildType) {
  requireBuildType(buildType);
  requireXcode();
  requireReleaseSigning();
  const paths = artifactPaths(buildType);
  const iosRoot = path.join(packageRoot, "ios");

  rmSync(iosRoot, { recursive: true, force: true });
  for (const target of [paths.ipa, paths.sha256, paths.manifest]) rmSync(target, { force: true });

  // 네이티브 프로젝트 생성(withFleetIos가 Info.plist를 하드닝한다).
  run("pnpm", ["--dir", packageRoot, "exec", "expo", "prebuild", "--platform", "ios", "--clean", "--no-install", "--non-interactive"], { cwd: repoRoot });
  run("pod", ["install"], { cwd: iosRoot });

  const workspace = findWorkspace(iosRoot);
  const scheme = path.basename(workspace, ".xcworkspace");
  const archivePath = path.join(iosRoot, "build", "Fleet.xcarchive");
  const exportPath = path.join(iosRoot, "build", "export");

  run("xcodebuild", [
    "-workspace", workspace, "-scheme", scheme, "-configuration", "Release",
    "-destination", "generic/platform=iOS", "-archivePath", archivePath,
    "archive", "CODE_SIGN_STYLE=Manual",
  ], { cwd: iosRoot });

  const optionsPlist = writeExportOptions(iosRoot);
  run("xcodebuild", [
    "-exportArchive", "-archivePath", archivePath,
    "-exportPath", exportPath, "-exportOptionsPlist", optionsPlist,
  ], { cwd: iosRoot });

  const builtIpa = firstIpa(exportPath);
  mkdirSync(paths.distRoot, { recursive: true });
  cpSync(builtIpa, paths.ipa);
  const bytes = readFileSync(paths.ipa);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(paths.sha256, `${sha256}  ${paths.name}\n`);

  const { versionName, buildNumber } = readAppVersion();
  const signerAuthority = describeSigner(exportPath, builtIpa);
  writeFileSync(paths.manifest, `${JSON.stringify({
    schemaVersion: IOS_MANIFEST_SCHEMA_VERSION,
    artifact: paths.name,
    bundleId: BUNDLE_ID,
    buildType,
    deploymentTarget: DEPLOYMENT_TARGET,
    buildNumber,
    versionName,
    sha256,
    size: bytes.byteLength,
    signerAuthority,
  }, null, 2)}\n`);

  run(process.execPath, [path.join(packageRoot, "scripts", `verify-ios-${buildType}.mjs`), paths.ipa], { cwd: repoRoot });
}

export function verifyPromotedIpa(buildType, artifact) {
  requireBuildType(buildType);
  const paths = artifactPaths(buildType);
  if (artifact && artifact !== paths.ipa) fail(`Only the promoted artifact may be verified: ${paths.ipa}`);
  if (!existsSync(paths.ipa)) fail(`Promoted IPA not found: ${paths.ipa}`);

  const workDir = extractApp(paths.ipa);
  const appDir = firstAppDir(workDir);
  const plistJson = run("plutil", ["-convert", "json", "-o", "-", path.join(appDir, "Info.plist")], { capture: true });
  const fields = inspectInfoPlist(plistJson);
  verifyReleaseInfoPlist(fields);

  const codesign = inspectCodesign({
    entitlementsPlistJson: run("codesign", ["-d", "--entitlements", ":-", "--xml", appDir], { capture: true }),
    verboseOutput: run("codesign", ["-dvv", appDir], { capture: true }),
  });
  verifyReleaseSigning(codesign);

  const entries = run("unzip", ["-Z1", paths.ipa], { capture: true }).split(/\r?\n/).filter(Boolean);
  verifyEmbeddedBundle(entries);

  const bytes = readFileSync(paths.ipa);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (readFileSync(paths.sha256, "utf8").trim() !== `${sha256}  ${paths.name}`) {
    fail("IPA SHA-256 sidecar does not match the artifact");
  }
  const manifest = JSON.parse(readFileSync(paths.manifest, "utf8"));
  const { versionName, buildNumber } = readAppVersion();
  if (
    manifest.schemaVersion !== IOS_MANIFEST_SCHEMA_VERSION || manifest.artifact !== paths.name ||
    manifest.bundleId !== BUNDLE_ID || manifest.buildType !== buildType ||
    manifest.buildNumber !== buildNumber || manifest.versionName !== versionName ||
    manifest.sha256 !== sha256 || manifest.size !== bytes.byteLength
  ) {
    fail("IPA build manifest does not match the promoted artifact and fixed iOS contract");
  }
  if (fields.bundleId !== BUNDLE_ID || fields.versionName !== versionName || fields.buildNumber !== buildNumber) {
    fail(`IPA reports ${fields.versionName} (${fields.buildNumber}); app.json declares ${versionName} (${buildNumber})`);
  }
}

// --- macOS 헬퍼들 (xcodebuild/unzip 경로) ---

function findWorkspace(iosRoot) {
  const run_ = run("ls", [iosRoot], { capture: true }).split(/\r?\n/);
  const ws = run_.find((n) => n.endsWith(".xcworkspace"));
  if (!ws) fail("Expo prebuild produced no .xcworkspace");
  return path.join(iosRoot, ws);
}

function firstIpa(exportPath) {
  const files = run("ls", [exportPath], { capture: true }).split(/\r?\n/);
  const ipa = files.find((n) => n.endsWith(".ipa"));
  if (!ipa) fail("xcodebuild exportArchive produced no .ipa");
  return path.join(exportPath, ipa);
}

function writeExportOptions(iosRoot) {
  const optionsPath = path.join(iosRoot, "build", "ExportOptions.plist");
  mkdirSync(path.dirname(optionsPath), { recursive: true });
  writeFileSync(optionsPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>signingStyle</key><string>manual</string>
  <key>stripSwiftSymbols</key><true/>
</dict></plist>
`);
  return optionsPath;
}

function extractApp(ipa) {
  const workDir = path.join(path.dirname(ipa), `.verify-${path.basename(ipa)}`);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  run("unzip", ["-q", ipa, "-d", workDir]);
  return workDir;
}

function firstAppDir(workDir) {
  const payload = path.join(workDir, "Payload");
  const entries = run("ls", [payload], { capture: true }).split(/\r?\n/);
  const app = entries.find((n) => n.endsWith(".app"));
  if (!app) fail("IPA has no Payload/*.app");
  return path.join(payload, app);
}

function describeSigner(exportPath, ipa) {
  try {
    const workDir = extractApp(ipa);
    const appDir = firstAppDir(workDir);
    const codesign = inspectCodesign({
      entitlementsPlistJson: run("codesign", ["-d", "--entitlements", ":-", "--xml", appDir], { capture: true }),
      verboseOutput: run("codesign", ["-dvv", appDir], { capture: true }),
    });
    return verifyReleaseSigning(codesign);
  } catch {
    return undefined;
  }
}
