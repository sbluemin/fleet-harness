import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 스크립트 위치 기준으로 packages 디렉터리를 해석한다(cwd 비의존).
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const packagesDir = path.join(repoRoot, "packages");
const violations = [];

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith("core-")) continue;
  const packageDir = path.join(packagesDir, entry.name);

  // manifest 검사: core-* package.json은 @dotobokuri/fleet-* 의존을 가질 수 없다.
  const manifestPath = path.join(packageDir, "package.json");
  const manifest = readFileSync(manifestPath, "utf8");
  if (manifest.includes('"@dotobokuri/fleet-')) {
    violations.push(path.relative(repoRoot, manifestPath));
  }

  // 소스 검사: core-*의 src/tests .ts 파일은 @dotobokuri/fleet-* import를 가질 수 없다.
  for (const scanRoot of ["src", "tests"]) {
    for (const file of listTsFiles(path.join(packageDir, scanRoot))) {
      const text = readFileSync(file, "utf8");
      const lines = text.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (/@dotobokuri\/fleet-/.test(line)) {
          violations.push(`${path.relative(repoRoot, file)}:${index + 1}`);
        }
      });
    }
  }
}

if (violations.length > 0) {
  console.error("core packages must not depend on @dotobokuri/fleet-* packages:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

// 디렉터리 하위의 .ts 파일을 재귀적으로 수집한다(디렉터리 부재 시 빈 배열).
function listTsFiles(dir) {
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const childPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(childPath));
    } else if (entry.name.endsWith(".ts")) {
      files.push(childPath);
    }
  }
  return files;
}
