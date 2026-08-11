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

  it("pins a dedicated CI job to the fixed artifact path", () => {
    const workflow = read(".github/workflows/mobile-android.yml");
    expect(workflow).toContain("runtime/fleet-mobile/dist/fleet-mobile-debug.apk");
    expect(workflow).toContain("pnpm --filter @dotobokuri/fleet-mobile android:build:debug");
    expect(workflow).toContain("pnpm --filter @dotobokuri/fleet-mobile android:verify:debug");
    expect(workflow).not.toMatch(/assembleRelease|bundleRelease|eas build/);
  });

  it("registers the fail-closed Android plugin after the native module", () => {
    const app = JSON.parse(read("runtime/fleet-mobile/app.json"));
    expect(app.expo.plugins.at(-1)).toBe("./plugins/withFleetAndroid.ts");
  });

  it("keeps production Android release assembly unsupported", () => {
    const plugin = read("runtime/fleet-mobile/plugins/withFleetAndroid.ts");
    expect(plugin).toContain("release signing is not configured");
    expect(plugin).toContain('application.$["android:usesCleartextTraffic"] = "false"');
    expect(plugin).toContain('"app", "src", "debug", "AndroidManifest.xml"');
    expect(plugin).toContain("androidx.profileinstaller.ProfileInstallReceiver");
    expect(plugin).toContain("rmSync");
    expect(plugin).not.toContain("signingConfig signingConfigs.debug\n        }\n        release");
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
