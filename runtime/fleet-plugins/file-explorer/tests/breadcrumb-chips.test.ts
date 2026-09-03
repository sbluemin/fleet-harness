import { describe, expect, it } from "vitest";

import { breadcrumbSegments } from "../client/format.js";
import { resolveSiblingListState } from "../client/document-pane.js";
import { chipDirHints } from "../client/layout.js";

describe("breadcrumbSegments", () => {
  it("조각마다 자기까지의 상대 경로를 안다", () => {
    expect(breadcrumbSegments("src/utils/format.ts")).toEqual([
      { name: "src", path: "src", isLeaf: false },
      { name: "utils", path: "src/utils", isLeaf: false },
      { name: "format.ts", path: "src/utils/format.ts", isLeaf: true },
    ]);
  });

  it("루트 파일은 잎 조각 하나뿐이다", () => {
    expect(breadcrumbSegments("README.md")).toEqual([
      { name: "README.md", path: "README.md", isLeaf: true },
    ]);
  });

  it("빈 조각(중복 슬래시)은 만들지 않는다", () => {
    expect(breadcrumbSegments("a//b.ts").map((segment) => segment.name)).toEqual(["a", "b.ts"]);
  });
});

describe("chipDirHints", () => {
  it("동명 파일이 없으면 힌트도 없다", () => {
    const hints = chipDirHints([
      { relativePath: "src/tree.ts", name: "tree.ts" },
      { relativePath: "src/viewer.ts", name: "viewer.ts" },
    ]);
    expect(hints.size).toBe(0);
  });

  it("동명 파일이 둘 이상이면 그 칩들에만 부모 폴더 힌트가 붙는다", () => {
    const hints = chipDirHints([
      { relativePath: "client/tree/index.ts", name: "index.ts" },
      { relativePath: "client/viewer/index.ts", name: "index.ts" },
      { relativePath: "README.md", name: "README.md" },
    ]);
    expect(hints.get("client/tree/index.ts")).toBe("tree/");
    expect(hints.get("client/viewer/index.ts")).toBe("viewer/");
    expect(hints.has("README.md")).toBe(false);
  });

  it("부모 폴더명까지 같으면 갈릴 때까지 서픽스를 늘린다", () => {
    const hints = chipDirHints([
      { relativePath: "src/components/index.ts", name: "index.ts" },
      { relativePath: "tests/components/index.ts", name: "index.ts" },
    ]);
    expect(hints.get("src/components/index.ts")).toBe("src/components/");
    expect(hints.get("tests/components/index.ts")).toBe("tests/components/");
  });

  it("깊이가 다른 경로도 최단 서픽스에서 갈린다", () => {
    const hints = chipDirHints([
      { relativePath: "a/b/x.ts", name: "x.ts" },
      { relativePath: "b/x.ts", name: "x.ts" },
    ]);
    expect(hints.get("a/b/x.ts")).toBe("a/b/");
    expect(hints.get("b/x.ts")).toBe("b/");
  });

  it("루트에 있는 동명 파일의 힌트는 루트 표식이다", () => {
    const hints = chipDirHints([
      { relativePath: "index.ts", name: "index.ts" },
      { relativePath: "src/index.ts", name: "index.ts" },
    ]);
    expect(hints.get("index.ts")).toBe("/");
    expect(hints.get("src/index.ts")).toBe("src/");
  });
});


describe("breadcrumb sibling list honesty", () => {
  it("keeps failed, empty, partial, and complete listings distinct", () => {
    const file = { name: "a.ts", relativePath: "dir/a.ts", kind: "file" } as const;
    const dir = { name: "nested", relativePath: "dir/nested", kind: "dir" } as const;
    expect(resolveSiblingListState("pending")).toEqual({ kind: "loading" });
    expect(resolveSiblingListState("failed")).toEqual({ kind: "error" });
    expect(resolveSiblingListState({ relativePath: "dir", parentRelativePath: "", entries: [] })).toEqual({ kind: "empty" });
    expect(resolveSiblingListState({ relativePath: "dir", parentRelativePath: "", entries: [file, dir], truncated: true, cap: 500 })).toEqual({
      kind: "ready",
      entries: [file],
      partial: true,
    });
    expect(resolveSiblingListState({ relativePath: "dir", parentRelativePath: "", entries: [file] })).toEqual({
      kind: "ready",
      entries: [file],
      partial: false,
    });
  });
});
