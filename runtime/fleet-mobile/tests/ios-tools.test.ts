import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAscClient } from "../scripts/lib/asc-api.mjs";
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

// 처리 대기 폴링은 30분 동안 App Store Connect를 두드린다. 여기서 연결이 한 번 끊겨 예외가
// 그대로 올라오면, 업로드가 이미 받아들여진 릴리스가 그룹 배정도 노트도 없이 실패로 끝난다.
describe("App Store Connect transport", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-asc-"));
  const keyFile = path.join(dir, "AuthKey_TEST.p8");
  writeFileSync(
    keyFile,
    generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  );

  const client = (fetchImpl: typeof fetch) =>
    createAscClient({ keyId: "TESTKEYID", issuerId: "test-issuer", keyPath: keyFile, fetchImpl, sleep: async () => {} });

  const ok = (body: unknown) =>
    ({ status: 200, ok: true, text: async () => JSON.stringify(body) }) as unknown as Response;

  it("retries a dropped connection instead of aborting the distribution", async () => {
    let calls = 0;
    const build = await client(async () => {
      calls += 1;
      if (calls < 3) throw new TypeError("fetch failed");
      return ok({ data: [{ id: "b1", attributes: { version: "4", processingState: "VALID" } }] });
    }).findBuild("app1", "0.3.1", "4");

    expect(calls).toBe(3);
    expect(build?.id).toBe("b1");
  });

  // 재시도가 소진되면 조용히 성공한 척하지 않고, 원인을 담은 실패로 끝나야 한다.
  it("fails with the transport cause once retries are exhausted", async () => {
    await expect(
      client(async () => {
        throw new TypeError("fetch failed");
      }).findBuild("app1", "0.3.1", "4"),
    ).rejects.toThrow(/could not be reached: fetch failed/);
  });

  // 인증·검증 실패는 다시 보내도 같은 답이 온다 — 잡을 몇 배로 늘리기만 한다.
  it("does not retry a permanent rejection", async () => {
    let calls = 0;
    await expect(
      client(async () => {
        calls += 1;
        return { status: 401, ok: false, text: async () => '{"errors":[{"title":"NOT_AUTHORIZED"}]}' } as unknown as Response;
      }).findBuild("app1", "0.3.1", "4"),
    ).rejects.toThrow(/401/);
    expect(calls).toBe(1);
  });
});
