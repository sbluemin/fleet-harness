import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

describe("Fleet Mobile iOS build contract", () => {
  it("keeps the generated iOS project and dist out of git", () => {
    const ignore = read("runtime/fleet-mobile/.gitignore");
    expect(ignore).toContain("/ios/");
    expect(ignore).toContain("/dist/");
  });

  it("registers the iOS config plugin last so nothing undoes the hardening", () => {
    const app = JSON.parse(read("runtime/fleet-mobile/app.json"));
    expect(app.expo.plugins.at(-1)).toBe("./plugins/withFleetIos.ts");
    expect(app.expo.ios.bundleIdentifier).toBe("com.dotobokuri.fleet.mobile");
    expect(app.expo.ios.buildNumber).toMatch(/^\d+$/);
  });

  it("withFleetIos disables arbitrary ATS loads and owns the fleet URL scheme", () => {
    const plugin = read("runtime/fleet-mobile/plugins/withFleetIos.ts");
    expect(plugin).toContain("NSAllowsArbitraryLoads: false");
    expect(plugin).toContain("CFBundleURLSchemes");
    expect(plugin).toContain('"fleet"');
    // LAN 콘솔 페어링은 이 키 없이는 실기기에서 프롬프트도 뜨지 않고 막힌다.
    expect(plugin).toContain("NSLocalNetworkUsageDescription");
    // 이 선언이 없으면 업로드된 빌드가 Missing Compliance로 멈춰 테스터에게 가지 않는다.
    expect(plugin).toContain("ITSAppUsesNonExemptEncryption = false");
  });

  // Android는 FleetLinkActivity가 URI를 지우고 MainActivity를 띄워 크리덴셜을 JS에서 막는다.
  // iOS는 구독자로 그 보장을 만들 수 없어(Expo가 launchOptions를 모든 구독자에게 그대로 넘김)
  // AppDelegate에서 지운다. 이 주입이 사라지면 Linking.getInitialURL()이 페어링 토큰을 준다.
  it("strips the fleet:// credential from launchOptions before React sees it", () => {
    const plugin = read("runtime/fleet-mobile/plugins/withFleetIos.ts");
    expect(plugin).toContain("withAppDelegate");
    expect(plugin).toContain("didFinishLaunchingWithOptions");
    expect(plugin).toContain("removeValue(forKey: .url)");
    // 앵커를 못 찾았을 때 조용히 넘어가면 크리덴셜이 노출된 채로 빌드된다 — 반드시 세워야 한다.
    expect(plugin).toContain("could not find the didFinishLaunchingWithOptions super call");
  });

  it("consumes the cold-start link before that strip, so the native inbox still gets it", () => {
    const subscriber = read(
      "runtime/fleet-mobile/modules/fleet-console-view/ios/FleetLinkAppDelegateSubscriber.swift",
    );
    expect(subscriber).toContain("willFinishLaunchingWithOptions");
    expect(subscriber).toContain("FleetLinkInbox.offer");
  });

  it("exposes the iOS build/verify/distribute scripts", () => {
    const pkg = JSON.parse(read("runtime/fleet-mobile/package.json"));
    expect(pkg.scripts["generate:ios"]).toContain("expo prebuild --platform ios");
    expect(pkg.scripts["ios:build:release"]).toContain("build-ios-release.mjs");
    expect(pkg.scripts["ios:verify:release"]).toContain("verify-ios-release.mjs");
    expect(pkg.scripts["ios:distribute"]).toContain("distribute-testflight.mjs");
  });

  it("keeps xcodebuild and pod out of the root build/postinstall", () => {
    const rootPackage = JSON.parse(read("package.json"));
    for (const script of ["build", "postinstall"]) {
      const value = rootPackage.scripts?.[script] ?? "";
      expect(value).not.toContain("xcodebuild");
      expect(value).not.toContain("pod install");
    }
  });

  it("promotion records the codesign identity and fails on drift", () => {
    const promote = read("runtime/fleet-mobile/scripts/lib/ios-promote.mjs");
    expect(promote).toContain("signerAuthority");
    expect(promote).toContain("verifyReleaseSigning");
    expect(promote).toContain("does not match the promoted artifact");
  });

  it("release signing is env-only and fails closed without the certificate", () => {
    const tools = read("runtime/fleet-mobile/scripts/lib/ios-tools.mjs");
    expect(tools).toContain("FLEET_IOS_CERTIFICATE_BASE64");
    expect(tools).toContain("must be signed with an Apple Distribution identity");
    expect(tools).toContain("must not carry get-task-allow");
  });
});
