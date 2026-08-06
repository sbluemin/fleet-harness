import { readdirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 번들러가 import 지정자의 node: 접두를 벗기면, 맨 이름 별칭이 없는 빌트인(node:sqlite 등)은
 * 산출물이 런타임에 ERR_MODULE_NOT_FOUND로 죽는다. 소스와 테스트는 접두를 그대로 쓰므로
 * 전부 green인 채로 배포 번들만 깨진다 — 그래서 빌드 산출물을 직접 검사한다.
 *
 * 판정은 실행 중인 Node가 그 빌트인을 아는지에 의존하지 않는다: 소스가 node:X로 썼는데
 * 맨 이름 X가 빌트인이 아니면, 벗겨진 X는 어느 런타임에서도 해석되지 않는다.
 */

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const distRoot = path.join(repoRoot, "runtime", "fleet-console", "dist");
const sourceRoots = [path.join(repoRoot, "packages"), path.join(repoRoot, "runtime")];
const skippedDirectories = new Set(["node_modules", "dist", ".fleet", "release", "test-results", ".stage"]);

const prefixRequired = collectPrefixRequiredSpecifiers();
const violations = [];

for (const file of listFiles(distRoot, ".mjs", new Set(["client"]))) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const name of prefixRequired) {
      if (!bareSpecifierPatterns(name).some((pattern) => pattern.test(line))) continue;
      violations.push(`${path.relative(repoRoot, file)}:${index + 1} imports "${name}" instead of "node:${name}"`);
    }
  });
}

if (violations.length > 0) {
  console.error("built artifacts lost a required node: prefix — the bare specifier does not resolve at runtime:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

/** 소스가 쓴 node:X 중 맨 이름 X가 빌트인이 아닌 것 — 접두가 없으면 해석되지 않는 지정자. */
function collectPrefixRequiredSpecifiers() {
  const names = new Set();
  for (const root of sourceRoots) {
    for (const file of listFiles(root, [".ts", ".tsx", ".mts", ".js", ".mjs"])) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/["']node:([\w./-]+)["']/g)) {
        const name = match[1];
        if (!isBuiltin(name)) names.add(name);
      }
    }
  }
  return names;
}

/**
 * 맨 이름으로 남은 static import·re-export·dynamic import·require를 잡되, 지정자 자리에
 * 오지 않은 같은 철자는 잡지 않는다. 산문("failed to import 'sqlite'")이나 다른 호출
 * (`Array.from("sqlite")`·`__myimport("sqlite")`)까지 위반으로 보면, 이 게이트가 막아야 할
 * 결함을 정직하게 진단하려는 후속 수정이 오히려 빌드에서 막힌다.
 */
function bareSpecifierPatterns(name) {
  const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const specifier = String.raw`["']${escaped}["']`;
  return [
    // 부작용 전용 import는 산문과 철자가 겹치므로 문(statement) 시작에서만 인정한다.
    new RegExp(String.raw`^\s*import\s+${specifier}`),
    new RegExp(String.raw`(?<![\w$.])from\s*${specifier}`),
    new RegExp(String.raw`(?<![\w$.])(?:import|require)\s*\(\s*${specifier}`),
  ];
}

/** 디렉터리 하위 파일을 재귀 수집한다(디렉터리 부재 시 빈 배열). */
function listFiles(dir, extensions, extraSkips = new Set()) {
  const allowed = Array.isArray(extensions) ? extensions : [extensions];
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skippedDirectories.has(entry.name) || extraSkips.has(entry.name)) continue;
      files.push(...listFiles(path.join(dir, entry.name), allowed, extraSkips));
    } else if (allowed.some((extension) => entry.name.endsWith(extension))) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}
