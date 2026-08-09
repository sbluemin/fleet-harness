import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `@anthropic-ai/claude-agent-sdk`를 import하거나 의존으로 선언할 수 있는 위치를 고정한다.
 *
 * 이 게이트가 지키는 계약은 "소비처는 vendor SDK를 직접 의존하지 않는다"이며, 그 계약을 자동으로
 * 발화시킬 수 있는 층은 이 리포에서 여기뿐이다 — PR CI는 게이트와 `node --test scripts/*.test.mjs`만
 * 돌리고 워크스페이스 vitest는 돌리지 않으므로, 패키지 테스트에 둔 검사는 매 PR에 발화하지 않는다.
 */
const VENDOR_SDK = "@anthropic-ai/claude-agent-sdk";

/**
 * 따옴표에 싸인 모듈 지정자만 참조로 센다.
 *
 * 맨 부분 문자열로 세면 이 패키지를 설명하는 주석과 문서 문장까지 위반이 된다. 금지 대상은 언급이
 * 아니라 import·require·vi.mock·manifest 키이고, 그것들은 전부 작은/큰따옴표 안에 있다.
 *
 * 백틱은 일부러 뺐다. 이 리포는 주석에서 식별자를 백틱 code span으로 감싸므로 포함하면 설명하는
 * 파일마다 위반이 된다. 대가는 `import(\`@anthropic-ai/claude-agent-sdk\`)`라는 이론적 우회가
 * 남는 것인데, 정적 import는 그 형태를 쓸 수 없고 동적 import를 그렇게 쓸 이유도 없다.
 */
const REFERENCE = new RegExp(`["']${VENDOR_SDK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`);

/**
 * 이 토큰이 허용되는 정확한 리포 상대 경로.
 *
 * 새 창구는 여기 추가해야만 열린다. 반대로 어떤 경로가 더 이상 토큰을 담지 않으면 그것도 실패다 —
 * 죽은 예외가 남아 있으면 다음 사람이 그 경로를 "이미 허용된 곳"으로 읽고 창구를 되살린다.
 */
const ALLOWED = [
  // 이 리포가 vendor SDK를 부르는 유일한 신규 지점.
  "packages/core-agent/src/claude/vendor-sdk.ts",
  "packages/core-agent/package.json",
  // 선존: Console은 소스에서 부르지 않지만 게시 매니페스트 external 해석을 위해 선언한다.
  "runtime/fleet-console/package.json",
  // 플러그인 런타임 번들러가 이 패키지를 external로 지정한다 — 이름만 쓰고 import하지 않는다.
  // 인라인되면 SDK가 자기 네이티브 바이너리를 못 찾으므로 이 지정이 정확성 요건이다.
  "runtime/fleet-console/core/host/plugin-host/plugin-host.ts",
  "runtime/fleet-console/tests/published-manifest.test.ts",
  "scripts/pack-fleet-console-manifest.mjs",
  "scripts/check-dist-published-externals.test.mjs",
  // 이 게이트 자신과 그 테스트.
  "scripts/check-claude-agent-sdk-boundary.mjs",
  "scripts/check-claude-agent-sdk-boundary.test.mjs",
];

const SCAN_ROOTS = ["packages", "runtime", "scripts", "examples"];
const SCANNED_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"];
// 생성물과 설치물은 원본이 아니다. dist 번들은 소스에 없는 토큰을 그대로 품는다.
const SKIPPED_DIRECTORIES = new Set([
  "node_modules", "dist", "build", "out", "coverage", ".fleet", ".git", ".turbo", ".vite",
]);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);

export function findVendorSdkBoundaryViolations(root = repoRoot, allowed = ALLOWED) {
  const allowSet = new Set(allowed);
  const seenAllowed = new Set();
  const violations = [];

  for (const scanRoot of SCAN_ROOTS) {
    for (const file of listFiles(path.join(root, scanRoot))) {
      const rel = toPosix(path.relative(root, file));
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      const hits = [];
      lines.forEach((line, index) => {
        if (REFERENCE.test(line)) hits.push(index + 1);
      });
      if (hits.length === 0) continue;
      if (allowSet.has(rel)) {
        seenAllowed.add(rel);
        continue;
      }
      for (const line of hits) violations.push({ kind: "unexpected", path: `${rel}:${line}` });
    }
  }

  for (const rel of allowed) {
    if (!seenAllowed.has(rel)) violations.push({ kind: "stale", path: rel });
  }
  return violations;
}

function listFiles(dir) {
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
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      files.push(...listFiles(childPath));
    } else if (SCANNED_EXTENSIONS.includes(path.extname(entry.name))) {
      files.push(childPath);
    }
  }
  return files;
}

// 게이트 판정은 플랫폼에 따라 달라지면 안 된다. Windows의 `\`를 리포 표기인 `/`로 정규화한다.
function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

// 직접 실행일 때만 프로세스를 종료시킨다. 테스트는 위 함수를 import해서 쓴다.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = findVendorSdkBoundaryViolations();
  const unexpected = violations.filter((violation) => violation.kind === "unexpected");
  const stale = violations.filter((violation) => violation.kind === "stale");
  if (unexpected.length > 0) {
    console.error(`${VENDOR_SDK} may only be referenced from the allowed locations in scripts/check-claude-agent-sdk-boundary.mjs.`);
    console.error("Consume @dotobokuri/core-agent instead of depending on the vendor SDK:");
    for (const violation of unexpected) console.error(`- ${violation.path}`);
  }
  if (stale.length > 0) {
    console.error(`These allowlist entries no longer reference ${VENDOR_SDK}. Delete them from the allowlist:`);
    for (const violation of stale) console.error(`- ${violation.path}`);
  }
  if (violations.length > 0) process.exit(1);
}
