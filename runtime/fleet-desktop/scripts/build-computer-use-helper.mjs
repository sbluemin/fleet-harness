import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") process.exit(0);

const source = fileURLToPath(new URL("../native/computer-use", import.meta.url));
const app = fileURLToPath(new URL("../dist/helpers/Fleet%20Computer%20Use.app", import.meta.url));
const contents = join(app, "Contents");
const executable = "fleet-computer-use";
const build = ["build", "-c", "release", "--arch", "arm64"];
execFileSync("/usr/bin/swift", build, { cwd: source, stdio: "inherit" });
const built = execFileSync("/usr/bin/swift", [...build, "--show-bin-path"], { cwd: source, encoding: "utf8" }).trim();
rmSync(app, { recursive: true, force: true });
mkdirSync(join(contents, "MacOS"), { recursive: true });
copyFileSync(join(built, executable), join(contents, "MacOS", executable));
writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.dotobokuri.fleet-console.computer-use</string>
  <key>CFBundleExecutable</key><string>${executable}</string>
  <key>CFBundleName</key><string>Fleet Computer Use</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
`);
execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], { stdio: "inherit" });
