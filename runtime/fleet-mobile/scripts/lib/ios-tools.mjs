import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fail, run } from "./android-tools.mjs";

// android-tools.mjs의 iOS 대응. fail/run은 재사용하고, IPA/Info.plist/codesign 검사기를 둔다.
// 파서들은 순수 함수(문자열 출력 → 구조)라 vitest로 픽스처 검증 가능하다. 실제 빌드
// (xcodebuild)는 macOS CI에서만 돈다.

export const BUNDLE_ID = "com.dotobokuri.fleet.mobile";
export const DEPLOYMENT_TARGET = "15.1";
export const IOS_MANIFEST_SCHEMA_VERSION = 1;

// 배포 서명 자재는 저장소가 아니라 환경에서만 읽는다(Android 키스토어 규칙과 동형).
export const RELEASE_SIGNING_ENV = Object.freeze({
  certificateBase64: "FLEET_IOS_CERTIFICATE_BASE64",
  certificatePassword: "FLEET_IOS_CERTIFICATE_PASSWORD",
  profileBase64: "FLEET_IOS_PROFILE_BASE64",
});

export const ASC_ENV = Object.freeze({
  keyId: "FLEET_ASC_KEY_ID",
  issuerId: "FLEET_ASC_ISSUER_ID",
  keyBase64: "FLEET_ASC_KEY_BASE64",
});

/**
 * codesign은 사람이 읽는 출력(Authority=, TeamIdentifier=)을 stdout이 아니라 stderr로 낸다.
 * run()은 stdout만 돌려주므로 그대로 쓰면 검사기가 빈 문자열을 보고 올바르게 서명된 IPA를
 * 거부한다. 두 스트림을 합쳐서 돌려준다.
 */
export function runCombined(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) fail(`${command} exited with status ${result.status}
${combined}`.trimEnd());
  return combined;
}

export function requireXcode(env = process.env, platform = process.platform) {
  if (platform !== "darwin") fail("iOS release builds require macOS with Xcode");
  const developerDir = env.DEVELOPER_DIR;
  if (developerDir && (!path.isAbsolute(developerDir) || !existsSync(developerDir))) {
    fail("DEVELOPER_DIR, if set, must name an existing absolute Xcode Developer directory");
  }
  return developerDir;
}

export function requireReleaseSigning(env = process.env) {
  const result = {};
  for (const [key, name] of Object.entries(RELEASE_SIGNING_ENV)) {
    const value = env[name];
    if (!value) fail(`${name} must be set to sign the release IPA`);
    result[key] = value;
  }
  return result;
}

export function requireAscCredentials(env = process.env) {
  const result = {};
  for (const [key, name] of Object.entries(ASC_ENV)) {
    const value = env[name];
    if (!value) fail(`${name} must be set to upload to TestFlight`);
    result[key] = value;
  }
  return result;
}

// `plutil -convert json -o - Info.plist`의 출력(JSON 문자열)에서 계약 필드를 뽑는다.
export function inspectInfoPlist(json) {
  let plist;
  try {
    plist = JSON.parse(json);
  } catch {
    fail("Info.plist JSON could not be parsed");
  }
  const ats = plist.NSAppTransportSecurity ?? {};
  const urlTypes = Array.isArray(plist.CFBundleURLTypes) ? plist.CFBundleURLTypes : [];
  const schemes = urlTypes.flatMap((entry) => (Array.isArray(entry?.CFBundleURLSchemes) ? entry.CFBundleURLSchemes : []));
  return {
    bundleId: plist.CFBundleIdentifier,
    versionName: plist.CFBundleShortVersionString,
    buildNumber: plist.CFBundleVersion,
    minimumOSVersion: plist.MinimumOSVersion,
    allowsArbitraryLoads: ats.NSAllowsArbitraryLoads === true,
    urlSchemes: [...new Set(schemes)],
    // Fleet은 카메라만 쓴다. 마이크·위치 등 추가 사용 설명 키가 있으면 초과로 본다.
    usageDescriptionKeys: Object.keys(plist).filter((key) => /UsageDescription$/.test(key)).sort(),
    backgroundModes: Array.isArray(plist.UIBackgroundModes) ? plist.UIBackgroundModes : [],
  };
}

