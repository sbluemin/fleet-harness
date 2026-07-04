import { describe, expect, it } from "vitest";

import { parseHunk } from "../client/hunk-parse.js";

const SAMPLE_UNIFIED = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index abc1234..def5678 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,4 +1,5 @@ function foo() {",
  " import { bar } from './bar';",
  "-const x = 1;",
  "+const x = 2;",
  "+const y = 3;",
  " export default foo;",
].join("\n");

const MULTI_HUNK = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,2 +1,2 @@",
  "-line1",
  "+LINE1",
  " line2",
  "@@ -10,2 +10,2 @@",
  "-line10",
  "+LINE10",
  " line11",
].join("\n");

const UNTRACKED_NO_INDEX = [
  "diff --git a/dev/null b/new.ts",
  "new file mode 100644",
  "index 0000000..1234567",
  "--- /dev/null",
  "+++ b/new.ts",
  "@@ -0,0 +1,3 @@",
  "+export const a = 1;",
  "+export const b = 2;",
  "+export const c = 3;",
].join("\n");

describe("parseHunk", () => {
  it("① 파일 헤더(diff --git, index, ---, +++) 라인은 드롭한다", () => {
    const lines = parseHunk(SAMPLE_UNIFIED);
    const hasHeader = lines.some((l) =>
      l.text.startsWith("diff --git") ||
      l.text.startsWith("index ") ||
      l.text.startsWith("--- ") ||
      l.text.startsWith("+++ ")
    );
    expect(hasHeader).toBe(false);
  });

  it("② @@ 헤더를 hunk-label 1줄로 변환한다", () => {
    const lines = parseHunk(SAMPLE_UNIFIED);
    const labels = lines.filter((l) => l.kind === "hunk-label");
    expect(labels).toHaveLength(1);
    expect(labels[0]?.text).toMatch(/^@@ -1 \+1 @@/);
  });

  it("③ old/new 라인번호가 올바르게 부여된다(멀티 hunk 포함)", () => {
    const lines = parseHunk(MULTI_HUNK);
    const del1 = lines.find((l) => l.kind === "del" && l.text === "-line1");
    const add1 = lines.find((l) => l.kind === "add" && l.text === "+LINE1");
    const del10 = lines.find((l) => l.kind === "del" && l.text === "-line10");
    const add10 = lines.find((l) => l.kind === "add" && l.text === "+LINE10");

    expect(del1?.oldLine).toBe(1);
    expect(add1?.newLine).toBe(1);
    expect(del10?.oldLine).toBe(10);
    expect(add10?.newLine).toBe(10);
  });

  it("④ add/del/ctx가 정확히 분류된다", () => {
    const lines = parseHunk(SAMPLE_UNIFIED).filter((l) => l.kind !== "hunk-label");
    const kinds = lines.map((l) => l.kind);
    expect(kinds).toEqual(["ctx", "del", "add", "add", "ctx"]);
  });

  it("⑤ untracked(--no-index) 출력도 동일 파서로 처리된다", () => {
    const lines = parseHunk(UNTRACKED_NO_INDEX);
    const adds = lines.filter((l) => l.kind === "add");
    expect(adds).toHaveLength(3);
    expect(adds[0]?.newLine).toBe(1);
    expect(adds[2]?.newLine).toBe(3);
  });

  it("⑥ 빈 입력에서 크래시 없이 빈 배열을 반환한다", () => {
    expect(() => parseHunk("")).not.toThrow();
    expect(parseHunk("")).toEqual([]);
  });

  it("⑦ Binary 라인을 포함한 입력에서 크래시 없이 처리된다", () => {
    const binary = [
      "diff --git a/img.png b/img.png",
      "index abc..def 100644",
      "Binary files a/img.png and b/img.png differ",
    ].join("\n");
    expect(() => parseHunk(binary)).not.toThrow();
  });

  it("⑧ '\\ No newline at end of file' 어노테이션은 결과에서 제외되고 라인번호를 소모하지 않는다", () => {
    const noNewline = [
      "diff --git a/a.txt b/a.txt",
      "index 111..222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,2 @@",
      " first",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
    ].join("\n");
    const lines = parseHunk(noNewline);
    expect(lines.some((l) => l.text.includes("No newline"))).toBe(false);
    const add = lines.find((l) => l.kind === "add");
    const del = lines.find((l) => l.kind === "del");
    // 어노테이션이 라인번호를 소모하지 않으므로 add/del 모두 2행을 가리킨다
    expect(del?.oldLine).toBe(2);
    expect(add?.newLine).toBe(2);
  });
});
