import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { appendHistoryPage, calculateHistoryWindow, CommitRow, findDetachedCheckout, getHistoryWindowRows, type HistoryLoadGeneration, type HistoryOkState } from "../client/history-panel.js";
import { ROW_HEIGHT } from "../client/graph-gutter.js";
import { layoutGraph } from "../client/graph-layout.js";
import type { LogCommitEntry, WorktreeCheckout } from "../server/types.js";

// ─── constants ───────────────────────────────────────────────────────────────

const COMMIT: LogCommitEntry = {
  shortHash: "abc1234",
  fullHash: "abc1234def5678abc1234def5678abc1234def56",
  subject: "test commit",
  authorName: "Author",
  relTime: "1 hour ago",
  authorAt: 1_700_000_000,
  refs: [],
  parents: [],
  onHead: true,
};

type ElementProps = Record<string, unknown> & {
  readonly children?: ReactNode;
  readonly className?: string;
  readonly title?: string;
};

function isElement(node: ReactNode): node is ReactElement<ElementProps> {
  return typeof node === "object" && node !== null && "type" in node && "props" in node;
}

// ─── functions ───────────────────────────────────────────────────────────────

describe("History checkout markers", () => {
  it("detached checkout은 branch badge 없이 SHA로 찾는다", () => {
    const checkouts: WorktreeCheckout[] = [
      { sha: COMMIT.fullHash, branch: null, isCurrent: true },
      { sha: "other", branch: "topic", isCurrent: false },
    ];

    expect(findDetachedCheckout(COMMIT, checkouts)).toEqual(checkouts[0]);
  });
});

describe("CommitRow", () => {
  it("renders the complete subject as the subject span title", () => {
    const row = CommitRow({
      entry: COMMIT,
      checkouts: [],
      selected: false,
      graphNode: layoutGraph([COMMIT]).nodes[0]!,
      laneCount: 1,
      onSelect: vi.fn(),
    });
    const children = row.props.children as readonly ReactNode[];
    const subject = children.find((child) => isElement(child) && child.type === "span" && child.props.className === "history-commit-subject");

    expect(isElement(subject) && subject.props.title).toBe(COMMIT.subject);
    expect(isElement(subject) && subject.props.children).toBe(COMMIT.subject);
  });
});

describe("History window rendering", () => {
  it("renders only the viewport plus eight rows of overscan on each side", () => {
    const window = calculateHistoryWindow(80, 20 * ROW_HEIGHT, 2 * ROW_HEIGHT);

    expect(window).toEqual({
      startIndex: 12,
      endIndex: 30,
      topSpacerHeight: 12 * ROW_HEIGHT,
      bottomSpacerHeight: 50 * ROW_HEIGHT,
    });
  });

  it("clamps a deep 600-row scroll when a filter leaves only 10 rows", () => {
    const window = calculateHistoryWindow(10, 500 * ROW_HEIGHT, 240);

    expect(window).toEqual({
      startIndex: 0,
      endIndex: 10,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
    });
  });

  it.each([
    [10, 14_000, 240],
    [0, 14_000, 240],
    [10, -100, 240],
    [10, Number.POSITIVE_INFINITY, 240],
    [-10, 100, -20],
  ])("keeps window indexes ordered and inside the item count for count=%s scroll=%s viewport=%s", (itemCount, scrollTop, viewportHeight) => {
    const window = calculateHistoryWindow(itemCount, scrollTop, viewportHeight);
    const safeItemCount = Math.max(0, itemCount);

    expect(window.startIndex).toBeGreaterThanOrEqual(0);
    expect(window.startIndex).toBeLessThanOrEqual(window.endIndex);
    expect(window.endIndex).toBeLessThanOrEqual(safeItemCount);
  });

  it("keeps filtered rows paired with graph nodes from their original accumulated indexes", () => {
    const commits = Array.from({ length: 80 }, (_, index): LogCommitEntry => ({
      ...COMMIT,
      shortHash: `short-${index}`,
      fullHash: `full-${index}`,
      subject: `commit ${index}`,
      parents: index < 79 ? [`full-${index + 1}`] : [],
    }));
    const visible = commits.filter((_entry, index) => index % 2 === 0);
    const layout = layoutGraph(commits);
    const window = calculateHistoryWindow(visible.length, 20 * ROW_HEIGHT, 2 * ROW_HEIGHT);
    const commitIndexes = new Map(commits.map((entry, index) => [entry.fullHash, index]));
    const rows = getHistoryWindowRows(commitIndexes, visible, layout, window);

    expect(rows).toHaveLength(18);
    expect(rows[0]).toMatchObject({ entry: commits[24], visibleIndex: 12, commitIndex: 24 });
    expect(rows[0]?.graphNode).toBe(layout.nodes[24]);
    expect(rows.at(-1)).toMatchObject({ entry: commits[58], visibleIndex: 29, commitIndex: 58 });
    expect(rows.at(-1)?.graphNode).toBe(layout.nodes[58]);
  });
});

describe("History page accumulation", () => {
  const generationA: HistoryLoadGeneration = { theaterId: "theater", repoRel: "", refFilter: "refs/heads/a", refreshToken: 0 };
  const state: HistoryOkState = { kind: "ok", commits: [COMMIT], checkouts: [], hasMore: true, truncated: false };
  const nextCommit: LogCommitEntry = { ...COMMIT, shortHash: "def5678", fullHash: "def5678fedcba9876543210fedcba9876543210f", subject: "older commit" };

  it("rejects a delayed page response after the ref generation changes", () => {
    const generationB: HistoryLoadGeneration = { ...generationA, refFilter: "refs/heads/b" };
    const result = appendHistoryPage(
      state,
      { commits: [nextCommit], checkouts: [], hasMore: false },
      generationA,
      generationB,
    );

    expect(result).toBeNull();
    expect(state.commits).toEqual([COMMIT]);
  });

  it("deduplicates full hashes while preserving new page order", () => {
    const result = appendHistoryPage(
      state,
      { commits: [COMMIT, nextCommit], checkouts: [], hasMore: false },
      generationA,
      generationA,
    );

    expect(result?.commits).toEqual([COMMIT, nextCommit]);
    expect(result?.hasMore).toBe(false);
  });
});
