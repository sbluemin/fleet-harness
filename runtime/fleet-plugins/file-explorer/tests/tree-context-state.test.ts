import fs from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { FolderListResult } from "../server/types.js";
import {
  buildFlatRows,
  EXPANDED_PERSIST_CAP,
  FOLDER_FETCH_CONCURRENCY,
  FILTER_SEARCH_DEBOUNCE_MS,
  isCurrentContextRequest,
  isEntryRow,
  PALETTE_SEARCH_LIMIT,
  planFolderExpand,
  readExpandedDirs,
  runWithConcurrency,
  saveExpandedDirs,
  selectPersistableExpanded,
  shouldClearFilterOnEscape,
  synthesizeFilterTree,
} from "../client/tree.js";

const ROOT_ENTRIES = [{ name: "src", relativePath: "src", kind: "dir" as const }];

describe("FileTree context request guard", () => {
  it("applies a list response only to the context that started it", () => {
    expect(isCurrentContextRequest("theater-a:src", "theater-a:src")).toBe(true);
    expect(isCurrentContextRequest("theater-a:src", "theater-b:src")).toBe(false);
    expect(isCurrentContextRequest("theater-a:src", "theater-a:docs")).toBe(false);
  });

  it("remounts before a new context can render the previous tree result", () => {
    const source = fs.readFileSync(new URL("../client/rail-panel.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/<FileTree\s+key=\{contextScope\}/);
  });

  it("filters with one debounced palette-search request instead of walking folders", () => {
    const source = fs.readFileSync(new URL("../client/tree.tsx", import.meta.url), "utf8");
    expect(source).toContain("/plugins/file-explorer/files/palette-search");
    expect(source).toContain("paletteSearchRequestBody(");
    expect(source).toContain("FILTER_SEARCH_DEBOUNCE_MS");
    expect(source).not.toContain("loadFilterDescendants");
    expect(source).not.toContain("FILTER_DIRECTORY_CAP");
    expect(FILTER_SEARCH_DEBOUNCE_MS).toBe(180);
    expect(PALETTE_SEARCH_LIMIT).toBe(200);
  });

  it("clears a non-empty filter on Escape and does not swallow Escape when empty", () => {
    expect(shouldClearFilterOnEscape("needle")).toBe(true);
    expect(shouldClearFilterOnEscape("")).toBe(false);
    const source = fs.readFileSync(new URL("../client/tree.tsx", import.meta.url), "utf8");
    expect(source).toContain("shouldClearFilterOnEscape(filterText)");
    expect(source).toContain("event.stopPropagation()");
  });

  it("builds the filtered tree from palette-search hits including unopened descendants", () => {
    const { rootEntries, childResults } = synthesizeFilterTree([
      { relativePath: "src/nested/match.ts", kind: "file" },
    ]);
    expect(buildFlatRows(rootEntries, 0, null, new Set(), new Set(), childResults, "", false, new Set(), new Set(), {}, "", { autoExpandAll: true }).filter(isEntryRow).map((row) => row.entry.relativePath)).toEqual([
      "src",
      "src/nested",
      "src/nested/match.ts",
    ]);
  });

  it("re-expands from cache and joins an in-flight list instead of starting another", () => {
    expect(planFolderExpand(true, true, false)).toEqual({ nextExpanded: false, fetch: "none" });
    expect(planFolderExpand(false, false, false)).toEqual({ nextExpanded: true, fetch: "foreground" });
    expect(planFolderExpand(false, true, false)).toEqual({ nextExpanded: true, fetch: "background" });
    expect(planFolderExpand(false, true, true)).toEqual({ nextExpanded: true, fetch: "none" });
    expect(planFolderExpand(false, false, true)).toEqual({ nextExpanded: true, fetch: "none" });
    const source = fs.readFileSync(new URL("../client/tree.tsx", import.meta.url), "utf8");
    expect(source).toContain("planFolderExpand(");
    expect(source).toContain("inFlightFoldersRef");
    expect(source).toContain("if (childResultsRef.current.has(relPath)) return;");
    expect(source).toContain("setExpandFailedDirs((prev) => new Set(prev).add(relPath))");
  });

  it("does not recursively render a cached cyclic folder result", () => {
    const cycleResult: FolderListResult = {
      relativePath: "src",
      parentRelativePath: "",
      entries: [
        { name: "loop", relativePath: "src/loop", kind: "dir" },
        { name: "match.ts", relativePath: "src/match.ts", kind: "file" },
      ],
    };
    const rows = buildFlatRows(ROOT_ENTRIES, 0, null, new Set(), new Set(), new Map([
      ["src", cycleResult],
      ["src/loop", cycleResult],
    ]), "match", false);

    expect(rows.filter(isEntryRow).map((row) => row.entry.relativePath)).toEqual(["src", "src/match.ts"]);
  });

  it("notifies onEntriesRefreshed after every successful files/list", () => {
    const source = fs.readFileSync(new URL("../client/tree.tsx", import.meta.url), "utf8");
    // 목록 결과를 통째로 넘긴다 — 뷰어가 truncated를 봐야 "행 없음"을 "파일 없음"으로 오독하지 않는다.
    expect(source).toContain("onEntriesRefreshed?: (result: FolderListResult) => void");
    expect(source).toContain("emitEntriesRefreshed(");
    expect(source).toMatch(/emitEntriesRefreshed\(r\)/);
    expect(source).toMatch(/emitEntriesRefreshed\(rootResult\)/);
  });
});

describe("expanded persist/restore cap parity", () => {
  const memory = new Map<string, string>();
  const localStorageStub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value); },
    removeItem: (key: string) => { memory.delete(key); },
  };

  afterEach(() => memory.clear());

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorageStub,
  });

  it("persists shallowest-first and uses one cap for save and restore", () => {
    const selected = selectPersistableExpanded([
      "src/deep/a",
      "z",
      "src",
      "src/deep",
    ], 3);
    expect(selected).toEqual(["src", "z", "src/deep"]);
    expect(EXPANDED_PERSIST_CAP).toBe(200);
    const source = fs.readFileSync(new URL("../client/tree.tsx", import.meta.url), "utf8");
    // 저장 상한과 복원 상한이 다시 갈라지면 "열린 척하는 빈 폴더"가 돌아온다.
    expect(source).not.toContain("EXPANDED_RESTORE_FETCH_CAP");
    expect(source).toContain("selectPersistableExpanded(expandedDirs)");
    // 복원은 저장된 목록 전체를 대상으로 하되 상한 있는 팬아웃으로 돈다.
    expect(source).toContain("runWithConcurrency(stored, FOLDER_FETCH_CONCURRENCY");
  });

  it("caps how many folder fetches run at once while restoring", async () => {
    const started: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const paths = Array.from({ length: 25 }, (_, index) => `dir-${index}`);
    await runWithConcurrency(paths, FOLDER_FETCH_CONCURRENCY, async (path) => {
      started.push(path);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });
    expect(started).toHaveLength(paths.length);
    expect(new Set(started).size).toBe(paths.length);
    expect(peak).toBeLessThanOrEqual(FOLDER_FETCH_CONCURRENCY);
  });

  it("round-trips only the shared cap through localStorage", () => {
    const key = "cap-parity";
    const dirs = new Set(Array.from({ length: EXPANDED_PERSIST_CAP + 40 }, (_, index) => `d${index}/nested`));
    saveExpandedDirs(key, dirs);
    const restored = readExpandedDirs(key);
    expect(restored).toHaveLength(EXPANDED_PERSIST_CAP);
    expect(restored).toEqual(selectPersistableExpanded(dirs));
  });
});