// `codesign -d --entitlements :- --verbose=4 <app>` 및 `codesign -dvv <app>` 출력 파싱.
export function inspectCodesign({ entitlementsPlistJson, verboseOutput }) {
  let entitlements = {};
  if (entitlementsPlistJson) {
    try { entitlements = JSON.parse(entitlementsPlistJson); } catch { fail("entitlements JSON could not be parsed"); }
  }
  const authority = [...verboseOutput.matchAll(/^Authority=(.+)$/gm)].map((m) => m[1].trim());
  const teamId = verboseOutput.match(/^TeamIdentifier=([A-Z0-9]+)$/m)?.[1];
  return {
    getTaskAllow: entitlements["get-task-allow"] === true,
    leafAuthority: authority[0],
    teamId,
  };
}

export function verifyReleaseInfoPlist(fields) {
  if (fields.bundleId !== BUNDLE_ID) fail(`Unexpected iOS bundle id: ${fields.bundleId ?? "missing"}`);
  if (fields.allowsArbitraryLoads) fail("Fleet Mobile must not allow arbitrary ATS loads");
  // fleet://join URL 타입은 정확히 그것 하나여야 한다.
  const schemes = [...fields.urlSchemes].sort();
  if (JSON.stringify(schemes) !== JSON.stringify(["fleet"])) {
    fail(`Unexpected iOS URL schemes: ${schemes.join(", ") || "none"}`);
  }
  // 카메라(QR 스캔)와 로컬 네트워크(LAN 콘솔) 외 사용 설명 키가 없어야 한다 —
  // 마이크·위치 등 초과 권한 차단.
  const allowedUsageDescriptions = ["NSCameraUsageDescription", "NSLocalNetworkUsageDescription"];
  const unexpected = fields.usageDescriptionKeys.filter((key) => !allowedUsageDescriptions.includes(key));
  if (unexpected.length > 0) fail(`Unexpected iOS usage descriptions: ${unexpected.join(", ")}`);
  // 이 키가 없으면 iOS 14+ 실기기에서 LAN 콘솔 연결이 프롬프트조차 뜨지 않고 막힌다.
  // 시뮬레이터는 강제하지 않으므로 여기서 막지 않으면 실기기에서만 터진다.
  if (!fields.usageDescriptionKeys.includes("NSLocalNetworkUsageDescription")) {
    fail("Info.plist must declare NSLocalNetworkUsageDescription — LAN console pairing is blocked without it");
  }
  if (fields.backgroundModes.length > 0) fail(`Unexpected iOS background modes: ${fields.backgroundModes.join(", ")}`);
}

export function verifyReleaseSigning(codesign) {
  // 릴리스는 개발/디버그 identity로 서명되면 안 되고, get-task-allow(디버거 허용)가 꺼져야 한다.
  if (codesign.getTaskAllow) fail("Release IPA must not carry get-task-allow (debuggable) entitlement");
  const authority = codesign.leafAuthority ?? "";
  if (/Apple Development|iPhone Developer/.test(authority)) {
    fail(`Release IPA must not be signed with a development identity: ${authority}`);
  }
  if (!/Apple Distribution|iPhone Distribution/.test(authority)) {
    fail(`Release IPA must be signed with an Apple Distribution identity; got ${authority || "none"}`);
  }
  return authority;
}

// IPA(zip)의 엔트리 목록에서 임베디드 JS 번들이 정확히 하나인지 확인한다.
export function verifyEmbeddedBundle(zipEntries) {
  const bundles = zipEntries.filter((entry) => /^Payload\/[^/]+\.app\/main\.jsbundle$/.test(entry));
  if (bundles.length !== 1) fail(`IPA must embed exactly one main.jsbundle; got ${bundles.length}`);
}
