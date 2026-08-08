import { readFileSync, readdirSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPublishedFleetConsoleManifest } from "./pack-fleet-console-manifest.mjs";

/**
 * 번들에 인라인되지 않은 의존성은 게시 매니페스트가 들고 있어야 설치처에서 해석된다.
 * tsup은 `dependencies`를 전부 external로 남기지만 게시 매니페스트는 allowlist라
 * `pkg.dependencies`를 통째로 교체한다 — 그래서 콘솔에 런타임 의존성을 한 줄 추가하고
 * allowlist를 잊으면, 워크스페이스는 전부 green인 채로 게시본만 부팅 즉시
 * ERR_MODULE_NOT_FOUND로 죽는다.
 *
 * 판정은 산출물이 실제로 무엇을 해석하려 드는지에서 나온다. 소스의 import 문이 아니라
 * 게시되는 dist를 읽는 이유이고, 소스만 보면 번들 인라인된 것과 external로 남은 것을
 * 구분할 수 없기 때문이다.
 *
 * 예외 목록은 두지 않는다. "게시본은 그 경로에 도달하지 않는다"를 근거로 예외를 세우면,
 * 그 주장이 틀렸을 때 게이트가 결함을 승인한 기록으로 남는다 — esbuild가 실제로 그랬다.
 * 정말로 게시할 수 없는 지정자가 생기면 그때 무엇을 잃는지와 함께 예외를 다시 세울 것.
 */

/** npm 패키지 이름의 첫 세그먼트 모양. 산문이 지정자 자리처럼 보이는 경우를 걸러낸다. */
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/**
 * 런타임이 해석해야 하는 자리에 놓인 지정자만 뽑는다.
 *
 * tsup이 require 심을 `require4`·`nodePtyRequire`처럼 이름을 바꿔 내보내므로 그 형태도
 * 함께 본다. 지정자 자리에 오지 않은 같은 철자(산문·다른 호출)는 뽑지 않는다 —
 * 게이트가 잡아야 할 결함이 아닌 것으로 빌드를 막으면 진단이 오히려 어려워진다.
 */
// 인용부호 앞의 `(?<!\\)`는 산문 안의 이스케이프된 인용부호(`... from \"x\"`)를 지정자로 읽지
// 않게 한다. 남는 오탐 위험보다 누락이 더 나쁘므로 패턴 자체는 넓게 두고, 아래 패키지 이름
// 모양 검사와 ALLOWED_OMISSIONS가 마지막 여과를 맡는다.
const SPECIFIER_PATTERNS = [
  // 부작용 전용 import는 산문과 철자가 겹치므로 문(statement) 시작에서만 인정한다.
  /^[ \t]*import\s*(?<!\\)(['"])([^'"]+)\1/gm,
  /(?<![\w$.])from\s*(?<!\\)(['"])([^'"]+)\1/g,
  /(?<![\w$.])import\s*\(\s*(?<!\\)(['"])([^'"]+)\1\s*\)/g,
  /(?<![\w$.])[\w$]*[Rr]equire\d*\s*\(\s*(?<!\\)(['"])([^'"]+)\1\s*\)/g,
];

const skippedDirectories = new Set(["node_modules", "client"]);

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.dirname(scriptDir);
  const consoleRoot = path.join(repoRoot, "runtime", "fleet-console");
  const distRoot = path.join(consoleRoot, "dist");

  const manifest = createPublishedFleetConsoleManifest(JSON.parse(readFileSync(path.join(consoleRoot, "package.json"), "utf8")));
  const published = new Set(Object.keys(manifest.dependencies ?? {}));

  const files = listFiles(distRoot, ".mjs");
  // 검사할 번들이 없으면 통과가 아니라 실패다 — 빈 검사는 "전부 통과"와 구분되지 않는다.
  if (files.length === 0) {
    console.error(`no built console bundles under ${path.relative(repoRoot, distRoot)} — build before running this gate`);
    process.exit(1);
  }

  const violations = [];
  const resolved = new Set();
  for (const file of files) {
    for (const { name, line } of collectExternalPackages(readFileSync(file, "utf8"))) {
      if (published.has(name)) { resolved.add(name); continue; }
      violations.push(`${path.relative(repoRoot, file)}:${line} needs "${name}", which the published manifest does not depend on`);
    }
  }

  if (violations.length > 0) {
    console.error("built artifacts reference packages the published manifest omits — a clean install cannot resolve them:");
    for (const violation of violations) console.error(`- ${violation}`);
    console.error(`Add the package to EXTERNAL_DEP_NAMES in ${path.relative(repoRoot, path.join(scriptDir, "pack-fleet-console-manifest.mjs"))}, or bundle it via tsup noExternal.`);
    process.exit(1);
  }

  // 무엇을 검사했는지 세어서 남긴다 — 0건 통과와 전수 통과가 같은 문장으로 읽히면 안 된다.
  console.log(`published externals verified across ${files.length} console bundle(s): ${[...resolved].sort().join(", ") || "none referenced"}.`);
}

/**
 * 번들 텍스트에서 해석 대상 패키지 이름과 그 줄 번호를 뽑는다. 상대 경로·빌트인·
 * 패키지 이름 모양이 아닌 것은 제외하고, 서브패스는 패키지 이름으로 접는다.
 */
export function collectExternalPackages(text) {
  const found = new Map();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[2];
      if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) continue;
      const name = packageNameOf(specifier);
      if (name === null || isBuiltin(name)) continue;
      if (!found.has(name)) found.set(name, lineOf(text, match.index));
    }
  }
  return [...found].map(([name, line]) => ({ name, line })).sort((left, right) => left.line - right.line);
}

/** `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. 이름 모양이 아니면 null. */
function packageNameOf(specifier) {
  const segments = specifier.split("/");
  const name = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  return PACKAGE_NAME.test(name) ? name : null;
}

function lineOf(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text[cursor] === "\n") line += 1;
  }
  return line;
}

/** 디렉터리 하위 파일을 재귀 수집한다(디렉터리 부재 시 빈 배열). */
function listFiles(dir, extension) {
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
      if (skippedDirectories.has(entry.name)) continue;
      files.push(...listFiles(path.join(dir, entry.name), extension));
    } else if (entry.name.endsWith(extension)) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}
