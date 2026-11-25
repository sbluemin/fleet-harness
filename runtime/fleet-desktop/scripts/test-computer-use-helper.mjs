import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 헬퍼의 Swift 시험(실제 TCC를 건드리지 않는 순수 로직). Command Line Tools만 있으면 swift test가 Testing 모듈을 찾지 못하므로
// 그 경로를 넘긴다. Xcode가 활성 개발 도구면 그대로 돈다.
if (process.platform === "win32") {
  // Windows 헬퍼의 .NET 시험(실제 입력·UIA 대상 없이 도는 순수 로직 프로젝트).
  const testsDirectory = fileURLToPath(new URL("../native/computer-use-windows/Tests/Helper.Tests/", import.meta.url));
  const tests = existsSync(testsDirectory) ? readdirSync(testsDirectory).find((name) => name.endsWith(".csproj")) : undefined;
  if (!tests) { console.log(`Windows helper tests not present, skipping: ${testsDirectory}`); process.exit(0); }
  const result = spawnSync("dotnet", ["test", join(testsDirectory, tests), "-c", "Release"], { stdio: "inherit" });
  if (result.error) throw new Error("The .NET SDK (10.x) is required to test the Windows Computer Use helper (`dotnet` was not found on PATH).");
  process.exit(result.status ?? 1);
}
if (process.platform !== "darwin") process.exit(0);
const source = fileURLToPath(new URL("../native/computer-use", import.meta.url));
const developer = execFileSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8" }).trim();
const frameworks = join(developer, "Library", "Developer", "Frameworks");
const libraries = join(developer, "Library", "Developer", "usr", "lib");
const extra = developer.endsWith("CommandLineTools") && existsSync(join(frameworks, "Testing.framework"))
  ? ["-Xswiftc", "-F", "-Xswiftc", frameworks, "-Xlinker", "-F", "-Xlinker", frameworks, "-Xlinker", "-rpath", "-Xlinker", frameworks, "-Xlinker", "-rpath", "-Xlinker", libraries]
  : [];
const result = spawnSync("/usr/bin/swift", ["test", ...extra], { cwd: source, stdio: "inherit" });
process.exit(result.status ?? 1);
