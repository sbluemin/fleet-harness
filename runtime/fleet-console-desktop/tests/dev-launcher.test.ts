import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error The Node launcher is intentionally a runtime .mjs script.
import { createInfoPlist, createMacDevLaunchArguments, createMacDevWrapper } from "../scripts/launch-dev-desktop.mjs";

const TEMP_DIRS: string[] = [];

afterEach(() => {
  for (const directory of TEMP_DIRS.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

describe("macOS Desktop dev wrapper", () => {
  it("clones Electron once and replaces only the Fleet Console product identity", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-wrapper-"));
    TEMP_DIRS.push(root);
    const electronApp = path.join(root, "Electron.app", "Contents");
    const electronBinary = path.join(electronApp, "MacOS", "Electron");
    const iconPath = path.join(root, "icon.icns");
    fs.mkdirSync(path.dirname(electronBinary), { recursive: true });
    fs.mkdirSync(path.join(electronApp, "Frameworks"), { recursive: true });
    fs.mkdirSync(path.join(electronApp, "Resources"), { recursive: true });
    fs.writeFileSync(electronBinary, "electron");
    fs.writeFileSync(path.join(electronApp, "Resources", "default_app.asar"), "resources");
    fs.writeFileSync(path.join(electronApp, "Info.plist"), sourceInfoPlist());
    fs.writeFileSync(iconPath, "icon");
    let clones = 0;
    const cloneApp = async (source: string, destination: string) => {
      clones += 1;
      fs.cpSync(source, destination, { recursive: true });
    };
    const input = { electronBinary, iconPath, stageDirectory: path.join(root, ".stage", "dev-app"), cloneApp };

    const wrapper = await createMacDevWrapper(input);
    const info = fs.readFileSync(path.join(wrapper.appPath, "Contents", "Info.plist"), "utf8");

    expect(info).toContain("<key>CFBundleDisplayName</key><string>Fleet Console</string>");
    expect(info).toContain("<key>CFBundleIdentifier</key><string>com.dotobokuri.fleet-console</string>");
    expect(info).toContain("<key>CFBundleName</key><string>Fleet Console</string>");
    expect(info).toContain("<key>CFBundleExecutable</key><string>Electron</string>");
    expect(info).toContain("<key>NSPrincipalClass</key><string>AtomApplication</string>");
    expect(info).toContain(`<key>FleetConsoleDevElectronApp</key><string>${path.join(root, "Electron.app")}</string>`);
    expect(fs.readFileSync(wrapper.executablePath, "utf8")).toBe("electron");
    expect(fs.existsSync(path.join(wrapper.appPath, "Contents", "Frameworks"))).toBe(true);
    expect(fs.readFileSync(path.join(wrapper.appPath, "Contents", "Resources", "default_app.asar"), "utf8")).toBe("resources");
    expect(fs.readFileSync(path.join(wrapper.appPath, "Contents", "Resources", "icon.icns"), "utf8")).toBe("icon");
    expect(clones).toBe(1);

    await createMacDevWrapper(input);
    expect(clones).toBe(1);
  });

  it("escapes the wrapper source path while preserving the Electron Info.plist", () => {
    const info = createInfoPlist(sourceInfoPlist().replace("</dict>", "<key>Nested</key><dict><key>Value</key><string>preserved</string></dict></dict>"), "/tmp/Fleet & Console.app");

    expect(info).toContain("Fleet &amp; Console.app");
    expect(info).toContain("<key>LSMinimumSystemVersion</key><string>12.0</string>");
    expect(info).toContain("<key>Nested</key><dict><key>Value</key><string>preserved</string></dict>  <key>FleetConsoleDevElectronApp</key>");
  });

  it("launches the wrapper through macOS open without shell arguments", () => {
    expect(createMacDevLaunchArguments("/tmp/Fleet Console.app", "/workspace/runtime/fleet-console-desktop")).toEqual([
      "-W", "-n", "/tmp/Fleet Console.app", "--args", "/workspace/runtime/fleet-console-desktop",
    ]);
  });
});

function sourceInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleDisplayName</key><string>Electron</string>
  <key>CFBundleExecutable</key><string>Electron</string>
  <key>CFBundleIconFile</key><string>electron.icns</string>
  <key>CFBundleIdentifier</key><string>com.github.Electron</string>
  <key>CFBundleName</key><string>Electron</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSPrincipalClass</key><string>AtomApplication</string>
</dict></plist>`;
}
