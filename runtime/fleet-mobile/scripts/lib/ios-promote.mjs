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
  runCombined,
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

  // 아카이브는 서명하지 않는다. xcodebuild의 CLI 설정은 워크스페이스의 모든 타깃에 적용되는데,
  // 앱의 App Store 프로파일은 CocoaPods 타깃의 번들 id를 서명할 수 없어 Xcode 26이 하드 실패한다
  // (시뮬레이터 CI는 CODE_SIGNING_ALLOWED=NO라 이 함정을 만나지 않는다). 서명은 exportArchive가
  // 앱 타깃에만 프로파일을 매핑해서 수행한다.
  const profile = readProvisioningProfile();
  run("xcodebuild", [
    "-workspace", workspace, "-scheme", scheme, "-configuration", "Release",
    "-destination", "generic/platform=iOS", "-archivePath", archivePath,
    "archive", "CODE_SIGNING_ALLOWED=NO",
  ], { cwd: iosRoot });

  const optionsPlist = writeExportOptions(iosRoot, profile);
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

  verifyReleaseSigning(inspectCodesign(readCodesign(appDir)));

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

function writeExportOptions(iosRoot, profile) {
  const optionsPath = path.join(iosRoot, "build", "ExportOptions.plist");
  mkdirSync(path.dirname(optionsPath), { recursive: true });
  writeFileSync(optionsPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>signingStyle</key><string>manual</string>
  <key>stripSwiftSymbols</key><true/>
  <key>teamID</key><string>${profile.teamId}</string>
  <key>provisioningProfiles</key><dict>
    <key>${BUNDLE_ID}</key><string>${profile.uuid}</string>
  </dict>
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
    return verifyReleaseSigning(inspectCodesign(readCodesign(appDir)));
  } catch {
    return undefined;
  }
}

/**
 * 배포 프로파일에서 팀 id와 프로파일 UUID를 읽는다. 수동 서명의 archive/export 양쪽이
 * 이 값을 요구하며, 프로파일이 이 앱의 번들 id를 위한 것인지도 여기서 확인한다 —
 * 다른 앱의 프로파일로 서명한 IPA가 업로드 단계에서야 거절되는 것을 막는다.
 */
export function readProvisioningProfile(env = process.env) {
  const file = env.FLEET_IOS_PROFILE_PATH;
  if (!file || !existsSync(file)) {
    fail("FLEET_IOS_PROFILE_PATH must point to the .mobileprovision used for signing");
  }
  const decoded = run("security", ["cms", "-D", "-i", file], { capture: true });
  const scratch = path.join(packageRoot, "dist", ".profile.plist");
  mkdirSync(path.dirname(scratch), { recursive: true });
  writeFileSync(scratch, decoded);
  try {
    return readProfileFields(scratch);
  } finally {
    rmSync(scratch, { force: true });
  }
}

/**
 * 복호화된 프로파일 plist에서 서명에 필요한 세 값만 뽑는다.
 *
 * JSON으로 통째 변환하지 않는 이유가 있다: 프로파일에는 DeveloperCertificates 같은 <data>
 * 항목이 들어 있고 plutil은 그것을 JSON으로 못 옮겨 "Invalid object in plist for JSON format"으로
 * 죽는다 — 즉 진짜 App Store 프로파일에서는 항상 실패한다. 필요한 키만 raw로 뽑으면 그 함정을
 * 통째로 비켜 간다.
 */
export function readProfileFields(plistPath) {
  const extract = (keyPath) => {
    try {
      return run("plutil", ["-extract", keyPath, "raw", "-o", "-", plistPath], { capture: true }).trim();
    } catch (error) {
      // 키가 없는 것과 plutil 자체가 실패한 것은 다른 이야기다. 뒤엣것까지 빈 값으로 뭉개면
      // "다른 앱의 프로파일"이라는 엉뚱한 진단이 나온다.
      if (/No value at that key path|does not exist/i.test(String(error?.message ?? ""))) return "";
      throw error;
    }
  };
  const applicationIdentifier = extract("Entitlements.application-identifier");
  const teamId = applicationIdentifier.split(".")[0];
  const bundleId = applicationIdentifier.slice(teamId.length + 1);
  if (!teamId || bundleId !== BUNDLE_ID) {
    fail(`Provisioning profile is for ${bundleId || "an unknown app"}; expected ${BUNDLE_ID}`);
  }
  const uuid = extract("UUID");
  if (!uuid) fail("Provisioning profile has no UUID");
  return { teamId, uuid, name: extract("Name") };
}

/**
 * codesign의 두 출력을 검사기가 읽을 수 있는 형태로 모은다. 엔타이틀먼트는 JSON이 아니라
 * XML plist이므로 plutil로 변환하고, 서명 상세(Authority=)는 stderr에 있으므로 합쳐서 캡처한다.
 */
function readCodesign(appDir) {
  const xml = runCombined("codesign", ["-d", "--entitlements", ":-", "--xml", appDir]);
  const scratch = path.join(packageRoot, "dist", ".entitlements.plist");
  mkdirSync(path.dirname(scratch), { recursive: true });
  writeFileSync(scratch, xml.slice(xml.indexOf("<?xml")));
  let entitlementsPlistJson;
  try {
    entitlementsPlistJson = run("plutil", ["-convert", "json", "-o", "-", scratch], { capture: true });
  } finally {
    rmSync(scratch, { force: true });
  }
  return {
    entitlementsPlistJson,
    verboseOutput: runCombined("codesign", ["-dvv", appDir]),
  };
}
