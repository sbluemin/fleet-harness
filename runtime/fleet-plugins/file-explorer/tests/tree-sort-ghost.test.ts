import { describe, expect, it } from "vitest";

import type { FolderEntry, FolderListResult } from "../server/types.js";
import { buildFlatRows, isEntryRow, nextSortMode, sortEntries } from "../client/tree.js";
import { countLines, formatByteSize } from "../client/format.js";

const dir = (name: string, mtimeMs?: number): FolderEntry => ({ name, relativePath: name, kind: "dir", mtimeMs });
const file = (name: string, sizeBytes?: number, mtimeMs?: number): FolderEntry => ({ name, relativePath: name, kind: "file", sizeBytes, mtimeMs });

describe("sortEntries", () => {
  const entries = [dir("docs", 10), dir("src", 30), file("a.ts", 5, 20), file("b.ts", 50, 40), file("c.ts", undefined, undefined)];

  it("name 모드는 서버 순서를 그대로 둔다", () => {
    expect(sortEntries(entries, "name")).toBe(entries);
  });

  it("modified 모드는 디렉터리 우선 + 최신 우선이며 메타 없는 항목은 꼬리로 보낸다", () => {
    const sorted = sortEntries(entries, "modified").map((entry) => entry.name);
    expect(sorted).toEqual(["src", "docs", "b.ts", "a.ts", "c.ts"]);
  });

  it("size 모드는 파일만 큰 순으로 정렬하고 디렉터리는 이름순을 유지한다", () => {
    const sorted = sortEntries(entries, "size").map((entry) => entry.name);
    expect(sorted).toEqual(["docs", "src", "b.ts", "a.ts", "c.ts"]);
  });

  it("정렬 순환은 name→modified→size→name", () => {
    expect(nextSortMode("name")).toBe("modified");
    expect(nextSortMode("modified")).toBe("size");
    expect(nextSortMode("size")).toBe("name");
  });
});

describe("삭제 고스트 행", () => {
  const rootEntries: readonly FolderEntry[] = [
    { name: "src", relativePath: "src", kind: "dir" },
    { name: "keep.ts", relativePath: "keep.ts", kind: "file" },
  ];
  const srcResult: FolderListResult = {
    relativePath: "src",
    parentRelativePath: null,
    entries: [{ name: "live.ts", relativePath: "src/live.ts", kind: "file" }],
  };

  it("루트와 펼쳐진 폴더 수준에 이름순으로 합성된다", () => {
    const rows = buildFlatRows(
      rootEntries,
      0,
      null,
      new Set(["src"]),
      new Set(),
      new Map([["src", srcResult]]),
      "",
      false,
      new Set(),
      new Set(),
      {},
      "",
      {
        deletedByDir: new Map([
          ["", ["zz-gone.md", "aa-gone.md"]],
          ["src", ["gone.ts"]],
        ]),
      },
    );
    const shaped = rows.map((row) => row.type === "ghost" ? `ghost:${row.relativePath}` : isEntryRow(row) ? row.entry.relativePath : row.type);
    expect(shaped).toEqual([
      "src",
      "ghost:src/gone.ts",
      "src/live.ts",
      "ghost:aa-gone.md",
      "keep.ts",
      "ghost:zz-gone.md",
    ]);
  });

  it("필터 중에는 고스트를 내지 않고, 숨김 규칙을 따른다", () => {
    const filtered = buildFlatRows(
      rootEntries, 0, null, new Set(), new Set(), new Map(), "keep", false, new Set(), new Set(), {}, "",
      { deletedByDir: new Map([["", ["keep-gone.ts"]]]) },
    );
    expect(filtered.some((row) => row.type === "ghost")).toBe(false);

    const hiddenGhost = buildFlatRows(
      rootEntries, 0, null, new Set(), new Set(), new Map(), "", false, new Set(), new Set(), {}, "",
      { deletedByDir: new Map([["", [".secret-gone"]]]) },
    );
    expect(hiddenGhost.some((row) => row.type === "ghost")).toBe(false);
  });
});

describe("뷰어 메타 포맷", () => {
  it("크기는 1024 기수로 표기한다", () => {
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(2048)).toBe("2.0 KB");
    expect(formatByteSize(1024 * 1024 * 3)).toBe("3.0 MB");
    expect(formatByteSize(-1)).toBe("");
  });

  it("줄 수는 마지막 개행 뒤 빈 꼬리를 세지 않는다", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\nb")).toBe(2);
  });
});
