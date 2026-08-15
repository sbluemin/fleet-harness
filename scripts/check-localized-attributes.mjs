#!/usr/bin/env node
/**
 * 사용자에게 읽히는 JSX 속성이 번역기를 우회하지 못하게 막는다.
 *
 * `aria-label`, `title`, `placeholder`는 화면에 뜨거나 보조기술이 읽는 문자열이다. 여기에
 * 리터럴을 그대로 적으면 한국어 콘솔이 영어로 답하고, 그 사실은 화면을 실제로 열어 보기
 * 전까지 드러나지 않는다 — 터미널 표면이 정확히 그렇게 `aria-label="Terminal"`을 달고 있었다.
 *
 * 잡는 것은 "번역기를 거치지 않은 자연어"뿐이다. 식별자, 단일 기호, 빈 문자열은 화면의 말이
 * 아니므로 통과시킨다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const LOCALIZED_ATTRIBUTE_ROOTS = ["runtime/fleet-console/core/client", "runtime/fleet-plugins"];

const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", "tests", "__tests__"]);
const LOCALIZED_ATTRIBUTES = ["aria-label", "title", "placeholder"];
// 자연어로 보려면 대문자로 시작하는 낱말이거나 공백으로 갈린 낱말이 둘 이상이어야 한다.
// `id`, `x`, `▾` 같은 값은 화면의 말이 아니다.
const LOOKS_LIKE_PROSE = /^(?:[A-Z][a-z]+|[^\s]+(?:\s+\S+)+)/u;

function walk(directory, files = []) {
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      walk(full, files);
      continue;
    }
    // 테스트는 화면의 말이 아니라 그 말을 찾는 셀렉터로 문자열을 쓴다 — 검사 대상이 아니다.
    if (full.endsWith(".test.tsx") || full.endsWith(".spec.tsx")) continue;
    if (full.endsWith(".tsx")) files.push(full);
  }
  return files;
}

/** `<root>/<검사 대상 디렉터리>` 아래의 위반을 `path:line attribute="value"` 형태로 돌려준다. */
export function findLocalizedAttributeViolations(root, roots = LOCALIZED_ATTRIBUTE_ROOTS) {
  const violations = [];
  for (const relativeRoot of roots) {
    for (const file of walk(path.join(root, relativeRoot))) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const attribute of LOCALIZED_ATTRIBUTES) {
          const match = new RegExp(`\\b${attribute}="([^"]*)"`, "u").exec(line);
          if (!match) continue;
          const value = match[1];
          if (!value || !LOOKS_LIKE_PROSE.test(value)) continue;
          violations.push(`${path.relative(root, file)}:${index + 1} ${attribute}="${value}"`);
        }
      });
    }
  }
  return violations;
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const violations = findLocalizedAttributeViolations(process.cwd());
  if (violations.length > 0) {
    console.error("사용자에게 읽히는 속성이 번역기를 거치지 않았습니다:\n");
    for (const violation of violations) console.error(`  ${violation}`);
    console.error("\n각 값을 카탈로그 키로 옮기고 t(...)로 읽으세요.");
    process.exit(1);
  }
  console.log(`[check-localized-attributes] 위반 없음 — ${LOCALIZED_ATTRIBUTE_ROOTS.join(", ")}`);
}
