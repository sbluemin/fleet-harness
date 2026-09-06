import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUNDLE_ID,
  inspectInfoPlist,
  inspectCodesign,
  verifyReleaseInfoPlist,
  verifyReleaseSigning,
  verifyEmbeddedBundle,
  requireReleaseSigning,
  requireAscCredentials,
} from "../scripts/lib/ios-tools.mjs";
import { readProfileFields } from "../scripts/lib/ios-promote.mjs";

const goodPlist = JSON.stringify({
  CFBundleIdentifier: BUNDLE_ID,
  CFBundleShortVersionString: "0.2.0",
  CFBundleVersion: "2",
  MinimumOSVersion: "15.1",
  NSAppTransportSecurity: { NSAllowsArbitraryLoads: false, NSAllowsLocalNetworking: true },
  CFBundleURLTypes: [{ CFBundleURLName: "com.dotobokuri.fleet.mobile.join", CFBundleURLSchemes: ["fleet"] }],
  NSCameraUsageDescription: "Fleet uses the camera only to read a Console access link from a QR code.",
  NSLocalNetworkUsageDescription: "Fleet connects to the Console running on your local network.",
  ITSAppUsesNonExemptEncryption: false,
});

describe("iOS Info.plist contract", () => {

  it("accepts a hardened plist", () => {
    expect(() => verifyReleaseInfoPlist(inspectInfoPlist(goodPlist))).not.toThrow();
  });

  it("rejects arbitrary ATS loads", () => {
    const plist = JSON.parse(goodPlist);
    plist.NSAppTransportSecurity = { NSAllowsArbitraryLoads: true };
    expect(() => verifyReleaseInfoPlist(inspectInfoPlist(JSON.stringify(plist)))).toThrow(/arbitrary ATS/);
  });

  it("rejects an unexpected URL scheme", () => {
    const plist = JSON.parse(goodPlist);
    plist.CFBundleURLTypes.push({ CFBundleURLSchemes: ["exp+fleet"] });
    expect(() => verifyReleaseInfoPlist(inspectInfoPlist(JSON.stringify(plist)))).toThrow(/URL schemes/);
  });

  it("rejects an extra usage description (e.g. microphone)", () => {
    const plist = JSON.parse(goodPlist);
    plist.NSMicrophoneUsageDescription = "why";
    expect(() => verifyReleaseInfoPlist(inspectInfoPlist(JSON.stringify(plist)))).toThrow(/usage descriptions/);
  });

  // 없으면 iOS 14+ 실기기에서 LAN 콘솔 연결이 조용히 막힌다 — 시뮬레이터에서는 드러나지 않는다.
  it("rejects a plist without the local network usage description", () => {
    const plist = JSON.parse(goodPlist);
    delete plist.NSLocalNetworkUsageDescription;
    expect(() => verifyReleaseInfoPlist(inspectInfoPlist(JSON.stringify(plist)))).toThrow(
      /NSLocalNetworkUsageDescription/,
    );
  });

  // 빠지면 업로드는 성공하고 빌드는 Missing Compliance로 멈춘다 — 워크플로는 초록불인 채로.
  it("rejects a plist that does not settle export compliance", () => {
    const plist = JSON.parse(goodPlist);
    delete plist.ITSAppUsesNonExemptEncryption;
    expect(() => verifyReleaseInfoPlist(inspectInfoPlist(JSON.stringify(plist)))).toThrow(
      /ITSAppUsesNonExemptEncryption/,
    );
  });

  it("rejects a wrong bundle id", () => {
    const plist = JSON.parse(goodPlist);
    plist.CFBundleIdentifier = "com.example.other";
    expect(() => verifyReleaseInfoPlist(inspectInfoPlist(JSON.stringify(plist)))).toThrow(/bundle id/);
  });
});

describe("iOS codesign contract", () => {
  const distribution = {
    entitlementsPlistJson: JSON.stringify({ "get-task-allow": false, "application-identifier": "TEAMID.com.dotobokuri.fleet.mobile" }),
    verboseOutput: "Authority=Apple Distribution: dotobokuri (TEAMID)\nTeamIdentifier=TEAMID\n",
  };

  it("accepts an Apple Distribution signature without get-task-allow", () => {
    const codesign = inspectCodesign(distribution);
    expect(verifyReleaseSigning(codesign)).toMatch(/Apple Distribution/);
  });

  it("rejects a development identity", () => {
    const codesign = inspectCodesign({
      entitlementsPlistJson: JSON.stringify({ "get-task-allow": false }),
      verboseOutput: "Authority=Apple Development: dev (TEAMID)\nTeamIdentifier=TEAMID\n",
    });
    expect(() => verifyReleaseSigning(codesign)).toThrow(/development identity/);
  });

  it("rejects get-task-allow (debuggable) on a release", () => {
    const codesign = inspectCodesign({
      entitlementsPlistJson: JSON.stringify({ "get-task-allow": true }),
      verboseOutput: "Authority=Apple Distribution: dotobokuri (TEAMID)\n",
    });
    expect(() => verifyReleaseSigning(codesign)).toThrow(/get-task-allow/);
  });
});

describe("iOS IPA structure", () => {
  it("requires exactly one embedded main.jsbundle", () => {
    expect(() => verifyEmbeddedBundle(["Payload/Fleet.app/main.jsbundle", "Payload/Fleet.app/Info.plist"])).not.toThrow();
    expect(() => verifyEmbeddedBundle(["Payload/Fleet.app/Info.plist"])).toThrow(/exactly one main.jsbundle/);
  });
});

describe("iOS signing env", () => {
  it("requires all release signing vars", () => {
    expect(() => requireReleaseSigning({})).toThrow(/FLEET_IOS_CERTIFICATE_BASE64/);
    expect(() => requireAscCredentials({})).toThrow(/FLEET_ASC_KEY_ID/);
  });
});

// 진짜 App Store 프로파일에는 DeveloperCertificates 같은 <data>가 들어 있다. 예전 구현은 이
// plist를 통째로 JSON으로 옮기려다 plutil이 거부해 배포 빌드가 첫 단계에서 죽었다.
// plutil은 macOS 전용이다. 이 스위트는 실제 릴리스 경로와 같은 호스트에서만 의미가 있다.
describe.skipIf(process.platform !== "darwin")("provisioning profile fields", () => {
  function profilePlist(body: string): string {
    const root = mkdtempSync(path.join(tmpdir(), "ios-profile-"));
    const file = path.join(root, "profile.plist");
    writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${body}</dict></plist>
`);
    return file;
  }

  const CERTIFICATE_DATA = "<key>DeveloperCertificates</key><array><data>TUlJRg==</data></array>";

  it("rejects a profile issued for another app", () => {
    const file = profilePlist(`
      <key>UUID</key><string>u</string>${CERTIFICATE_DATA}
      <key>Entitlements</key><dict><key>application-identifier</key><string>8TJ9GTYF8J.com.example.other</string></dict>`);
    expect(() => readProfileFields(file)).toThrow(/com\.example\.other/);
  });
});
