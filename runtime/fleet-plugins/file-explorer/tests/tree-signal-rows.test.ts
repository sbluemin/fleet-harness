import { describe, expect, it, vi } from "vitest";

import {
  buildFlatRows,
  FILTER_DIRECTORY_CAP,
  isEntryRow,
  loadFilterDescendants,
  resolveTreeNavigation,
  type PluginFilesClient,
  type TreeRow,
} from "../client/tree.js";
import type { FolderEntry, FolderListResult } from "../server/types.js";

function entry(name: string, relativePath: string, kind: FolderEntry["kind"]): FolderEntry {
  return { name, relativePath, kind };
}

function folderResult(relativePath: string, entries: FolderEntry[], extra: Partial<FolderListResult> = {}): FolderListResult {
  return { relativePath, parentRelativePath: null, entries, ...extra };
}

function rowKinds(rows: readonly TreeRow[]): string[] {
  return rows.map((row) => row.type);
}

describe("buildFlatRows signal rows", () => {
  it("appends a cap row after the children of a truncated folder", () => {
    const root = [entry("many", "many", "dir"), entry("readme.md", "readme.md", "file")];
    const many = folderResult("many", [entry("a.txt", "many/a.txt", "file")], { truncated: true, cap: 500 });
    const rows = buildFlatRows(root, 0, null, new Set(["many"]), new Set(), new Map([["many", many]]), "", false);

    expect(rowKinds(rows)).toEqual(["entry", "entry", "cap", "entry"]);
    const cap = rows[2];
    expect(cap).toMatchObject({ type: "cap", depth: 1, cap: 500 });
  });

  it("appends a root-level cap row when the root listing is truncated", () => {
    const root = [entry("a.txt", "a.txt", "file")];
    const rows = buildFlatRows(root, 0, null, new Set(), new Set(), new Map(), "", false, new Set(), new Set(), { truncatedCap: 500 }, "");

    expect(rowKinds(rows)).toEqual(["entry", "cap"]);
    expect(rows[1]).toMatchObject({ type: "cap", depth: 0 });
  });

  it("places hidden VCS markers in name order among directories when hidden files are shown", () => {
    const root = [
      entry("assets", "assets", "dir"),
      entry("src", "src", "dir"),
      entry(".env", ".env", "file"),
    ];
    const rows = buildFlatRows(root, 0, null, new Set(), new Set(), new Map(), "", true, new Set(), new Set(), { hiddenVcs: [".git"] }, "");

    expect(rows.map((row) => (row.type === "vcs" ? row.name : row.type === "entry" ? row.entry.name : row.type))).toEqual([
      ".git",
      "assets",
      "src",
      ".env",
    ]);
    const vcsRow = rows[0];
    expect(vcsRow).toMatchObject({ type: "vcs", depth: 0 });
  });

  it("omits VCS markers when hidden files are off or a filter is active", () => {
    const root = [entry("src", "src", "dir")];
    const meta = { hiddenVcs: [".git"] } as const;

    const hiddenOff = buildFlatRows(root, 0, null, new Set(), new Set(), new Map(), "", false, new Set(), new Set(), meta, "");
    expect(rowKinds(hiddenOff)).toEqual(["entry"]);

    const filtering = buildFlatRows(root, 0, null, new Set(), new Set(), new Map(), "src", true, new Set(), new Set(), meta, "");
    expect(rowKinds(filtering)).toEqual(["entry"]);
  });

  it("keeps a truncated folder visible in filter mode even when no listed child matches", () => {
    // 잘린 목록(500건 뒤의 비표시 항목)에 매치가 숨어 있을 수 있다 — 폴더를 걸러낼 근거가 없다.
    const root = [entry("many", "many", "dir")];
    const many = folderResult("many", [entry("other.txt", "many/other.txt", "file")], { truncated: true, cap: 500 });
    const rows = buildFlatRows(root, 0, null, new Set(), new Set(), new Map([["many", many]]), "zzz", false);

    expect(rowKinds(rows)).toEqual(["entry", "cap"]);
  });

  it("propagates nested truncation as a potential ancestor match in filter mode", () => {
    // parent/child 구조에서 child가 잘렸다면 parent를 걸러낼 근거가 없다 — 캡 행까지 살아야 한다.
    const root = [entry("parent", "parent", "dir")];
    const results = new Map<string, FolderListResult>([
      ["parent", folderResult("parent", [entry("child", "parent/child", "dir")])],
      ["parent/child", folderResult("parent/child", [entry("other.txt", "parent/child/other.txt", "file")], { truncated: true, cap: 500 })],
    ]);
    const rows = buildFlatRows(root, 0, null, new Set(), new Set(), results, "zzz", false);

    expect(rowKinds(rows)).toEqual(["entry", "entry", "cap"]);
  });

  it("keeps cap rows visible while filtering", () => {
    const root = [entry("many", "many", "dir")];
    const many = folderResult("many", [entry("match.txt", "many/match.txt", "file")], { truncated: true, cap: 500 });
    const rows = buildFlatRows(root, 0, null, new Set(), new Set(), new Map([["many", many]]), "match", false);

    expect(rowKinds(rows)).toEqual(["entry", "entry", "cap"]);
  });
});

