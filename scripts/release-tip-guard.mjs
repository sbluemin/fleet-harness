import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 릴리스 검증이 도는 동안 main이 나아가면 릴리스 커밋의 push가 거절된다. 그 사이 커밋이
// stable-release 워크플로가 이미 "릴리스 산출물에 영향 없음"으로 선언한 경로만 건드렸다면
// 릴리스 커밋을 그 위로 옮겨 실어도 게시되는 코드는 검증한 그대로다. 그 판단 기준을 여기에
// 옮겨 적지 않고 워크플로의 paths-ignore에서 직접 읽는 이유는, 두 벌이 되는 순간 한쪽만
// 고쳐져 검증하지 않은 코드가 게시될 수 있기 때문이다.
export const WORKFLOW_RELATIVE_PATH = ".github/workflows/stable-release.yml";

// paths-ignore가 릴리스를 트리거하지 않는다고 선언한 경로 중에도, 빌드가 읽어 산출물로 옮기는
// 것이 있다. `**.md`가 특히 그렇다 — 미출시 프래그먼트는 컴파일된 릴리스 노트가 되고, 내장 스킬
// 마크다운은 생성 자산으로 번들된다. 어느 마크다운이 산출물이 되는지 하나씩 세는 목록은 새 자산이
// 생길 때마다 조용히 뒤처지므로, 게시되는 소스 트리 안이면 확장자와 무관하게 릴리스 입력으로 본다.
// 그 안의 순수 문서까지 함께 멈추는 것은 감수한다 — 멈춘 런은 전체 재실행으로 회복되지만, 검증하지
// 않은 채 게시된 것은 되돌릴 수 없다.
export const RELEASE_INPUT_PREFIXES = [".changelog.d/", "packages/", "runtime/"];

export function consumesReleaseInput(file) {
  return RELEASE_INPUT_PREFIXES.some((prefix) => file.startsWith(prefix));
}

export function parsePathsIgnore(workflowText) {
  const lines = String(workflowText).split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*paths-ignore:\s*$/.test(line));
  if (start === -1) return [];
  const indent = lines[start].match(/^(\s*)/)[1].length;
  const patterns = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const entry = line.match(/^(\s*)-\s*(.+?)\s*$/);
    if (!entry || entry[1].length <= indent) break;
    patterns.push(entry[2].replace(/^['"]|['"]$/g, ""));
  }
  return patterns;
}

// paths-ignore가 실제로 쓰는 글롭 모양만 옮긴다: 디렉터리 접두(`docs/**`)와 확장자 접미(`**.md`).
// 알아보지 못한 모양은 무시가 아니라 오류로 다뤄, 판단할 수 없는 패턴이 통과로 새지 않게 한다.
export function compilePattern(pattern) {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return (file) => file === prefix || file.startsWith(`${prefix}/`);
  }
  if (pattern.startsWith("**") && !pattern.slice(2).includes("*")) {
    const suffix = pattern.slice(2);
    return (file) => file.endsWith(suffix);
  }
  throw new Error(`Unsupported paths-ignore pattern: ${pattern}`);
}

export function areAllPathsIgnorable(files, patterns) {
  // 패턴이 하나도 없으면 판단할 근거가 없다는 뜻이므로 막는다.
  if (patterns.length === 0) return false;
  if (files.length === 0) return false;
  if (files.some(consumesReleaseInput)) return false;
  const matchers = patterns.map(compilePattern);
  return files.every((file) => matchers.some((matches) => matches(file)));
}

export function changedFiles(fromRev, toRev, { execFile = execFileSync } = {}) {
  const stdout = execFile("git", ["diff", "--name-only", "--end-of-options", fromRev, toRev], { encoding: "utf8" });
  return stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

function main(argv) {
  const [fromRev, toRev] = argv;
  if (!fromRev || !toRev) throw new Error("usage: release-tip-guard.mjs <verified-rev> <new-tip-rev>");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const patterns = parsePathsIgnore(readFileSync(path.join(repoRoot, WORKFLOW_RELATIVE_PATH), "utf8"));
  const files = changedFiles(fromRev, toRev);
  const ignorable = areAllPathsIgnorable(files, patterns);
  console.log(`${ignorable ? "ignorable" : "release-affecting"}: ${files.length} path(s) changed between ${fromRev} and ${toRev}`);
  for (const file of files) console.log(`  ${file}`);
  process.exitCode = ignorable ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
