import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 삭제된 ACP 패키지가 되살아나지 않게 막는다.
 *
 * 문자열 검사만 하면 컴파일된 릴리스 노트가 걸린다. 그쪽은 컴파일러 소유라 손댈 수 없고, 과거
 * 릴리스에 이 이름이 등장한 것은 사실 그대로다. 그래서 검사 대상은 살아 있는 소스·매니페스트·
 * 설정·문서로 한정한다.
 */
const TOKEN = "core-unified-agent";
const SCAN_ROOTS = ["packages", "runtime", "scripts", "examples", "docs", "pnpm-workspace.yaml"];
const SCANNED_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json", ".yaml", ".yml", ".md"];
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", "out", "coverage", ".fleet", ".git"]);
// 컴파일러 소유 출력물. 과거 릴리스 기록은 다시 쓰지 않는다.
const SKIPPED_FILES = new Set(["CHANGELOG.md", "CHANGELOG.ko.md", "check-core-unified-agent-absent.mjs", "check-core-unified-agent-absent.test.mjs"]);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);

export function findCoreUnifiedAgentReferences(root = repoRoot) {
  const hits = [];
  for (const scanRoot of SCAN_ROOTS) {
    for (const file of listFiles(path.join(root, scanRoot))) {
      if (SKIPPED_FILES.has(path.basename(file))) continue;
      const rel = path.relative(root, file).split(path.sep).join("/");
      readFileSync(file, "utf8").split(/\r?\n/).forEach((line, index) => {
        if (line.includes(TOKEN)) hits.push(`${rel}:${index + 1}`);
      });
    }
  }
  return hits;
}

function listFiles(target) {
  let stat;
  try { stat = statSync(target); } catch { return []; }
  if (stat.isFile()) return SCANNED_EXTENSIONS.includes(path.extname(target)) ? [target] : [];
  const files = [];
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      files.push(...listFiles(child));
    } else if (SCANNED_EXTENSIONS.includes(path.extname(entry.name))) {
      files.push(child);
    }
  }
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hits = findCoreUnifiedAgentReferences();
  if (hits.length > 0) {
    console.error(`${TOKEN} was removed. These active references must go:`);
    for (const hit of hits) console.error(`- ${hit}`);
    process.exit(1);
  }
}
