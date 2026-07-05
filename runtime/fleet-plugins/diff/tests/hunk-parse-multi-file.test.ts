import { describe, expect, it } from "vitest";

import { parseHunk } from "../client/hunk-parse.js";

const MULTI_FILE_PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " ctx1",
  "-old1",
  "+new1",
  " ctx2",
  "diff --git a/src/b.ts b/src/b.ts",
  "index 333..444 100644",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -10,2 +10,2 @@",
  " line10",
  "-oldB",
  "+newB",
].join("\n");

const RENAMED_FILE_PATCH = [
  "diff --git a/old.ts b/new.ts",
  "similarity index 90%",
  "rename from old.ts",
  "rename to new.ts",
  "index aaa..bbb 100644",
  "--- a/old.ts",
  "+++ b/new.ts",
  "@@ -1,2 +1,2 @@",
  " ctx",
  "-old",
  "+new",
].join("\n");

const BINARY_AND_TEXT_PATCH = [
  "diff --git a/img.png b/img.png",
  "index abc..def 100644",
  "Binary files a/img.png and b/img.png differ",
  "diff --git a/src/code.ts b/src/code.ts",
  "index 111..222 100644",
  "--- a/src/code.ts",
  "+++ b/src/code.ts",
  "@@ -1,2 +1,2 @@",
  " line1",
  "-old",
  "+new",
].join("\n");

describe("parseHunk — 다중 파일 패치", () => {
  it("① diff --git 경계마다 file-label 라인을 삽입한다", () => {
    const lines = parseHunk(MULTI_FILE_PATCH);
    const fileLabels = lines.filter((l) => l.kind === "file-label");
    expect(fileLabels).toHaveLength(2);
    expect(fileLabels[0]?.text).toBe("src/a.ts");
    expect(fileLabels[1]?.text).toBe("src/b.ts");
  });

  it("② file-label 이후 헤더(index, ---, +++)는 드롭된다", () => {
    const lines = parseHunk(MULTI_FILE_PATCH);
    const hasHeader = lines.some((l) =>
      l.text.startsWith("index ") ||
      l.text.startsWith("--- ") ||
      l.text.startsWith("+++ ")
    );
    expect(hasHeader).toBe(false);
  });

  it("③ 파일 경계에서 라인번호가 리셋된다", () => {
    const lines = parseHunk(MULTI_FILE_PATCH);
    const delA = lines.find((l) => l.kind === "del" && l.text === "-old1");
    const delB = lines.find((l) => l.kind === "del" && l.text === "-oldB");
    expect(delA?.oldLine).toBe(2);
    expect(delB?.oldLine).toBe(11);
  });

  it("④ 파일 내부 add/del/ctx 분류가 각각 올바르다", () => {
    const lines = parseHunk(MULTI_FILE_PATCH);
    const adds = lines.filter((l) => l.kind === "add");
    const dels = lines.filter((l) => l.kind === "del");
    const ctxs = lines.filter((l) => l.kind === "ctx");
    expect(adds).toHaveLength(2);
    expect(dels).toHaveLength(2);
    expect(ctxs).toHaveLength(3);
  });

  it("⑤ 리네임 파일에서 oldPath 필드가 채워진다", () => {
    const lines = parseHunk(RENAMED_FILE_PATCH);
    const label = lines.find((l) => l.kind === "file-label");
    expect(label?.text).toBe("new.ts");
    expect(label?.oldPath).toBe("old.ts");
  });

  it("⑥ 동일 경로 파일은 oldPath가 undefined다", () => {
    const lines = parseHunk(MULTI_FILE_PATCH);
    const label = lines.find((l) => l.kind === "file-label");
    expect(label?.oldPath).toBeUndefined();
  });

  it("⑦ 바이너리와 텍스트 파일이 혼합된 패치를 처리한다", () => {
    const lines = parseHunk(BINARY_AND_TEXT_PATCH);
    const fileLabels = lines.filter((l) => l.kind === "file-label");
    expect(fileLabels).toHaveLength(2);
    expect(fileLabels[0]?.text).toBe("img.png");
    expect(fileLabels[1]?.text).toBe("src/code.ts");
    // 바이너리 안내는 ctx로 보존
    const ctxLines = lines.filter((l) => l.kind === "ctx");
    expect(ctxLines.some((l) => l.text.includes("Binary files"))).toBe(true);
  });

  it("⑧ 단일 파일 diff에서도 file-label 1개가 삽입된다", () => {
    const single = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index abc..def 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,2 +1,2 @@",
      " ctx",
      "-old",
      "+new",
    ].join("\n");
    const lines = parseHunk(single);
    const fileLabels = lines.filter((l) => l.kind === "file-label");
    expect(fileLabels).toHaveLength(1);
    expect(fileLabels[0]?.text).toBe("src/foo.ts");
  });
});
