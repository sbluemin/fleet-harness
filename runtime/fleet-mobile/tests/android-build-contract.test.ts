import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

describe("Fleet Mobile Android build contract", () => {
  it("keeps generated and promoted Android outputs out of git", () => {
    const ignore = read(".gitignore");
    expect(ignore).toContain("runtime/fleet-mobile/android/");
    expect(ignore).toContain("runtime/fleet-mobile/dist/");
  });

  it("is included in the workspace without adding mobile Gradle work to generic builds", () => {
    const workspace = read("pnpm-workspace.yaml");
    const rootPackage = JSON.parse(read("package.json"));
    expect(workspace).toContain('"runtime/fleet-mobile"');
    expect(rootPackage.scripts.build).not.toContain("mobile:android");
    expect(rootPackage.scripts.postinstall).not.toContain("mobile:android");
    expect(rootPackage.scripts.postinstall).not.toContain("gradle");
  });

  // 하드닝 플러그인은 마지막에 서야 뒤의 플러그인이 정책을 되돌릴 수 없다. iOS 플러그인이
  // 추가된 뒤에도 그 불변식은 "마지막 두 자리가 fleet 플랫폼 플러그인"으로 유지된다.
  it("registers the fail-closed platform plugins after the native module", () => {
    const app = JSON.parse(read("runtime/fleet-mobile/app.json"));
    expect(app.expo.plugins.at(-2)).toBe("./plugins/withFleetAndroid.ts");
    expect(app.expo.plugins.at(-1)).toBe("./plugins/withFleetIos.ts");
  });

  it("applies the same hardening to both build types", () => {
    const plugin = read("runtime/fleet-mobile/plugins/withFleetAndroid.ts");
    expect(plugin).toContain('application.$["android:usesCleartextTraffic"] = "false"');
    expect(plugin).toContain('"app", "src", "debug", "AndroidManifest.xml"');
    expect(plugin).toContain("androidx.profileinstaller.ProfileInstallReceiver");
    expect(plugin).toContain("rmSync");
  });

  it("takes release signing material from the environment and refuses a release without it", () => {
    const plugin = read("runtime/fleet-mobile/plugins/withFleetAndroid.ts");
    expect(plugin).toContain("signingConfig signingConfigs.release");
    expect(plugin).toContain('System.getenv("FLEET_ANDROID_KEYSTORE")');
    expect(plugin).toContain("Fleet Mobile release signing requires FLEET_ANDROID_KEYSTORE");
    // A release must never silently inherit the debug key that every Android SDK install shares.
    expect(plugin).not.toContain("release {\n            signingConfig signingConfigs.debug");
    expect(plugin).not.toMatch(/storePassword ['"](?!android')/);
  });

  // A second gate on the same Gradle tasks is how the release path stayed silently blocked once.
  it("keeps release policy in the app-level plugin alone", () => {
    const modulePlugin = read("runtime/fleet-mobile/modules/fleet-console-view/index.js");
    expect(modulePlugin).not.toContain("assembleRelease");
    expect(modulePlugin).not.toContain("fleet_mobile_release_requires_signing");
  });

  // The release commit rewrites both mobile package.json files through the workspace version sync.
  // Counting that machine edit as a change would distribute an APK for a release that never touched
  // the app, so detection skips release commits rather than the files they rewrite.
  it("distributes from CI only when the mobile path changed", () => {
    const release = read(".github/workflows/stable-release.yml");
    expect(release).toContain("mobile_changed=$1");
    expect(release).toContain("--invert-grep --grep='^chore(release):'");
    expect(release).toContain("-- runtime/fleet-mobile");
    expect(release).toContain("needs.release.outputs.mobile_changed == 'true'");
    expect(release).toContain("uses: ./.github/workflows/mobile-release.yml");
  });

  // iOS 전용으로 배포 플래그만 켜도 버전 해석이 돌아야 한다. 안 그러면 mobile_changed가
  // 비어 mobile-release 호출 자체가 일어나지 않고, 잡 단위 게이트까지 닿지 못한다.
  it("resolves the mobile shell version when either platform distribution flag is on", () => {
    const release = read(".github/workflows/stable-release.yml");
    expect(release).toContain(
      "vars.FLEET_MOBILE_DISTRIBUTION == 'true' || vars.FLEET_MOBILE_IOS_DISTRIBUTION == 'true'",
    );
    expect(release).toContain("if: needs.release.outputs.should_release == 'true' && needs.release.outputs.mobile_changed == 'true'");
  });

  // 검증 레일은 이벤트 소스를 그대로 체크아웃한다. ref 입력을 두면 "Use workflow from"과
  // 다른 커밋을 검사할 수 있고, Package.swift/apple 부재를 통과시키면 시뮬레이터 빌드가
  // 있는 척한다.
  it("hard-fails the iOS verify rail instead of skipping unfinished pieces", () => {
    const workflow = read(".github/workflows/mobile-ios-verify.yml");
    expect(workflow).not.toContain("inputs:");
    expect(workflow).not.toContain("inputs.ref");
    expect(workflow).not.toContain("steps.platform.outputs.configured");
    expect(workflow).not.toContain("configured=true");
    expect(workflow).not.toContain("exit 0");
    expect(workflow).toContain("runtime/fleet-mobile/modules/fleet-console-view/Package.swift");
    expect(workflow).toContain("c.platforms.includes('apple')||c.platforms.includes('ios')");
    expect(workflow).toContain("pnpm --dir runtime/fleet-mobile exec expo prebuild --platform ios");
    expect(workflow).toContain("fleetSanitizedLaunchOptions");
    // 이름과 순서만 보면 원본을 별칭한 사본도 통과한다. 실제로 지우는 줄까지 요구해야
    // 이 스텝이 "크리덴셜이 지워졌다"를 단언한다.
    expect(workflow).toContain("fleetSanitizedLaunchOptions?.removeValue(forKey: .url)");
    expect(workflow).toContain('grep -q "FleetConsoleView" runtime/fleet-mobile/ios/Podfile.lock');
    expect(workflow).toContain("CODE_SIGNING_ALLOWED=NO");
    expect(workflow).toContain("name: fleet-ios-simulator-app");
    expect(workflow).toContain("SecIdentityCreate");
  });

  it("records the release signing certificate in the promoted manifest", () => {
    const promote = read("runtime/fleet-mobile/scripts/lib/android-promote.mjs");
    expect(promote).toContain("signerSha256");
    expect(promote).toContain("manifestFile.signerSha256 !== signerSha256");
  });

  // The APK carries app.json, not package.json. Dropping it from the release commit would ship the
  // previous versionCode and silently replace the last App Distribution release.
  it("commits the bumped app.json in the release commit", () => {
    const release = read(".github/workflows/stable-release.yml");
    expect(release).toContain("git add runtime/fleet-mobile/app.json");
    expect(release).toContain("scripts/set-app-version.mjs --bump");
  });

  it("keeps signing material out of git", () => {
    const ignore = read(".gitignore");
    expect(ignore).toContain("*.keystore");
    expect(ignore).toContain("*.jks");
  });

  it("verifies the dedicated access-link activity and secure loopback transport", () => {
    const tools = read("runtime/fleet-mobile/scripts/lib/android-tools.mjs");
    const gateway = read("runtime/fleet-mobile/modules/fleet-console-view/android/src/main/java/com/dotobokuri/fleet/mobile/LoopbackGateway.kt");
    expect(tools).toContain("FleetLinkActivity");
    expect(tools).toContain("disable cleartext traffic");
    expect(gateway).toContain("SSLServerSocket");
    expect(gateway).toContain("validWebSocketAccept");
    expect(gateway).not.toContain("127.0.0.1\"");
  });
});
