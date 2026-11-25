import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { codesignWithFallback, resolveDevCodesignIdentity, signingEnv } from "./dev-codesign.mjs";

if (process.platform === "win32") {
  buildWindowsHelper();
  process.exit(0);
}
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
// Seal the compiled platform ABI marker inside the helper bundle before signing.
mkdirSync(join(contents, "Resources"), { recursive: true });
writeFileSync(join(contents, "Resources", "computer-use-platform-version"), "1\n");
// 개발 실행은 이 헬퍼를 그대로 쓴다. Fleet Console Dev와 같은 ID로 서명해 릴리스(앱과 같은 팀으로 헬퍼 서명)와 맞춘다.
// 설치본은 electron-builder가 Developer ID로 다시 서명하므로 여기의 ID와 무관하다.
await codesignWithFallback("Fleet Computer Use helper", await resolveDevCodesignIdentity(), async (identity) => {
  execFileSync("/usr/bin/codesign", ["--force", "--sign", identity, "--timestamp=none", app], { stdio: "inherit", env: signingEnv() });
}, (message) => process.stdout.write(`${message}\n`), { advice: false });

/** Windows 헬퍼: self-contained single-file .NET 실행 파일 + 플랫폼 ABI marker. 사용자 설치에 .NET이 필요 없다. */
function buildWindowsHelper() {
  const project = fileURLToPath(new URL("../native/computer-use-windows/Helper/FleetComputerUse.Helper.csproj", import.meta.url));
  const output = fileURLToPath(new URL("../dist/helpers/fleet-computer-use", import.meta.url));
  // 릴리스 패키징(FLEET_REQUIRE_COMPUTER_USE_HELPER=1)만 헬퍼 없이 진행하지 못한다. 개발자 빌드와 다른 CI 잡은 경고 후 건너뛴다.
  const required = process.env.FLEET_REQUIRE_COMPUTER_USE_HELPER === "1";
  const skip = (reason) => {
    if (required) throw new Error(reason);
    process.stdout.write("warning: skipping the Windows Computer Use helper build: " + reason + "\n");
  };
  if (spawnSync("dotnet", ["--version"], { stdio: "ignore", shell: false }).status !== 0) {
    return skip("The .NET SDK (10.x) is required to build the Windows Computer Use helper, but `dotnet` was not found on PATH. Install it from https://dotnet.microsoft.com/download/dotnet/10.0");
  }
  if (!existsSync(project)) return skip(`Windows Computer Use helper project is missing: ${project}`);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  execFileSync("dotnet", ["publish", project, "-c", "Release", "-r", "win-x64", "--self-contained", "true", "-p:PublishSingleFile=true", "-p:DebugType=None", "-o", output], { stdio: "inherit" });
  if (!existsSync(join(output, "fleet-computer-use.exe"))) throw new Error(`dotnet publish did not produce fleet-computer-use.exe in ${output}`);
  writeFileSync(join(output, "computer-use-platform-version"), "1\n");
}