describe("stale-mark reach", () => {
  it("refreshes a changed directory that holds an open document even when it is collapsed", () => {
    const source = fs.readFileSync(new URL("../client/tree.tsx", import.meta.url), "utf8");
    // 검색으로 연 파일이나 부모를 접어 둔 파일도 낡음 표식이 서야 한다.
    expect(source).toContain("watchedDirectoriesRef.current.has(relDir)");
    expect(source).toContain("expandedDirsRef.current.has(relDir) || watchedByViewer");
    // 접힌 폴더의 목록은 트리 상태를 오염시키지 않는다.
    expect(source).toContain("if (expandedDirsRef.current.has(relDir)) setChildResults(");
  });

  it("passes the parents of open documents from the viewer to the tree", () => {
    const source = fs.readFileSync(new URL("../client/rail-panel.tsx", import.meta.url), "utf8");
    expect(source).toContain("watchedDocumentDirectories");
    expect(source).toContain("watchedDirectories={watchedDocumentDirectories}");
  });
});

describe("watch degraded and failed expand source contracts", () => {
  it("listens for the watcher state event", () => {
    const source = fs.readFileSync(new URL("../client/tree.tsx", import.meta.url), "utf8");
    expect(source).toContain('es.addEventListener("state"');
    // 저하 안내는 필드 아래 상태 한 줄로 선다 — 그때만 헤더에 새로고침 버튼이 되돌아온다.
    expect(source).toContain('key: "degraded"');
    expect(source).toContain("watchDegraded && (");
    expect(source).toContain("fileExplorer.tree.watchDegraded");
  });

  it("gives every treeitem an aria-level", () => {
    const source = fs.readFileSync(new URL("../client/tree.tsx", import.meta.url), "utf8");
    expect(source).toContain("aria-level={depth + 1}");
  });

  it("renders the inline retry row for a first expand failure", () => {
    const source = fs.readFileSync(new URL("../client/tree.tsx", import.meta.url), "utf8");
    expect(source).toContain('className="fexp-tree-error"');
    expect(source).toContain('className="fexp-tree-error-retry"');
    expect(source).toContain("fileExplorer.tree.expandFailed");
    expect(source).toContain("fileExplorer.tree.expandRetry");
  });
});

