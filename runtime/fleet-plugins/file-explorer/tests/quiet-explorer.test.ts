import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "../client/format.js";
import { getT } from "../client/i18n/index.js";
import { countOverflowingChips, overflowingChipIndices, tabLineGeometry } from "../client/layout.js";
import { resolvePeekTop } from "../client/peek.js";
import { clampMenuLeft } from "../client/quiet-menu.js";
import {
  buildFlatRows,
  isEntryRow,
  resolveTreeNavigation,
  ROW_HEIGHT,
  STICKY_ANCESTOR_MAX,
  stickyAncestorStack,
  TREE_OPTIONS,
  TREE_PADDING_Y,
} from "../client/tree.js";
import { READ_PREVIEW_BYTE_CAP, sliceLeadingLines } from "../server/file-reader.js";
import { resolveReadMaxLines } from "../server/tree-services.js";
import type { FolderEntry, FolderListResult } from "../server/types.js";

const t = getT("en");

function entry(name: string, relativePath: string, kind: FolderEntry["kind"]): FolderEntry {
  return { name, relativePath, kind };
}

function folder(relativePath: string, entries: FolderEntry[]): FolderListResult {
  return { relativePath, parentRelativePath: null, entries };
}

/** runtime/ > plugins/ > explorer/ > 파일 12개, 그 뒤 runtime/other, 루트 파일. */
function deepRows() {
  const explorerFiles = Array.from({ length: 12 }, (_, index) => entry(`f${index}.ts`, `runtime/plugins/explorer/f${index}.ts`, "file"));
  const childResults = new Map<string, FolderListResult>([
    ["runtime", folder("runtime", [entry("plugins", "runtime/plugins", "dir"), entry("other", "runtime/other", "dir")])],
    ["runtime/plugins", folder("runtime/plugins", [entry("explorer", "runtime/plugins/explorer", "dir"), entry("z.ts", "runtime/plugins/z.ts", "file")])],
    ["runtime/plugins/explorer", folder("runtime/plugins/explorer", explorerFiles)],
    ["runtime/other", folder("runtime/other", [entry("o.ts", "runtime/other/o.ts", "file")])],
  ]);
  const root = [entry("runtime", "runtime", "dir"), entry("root.txt", "root.txt", "file")];
  const expanded = new Set(["runtime", "runtime/plugins", "runtime/plugins/explorer", "runtime/other"]);
  return buildFlatRows(root, 0, null, expanded, new Set(), childResults, "", false);
}

function scrollToRow(index: number, offset = 0): number {
  return TREE_PADDING_Y + index * ROW_HEIGHT + offset;
}

