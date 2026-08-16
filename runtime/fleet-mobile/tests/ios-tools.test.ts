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

const goodPlist = JSON.stringify({
  CFBundleIdentifier: BUNDLE_ID,
  CFBundleShortVersionString: "0.2.0",
  CFBundleVersion: "2",
  MinimumOSVersion: "15.1",
  NSAppTransportSecurity: { NSAllowsArbitraryLoads: false, NSAllowsLocalNetworking: true },
  CFBundleURLTypes: [{ CFBundleURLName: "com.dotobokuri.fleet.mobile.join", CFBundleURLSchemes: ["fleet"] }],
  NSCameraUsageDescription: "Fleet uses the camera only to read a Console access link from a QR code.",
  NSLocalNetworkUsageDescription: "Fleet connects to the Console running on your local network.",
});

describe("iOS Info.plist contract", () => {
  it("extracts the contract fields", () => {
    const fields = inspectInfoPlist(goodPlist);
    expect(fields.bundleId).toBe(BUNDLE_ID);
    expect(fields.buildNumber).toBe("2");
    expect(fields.allowsArbitraryLoads).toBe(false);
    expect(fields.urlSchemes).toEqual(["fleet"]);
    expect(fields.usageDescriptionKeys).toEqual([
      "NSCameraUsageDescription",
      "NSLocalNetworkUsageDescription",
    ]);
  });

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