describe("resolveTreeNavigation over marker rows", () => {
  const root = [entry("src", "src", "dir"), entry("z.txt", "z.txt", "file")];
  const childResults = new Map<string, FolderListResult>([
    ["src", folderResult("src", [entry("a.ts", "src/a.ts", "file")], { truncated: true, cap: 500, hiddenVcsInternals: [".git"] })],
  ]);
  // showHidden=true: src 아래에 vcs 행(.git) + 자식 + cap 행이 놓인다.
  const rows = buildFlatRows(root, 0, null, new Set(["src"]), new Set(), childResults, "", true);

  it("lays out vcs, entry, and cap rows under the expanded folder", () => {
    expect(rows.map((row) => (row.type === "entry" ? row.entry.relativePath : row.type))).toEqual([
      "src",
      "vcs",
      "src/a.ts",
      "cap",
      "z.txt",
    ]);
  });

  it("moves ArrowRight into the first entry child, skipping the vcs marker", () => {
    expect(resolveTreeNavigation(rows, 0, "ArrowRight")).toEqual({ kind: "focus", index: 2 });
  });

  it("skips marker rows on ArrowDown and End", () => {
    expect(resolveTreeNavigation(rows, 2, "ArrowDown")).toEqual({ kind: "focus", index: 4 });
    expect(resolveTreeNavigation(rows, 0, "End")).toEqual({ kind: "focus", index: 4 });
    expect(resolveTreeNavigation(rows, 4, "Home")).toEqual({ kind: "focus", index: 0 });
  });

  it("finds the parent entry across marker rows on ArrowLeft", () => {
    expect(resolveTreeNavigation(rows, 2, "ArrowLeft")).toEqual({ kind: "focus", index: 0 });
  });

  it("never activates a marker row", () => {
    // 표식 행은 포커스를 받지 않으므로 키 이벤트가 오지 않는다 — 방어적으로 none을 반환해야 한다.
    expect(resolveTreeNavigation(rows, 1, "Enter")).toEqual({ kind: "none" });
    expect(resolveTreeNavigation(rows, 3, "ArrowDown")).toEqual({ kind: "none" });
  });
});

describe("loadFilterDescendants stats", () => {
  it("reports walked counts through onProgress and returns them", async () => {
    const progress: number[] = [];
    const files: PluginFilesClient = {
      listFolder: vi.fn(async (relativePath?: string) =>
        relativePath === "src"
          ? folderResult("src", [entry("nested", "src/nested", "dir")])
          : folderResult("src/nested", [])),
    };

    const stats = await loadFilterDescendants({
      entries: [entry("src", "src", "dir")],
      cachedResults: new Map(),
      files,
      showHidden: false,
      isCurrent: () => true,
      onFolderResult: vi.fn(),
      onProgress: (walked) => progress.push(walked),
    });

    expect(stats).toEqual({ walked: 2, capped: false });
    expect(progress).toEqual([1, 2]);
  });

  it("flags capped when the directory cap stops the walk", async () => {
    const listFolder = vi.fn(async (relativePath?: string) => {
      const index = Number(relativePath?.split("-").at(-1) ?? "0");
      return folderResult(relativePath ?? "", [entry(`dir-${index + 1}`, `dir-${index + 1}`, "dir")]);
    });
    const files: PluginFilesClient = { listFolder };

    const stats = await loadFilterDescendants({
      entries: [entry("dir-0", "dir-0", "dir")],
      cachedResults: new Map(),
      files,
      showHidden: false,
      isCurrent: () => true,
      onFolderResult: vi.fn(),
    });

    expect(stats.capped).toBe(true);
    expect(stats.walked).toBe(FILTER_DIRECTORY_CAP);
  });
});