describe("stickyAncestorStack", () => {
  it("is empty at the top and while every ancestor is still at its own place", () => {
    const rows = deepRows();
    expect(stickyAncestorStack(rows, 0).rows).toEqual([]);
    expect(stickyAncestorStack(rows, TREE_PADDING_Y).rows).toEqual([]);
  });

  it("stacks the open ancestors shallow-first once they scroll past the top", () => {
    const rows = deepRows();
    // f4가 첫 행이 되도록 스크롤 — runtime · plugins · explorer 세 조상이 위에 남는다.
    const f4 = rows.findIndex((row) => isEntryRow(row) && row.entry.relativePath === "runtime/plugins/explorer/f4.ts");
    const stack = stickyAncestorStack(rows, scrollToRow(f4));
    expect(stack.rows.map((row) => row.entry.relativePath)).toEqual(["runtime", "runtime/plugins", "runtime/plugins/explorer"]);
    expect(stack.indices).toHaveLength(3);
    expect(stack.shift).toBe(0);
  });

  it("keeps at most the nearest ancestors when the chain is deeper than the cap", () => {
    const rows = deepRows();
    const f4 = rows.findIndex((row) => isEntryRow(row) && row.entry.relativePath === "runtime/plugins/explorer/f4.ts");
    const stack = stickyAncestorStack(rows, scrollToRow(f4), ROW_HEIGHT, TREE_PADDING_Y, 2);
    expect(stack.rows.map((row) => row.entry.name)).toEqual(["plugins", "explorer"]);
    expect(STICKY_ANCESTOR_MAX).toBe(3);
  });

  it("bases push-out on the rendered capped stack rather than hidden outer ancestors", () => {
    const rows = deepRows();
    const z = rows.findIndex((row) => isEntryRow(row) && row.entry.relativePath === "runtime/plugins/z.ts");
    // full chain은 3단이지만 화면에는 가까운 2단만 선다. 3단 경계로 계산하면 explorer가 10px 일찍 밀린다.
    const stack = stickyAncestorStack(rows, scrollToRow(z) - 3 * ROW_HEIGHT + 10, ROW_HEIGHT, TREE_PADDING_Y, 2);
    expect(stack.rows.map((row) => row.entry.name)).toEqual(["plugins", "explorer"]);
    expect(stack.shift).toBe(0);
  });

  it("pushes only the deepest row up as its subtree runs out", () => {
    const rows = deepRows();
    const z = rows.findIndex((row) => isEntryRow(row) && row.entry.relativePath === "runtime/plugins/z.ts");
    // explorer의 마지막 자식 f11이 스택 바로 아래 슬롯에 딱 걸리면 shift 0, 그보다 10px 더 내려가면 explorer만 10px 밀린다.
    const settled = stickyAncestorStack(rows, scrollToRow(z) - 3 * ROW_HEIGHT);
    expect(settled.rows.map((row) => row.entry.name)).toEqual(["runtime", "plugins", "explorer"]);
    expect(settled.shift).toBe(0);
    const pushed = stickyAncestorStack(rows, scrollToRow(z) - 3 * ROW_HEIGHT + 10);
    expect(pushed.rows.map((row) => row.entry.name)).toEqual(["runtime", "plugins", "explorer"]);
    expect(pushed.shift).toBe(10);
    // z.ts가 슬롯 2에 들어오면 explorer는 완전히 나갔고, 스택은 runtime · plugins로 줄어든다.
    const gone = stickyAncestorStack(rows, scrollToRow(z) - 2 * ROW_HEIGHT + 1);
    expect(gone.rows.map((row) => row.entry.name)).toEqual(["runtime", "plugins"]);
  });

  it("re-anchors on the sibling subtree after the previous one ends", () => {
    const rows = deepRows();
    const other = rows.findIndex((row) => isEntryRow(row) && row.entry.relativePath === "runtime/other");
    // other 행이 10px 지나 올라갔고 그 자식 o.ts가 다음 슬롯에 있다 — runtime · other가 서고, other는 곧 밀려 나간다.
    const stack = stickyAncestorStack(rows, scrollToRow(other, 10));
    expect(stack.rows.map((row) => row.entry.relativePath)).toEqual(["runtime", "runtime/other"]);
    expect(stack.shift).toBe(10);
  });
});

describe("empty folder row", () => {
  it("adds one muted row under an expanded folder that turned out empty, but not while filtering", () => {
    const root = [entry("empty", "empty", "dir"), entry("a.ts", "a.ts", "file")];
    const childResults = new Map<string, FolderListResult>([["empty", folder("empty", [])]]);
    const rows = buildFlatRows(root, 0, null, new Set(["empty"]), new Set(), childResults, "", false);
    expect(rows.map((row) => row.type)).toEqual(["entry", "empty", "entry"]);
    expect(rows[1]).toMatchObject({ type: "empty", depth: 1 });
    const filtered = buildFlatRows(root, 0, null, new Set(["empty"]), new Set(), childResults, "a", false);
    expect(filtered.map((row) => row.type)).toEqual(["entry"]);
  });
});

describe("Space peeks a file", () => {
  it("returns peek for files and still activates folders", () => {
    const rows = deepRows();
    const file = rows.findIndex((row) => isEntryRow(row) && row.entry.relativePath === "root.txt");
    expect(resolveTreeNavigation(rows, file, " ")).toEqual({ kind: "peek" });
    expect(resolveTreeNavigation(rows, 0, " ")).toEqual({ kind: "activate" });
    expect(resolveTreeNavigation(rows, file, "Enter")).toEqual({ kind: "activate" });
  });

  it("places the card below the row, flips above when the bottom is short, and clamps otherwise", () => {
    expect(resolvePeekTop(100, 128, 200, 600)).toBe(134);
    expect(resolvePeekTop(400, 428, 200, 500)).toBe(194);
    expect(resolvePeekTop(20, 48, 480, 500)).toBe(16);
  });
});

describe("tree options menu", () => {
  it("lists sort modes, then hidden files, then refresh — the keyboard order", () => {
    expect(TREE_OPTIONS.map((option) => (option.kind === "sort" ? `sort:${option.mode}` : option.kind))).toEqual([
      "sort:name",
      "sort:modified",
      "sort:size",
      "hidden",
      "refresh",
    ]);
  });
});

