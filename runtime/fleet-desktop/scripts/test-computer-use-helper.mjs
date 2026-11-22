import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 헬퍼의 Swift 시험(실제 TCC를 건드리지 않는 순수 로직). Command Line Tools만 있으면 swift test가 Testing 모듈을 찾지 못하므로
// 그 경로를 넘긴다. Xcode가 활성 개발 도구면 그대로 돈다.
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
