import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

describe("Fleet Mobile Android build contract", () => {

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