describe("tab overflow list", () => {
  it("names the hidden tabs by index and keeps the count in step", () => {
    const widths = [80, 80, 80, 80];
    expect(overflowingChipIndices(200, 0, widths, 4)).toEqual([2, 3]);
    expect(overflowingChipIndices(200, 100, widths, 4)).toEqual([0, 1, 3]);
    expect(countOverflowingChips(200, 0, widths, 4)).toBe(2);
    expect(overflowingChipIndices(0, 0, widths)).toEqual([]);
  });

  it("positions the active underline in strip coordinates, not only inside the active tab", () => {
    expect(tabLineGeometry(92, 3, 80, 8)).toEqual({ left: 103, width: 64 });
    expect(tabLineGeometry(0, 0, 10, 8)).toEqual({ left: 8, width: 0 });
  });

  it("keeps a popover inside its boundary", () => {
    expect(clampMenuLeft(300, 200, 400)).toBe(196);
    expect(clampMenuLeft(-10, 200, 400)).toBe(4);
    expect(clampMenuLeft(50, 200, 400)).toBe(50);
  });
});

describe("peek read slice", () => {
  const base = { relativePath: "a.ts", lang: "typescript", sizeBytes: 10, mtimeMs: 1 };

  it("keeps the leading lines, marks the cut, and reports the full count", () => {
    const sliced = sliceLeadingLines({ ...base, content: "a\nb\nc\nd\n" }, 2);
    expect(sliced.content).toBe("a\nb");
    expect(sliced.truncated).toBe(true);
    expect(sliced.lineCount).toBe(4);
  });

  it("does not report a prefix line count as a full-file total when the byte reader had already truncated", () => {
    const sliced = sliceLeadingLines({ ...base, content: "a\nb\nc\nd\n", truncated: true }, 2);
    expect(sliced.content).toBe("a\nb");
    expect(sliced.truncated).toBe(true);
    expect(sliced.lineCount).toBeUndefined();
  });

  it("keeps a line-limited peek byte-bounded even when a generated file has one giant line", () => {
    const giant = "한".repeat(READ_PREVIEW_BYTE_CAP);
    const sliced = sliceLeadingLines({ ...base, content: giant, sizeBytes: Buffer.byteLength(giant) }, 12);
    expect(Buffer.byteLength(sliced.content)).toBeLessThanOrEqual(READ_PREVIEW_BYTE_CAP);
    expect(sliced.truncated).toBe(true);
    expect(sliced.lineCount).toBe(1);
    expect(sliced.content.endsWith("�")).toBe(false);
  });

  it("leaves short files whole and untouched without a cap", () => {
    expect(sliceLeadingLines({ ...base, content: "a\nb\n" }, 5)).toMatchObject({ content: "a\nb\n", lineCount: 2 });
    expect(sliceLeadingLines({ ...base, content: "a\nb\n" }, 5).truncated).toBeUndefined();
    expect(sliceLeadingLines({ ...base, content: "a\nb\n" }, undefined)).toEqual({ ...base, content: "a\nb\n" });
  });

  it("accepts only positive integers and clamps to the cap", () => {
    expect(resolveReadMaxLines(undefined)).toBeUndefined();
    expect(resolveReadMaxLines(12)).toBe(12);
    expect(resolveReadMaxLines(10_000)).toBe(200);
    expect(resolveReadMaxLines(0)).toBeNull();
    expect(resolveReadMaxLines(1.5)).toBeNull();
    expect(resolveReadMaxLines("12")).toBeNull();
  });
});

describe("formatRelativeTime", () => {
  const now = 1_700_000_000_000;

  it("says just now under a minute and counts the largest unit beyond", () => {
    expect(formatRelativeTime(now - 20_000, now, t, "en")).toBe("just now");
    expect(formatRelativeTime(now - 3 * 60_000, now, t, "en")).toBe("3 minutes ago");
    expect(formatRelativeTime(now - 2 * 60 * 60_000, now, t, "en")).toBe("2 hours ago");
    expect(formatRelativeTime(now - 3 * 24 * 60 * 60_000, now, t, "en")).toBe("3 days ago");
    expect(formatRelativeTime(now - 3 * 60_000, now, getT("ko"), "ko")).toBe("3분 전");
  });

  it("passes the selected Console language into the peek timestamp formatter", () => {
    const source = fs.readFileSync(new URL("../client/peek.tsx", import.meta.url), "utf8");
    expect(source).toContain("formatRelativeTime(state.mtimeMs, Date.now(), t, language)");
  });
});
