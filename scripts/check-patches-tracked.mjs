import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * patches/ 아래 파일은 저장소가 언제나 추적한다.
 *
 * 패치는 생성물처럼 보이지만 다시 만들 수 없다 — pnpm이 patchedDependencies로 이 경로를 직접
 * 가리키므로, 파일이 빠진 클론은 install에서 서고 무시 규칙에 걸린 클론은 패치 없이 조용히
 * 빌드된다. 두 번째가 더 나쁘다: 파일을 가진 사람만 고쳐진 의존성을 쓰고, 나머지는 같은
 * 커밋에서 다른 바이너리를 얻는다.
 *
 * 그래서 파일 상태만 보지 않는다. `*.patch`는 흔한 gitignore 항목이라 실수로 들어오기 쉽고,
 * 그때 이미 추적 중인 파일은 계속 추적되어 아무도 눈치채지 못한 채 다음 패치부터 사라진다.
 * 존재하지 않는 탐침 경로로 "새 패치가 무시될 규칙이 있는가"를 함께 묻는 이유다.
 */
const PATCHES_DIR = "patches";
// 실재하지 않는 경로들이다. 무시 규칙에만 질의한다. 깊이를 둘 다 묻는 이유는 부정 패턴이
// 한 깊이만 되살리기 때문이다 — `*.patch` 뒤의 `!patches/*.patch`는 최상위만 구제하고
// 하위 디렉터리의 패치는 계속 무시한다. 최상위만 물으면 그 규칙이 통과한다.
const PROBE_PATHS = [
  `${PATCHES_DIR}/__ignore-probe__.patch`,
  `${PATCHES_DIR}/__ignore-probe__/__ignore-probe__.patch`,
];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);

export function findPatchTrackingViolations(root = repoRoot) {
  if (!isGitWorkTree(root)) return [];
  const violations = [];
  if (PROBE_PATHS.some((probe) => isIgnored(root, probe))) {
    violations.push(`${PATCHES_DIR}/: an ignore rule would hide patch files`);
  }
  for (const rel of listPatchFiles(root)) {
    if (isIgnored(root, rel)) violations.push(`${rel}: ignored`);
    else if (!isTracked(root, rel)) violations.push(`${rel}: untracked`);
  }
  return violations;
}

// 패치가 아직 하나도 없는 저장소도 정상이다. 그 상태에서도 무시 규칙 검사는 남는다.
function listPatchFiles(root) {
  const base = path.join(root, PATCHES_DIR);
  let stat;
  try { stat = statSync(base); } catch { return []; }
  if (!stat.isDirectory()) return [];
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else files.push(path.relative(root, child).split(path.sep).join("/"));
    }
  };
  walk(base);
  return files.sort();
}

function git(root, args) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function isGitWorkTree(root) {
  return git(root, ["rev-parse", "--is-inside-work-tree"]).stdout?.trim() === "true";
}

// --no-index: 이미 추적 중이라는 이유로 규칙을 못 본 척하지 않는다. 추적 여부는 따로 묻는다.
function isIgnored(root, rel) {
  return git(root, ["check-ignore", "--quiet", "--no-index", "--", rel]).status === 0;
}

function isTracked(root, rel) {
  return git(root, ["ls-files", "--error-unmatch", "--", rel]).status === 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = findPatchTrackingViolations();
  if (violations.length > 0) {
    console.error(`files under ${PATCHES_DIR}/ must stay tracked. These do not:`);
    for (const violation of violations) console.error(`- ${violation}`);
    console.error(`Drop the ignore rule, or commit the file — pnpm resolves patchedDependencies from ${PATCHES_DIR}/.`);
    process.exit(1);
  }
  console.log(`[check-patches-tracked] no violations — ${PATCHES_DIR}/`);
}
