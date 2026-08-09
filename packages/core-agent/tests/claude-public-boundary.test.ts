import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcDir = path.join(packageRoot, "src");
const distDir = path.join(packageRoot, "dist");
// 참조는 따옴표에 싸인 모듈 지정자다. 맨 부분 문자열로 세면 이 격리를 설명하는 주석까지 위반이 되고,
// 백틱을 넣으면 주석의 code span이 걸린다 — scripts/check-claude-agent-sdk-boundary.mjs와 같은 판정.
const VENDOR_REFERENCE = /["']@anthropic-ai\/claude-agent-sdk["']/;

function listFiles(dir: string, extension: string): string[] {
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(child, extension));
    else if (entry.name.endsWith(extension)) files.push(child);
  }
  return files;
}

describe("vendor SDK containment", () => {
  it("imports the vendor SDK from src/vendor-sdk.ts and nowhere else", () => {
    const offenders = listFiles(srcDir, ".ts")
      .filter((file) => path.basename(file) !== "vendor-sdk.ts")
      .filter((file) => VENDOR_REFERENCE.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(packageRoot, file));
    expect(offenders).toEqual([]);
  });

  it("emits no vendor SDK reference into the built declarations", () => {
    // 이 검사는 build 산출물이 있을 때만 의미가 있다. dist가 없으면 조용히 통과시키지 않고
    // 건너뛴 사실을 남긴다 — 통과처럼 보이는 미실행이 이 패키지에서 가장 비싼 침묵이다.
    const declarations = listFiles(distDir, ".d.ts");
    if (declarations.length === 0) {
      expect.soft(declarations.length, "run `pnpm build` before trusting this assertion").toBeGreaterThan(0);
      return;
    }
    const offenders = declarations
      .filter((file) => VENDOR_REFERENCE.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(packageRoot, file));
    // vendor-sdk.d.ts까지 포함해 전부 깨끗해야 한다. 형제 선언에 vendor 타입이 남으면
    // 소비자 해석 그래프가 그 모듈에 닿는 순간 vendor 의존이 되살아난다.
    expect(offenders).toEqual([]);
  });
});
