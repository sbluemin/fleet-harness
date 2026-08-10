import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { appendHistoryPage, calculateHistoryWindow, chooseComparePair, CommitRow, findDetachedCheckout, getHistoryWindowRows, type HistoryLoadGeneration, type HistoryOkState } from "../client/history-panel.js";
import { ROW_HEIGHT } from "../client/graph.js";
import { layoutGraph } from "../client/graph.js";
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
  hasBody: false,
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
      onSelect: vi.fn(),
    });
    // 행은 비중첩 버튼 계약(래퍼 div + 본체 버튼 + ⇆ 액션)이라 subject는 본체 버튼 안에 있다.
    const rowChildren = (Array.isArray(row.props.children) ? row.props.children : [row.props.children]) as readonly ReactNode[];
    const mainButton = rowChildren.find((child) => isElement(child) && child.type === "button" && child.props.className === "history-commit-row-main");
    const children = (isElement(mainButton) ? mainButton.props.children : []) as readonly ReactNode[];
    const subject = children.find((child) => isElement(child) && child.type === "span" && child.props.className === "history-commit-subject");

    expect(isElement(subject) && subject.props.title).toBe(COMMIT.subject);
    expect(isElement(subject) && subject.props.children).toBe(COMMIT.subject);
  });

  it("combines remote provenance and checkout state into one branch badge", () => {
    const entry = { ...COMMIT, refs: ["refs/remotes/origin/main", "HEAD -> refs/heads/main"] };
    const row = CommitRow({
      entry,
      checkouts: [{ sha: COMMIT.fullHash, branch: "main", isCurrent: true }],
      selected: false,
      graphNode: layoutGraph([entry]).nodes[0]!,
      onSelect: vi.fn(),
    });
    const rowChildren = (Array.isArray(row.props.children) ? row.props.children : [row.props.children]) as readonly ReactNode[];
    const mainButton = rowChildren.find((child) => isElement(child) && child.type === "button" && child.props.className === "history-commit-row-main");
    const children = (isElement(mainButton) ? mainButton.props.children : []) as readonly ReactNode[];
    const badgeGroup = children.find((child) => isElement(child) && child.props.className === "history-commit-badges");
    const badgeChildren = isElement(badgeGroup) && Array.isArray(badgeGroup.props.children) ? badgeGroup.props.children.flat() : [];
    const badges = badgeChildren.filter(isElement);

    expect(badges).toHaveLength(1);
    const badgeElement = badges[0]!;
    expect(typeof badgeElement.type).toBe("function");
    const renderedBadge = (badgeElement.type as (props: ElementProps) => ReactElement<ElementProps>)(badgeElement.props);
    expect(renderedBadge.props.className).toBe("history-badge history-badge--branch is-current has-remote");
    const segments = (Array.isArray(renderedBadge.props.children) ? renderedBadge.props.children : []).filter(isElement);
    expect(segments.map((segment) => segment.props.className)).toEqual([
      "history-badge-mark history-badge-remote-mark",
      "history-badge-mark",
      "history-badge-label",
    ]);
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
  const generationA: HistoryLoadGeneration = { theaterId: "theater", repoRel: "", refFilter: "refs/heads/a", order: "topo", refreshToken: 0 };
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

// 2026-08-07 회귀 — 기본 정렬이 topo가 되면서 목록 위치가 시간 순서를 뜻하지 않게 되었다.
// 이 저장소 실측: topo 목록에서 ecf03342(20:23)가 35ee071f(20:43)보다 위에 선다.
// 위치로 방향을 정하던 옛 로직은 그 둘을 비교할 때 base/head를 뒤집어 추가를 삭제로 보여 준다.
describe("chooseComparePair", () => {
  const ANCHOR = { fullHash: "ecf03342b4b50239", shortHash: "ecf03342", authorAt: 1_786_101_795 };
  const TARGET: LogCommitEntry = { ...COMMIT, fullHash: "35ee071f0a1b2c3d", shortHash: "35ee071f", authorAt: 1_786_103_009 };

  it("목록에서 앵커가 위에 있어도 더 오래된 쪽을 base로 삼는다", () => {
    expect(chooseComparePair(ANCHOR, TARGET)).toEqual({
      base: ANCHOR.fullHash, head: TARGET.fullHash, baseLabel: ANCHOR.shortHash, headLabel: TARGET.shortHash,
    });
  });

  it("반대로 고른 순서에서도 같은 방향을 낸다 — 방향은 표시 순서가 아니라 커밋 시각이 정한다", () => {
    const reversed = chooseComparePair(
      { fullHash: TARGET.fullHash, shortHash: TARGET.shortHash, authorAt: TARGET.authorAt },
      { ...COMMIT, fullHash: ANCHOR.fullHash, shortHash: ANCHOR.shortHash, authorAt: ANCHOR.authorAt },
    );
    expect(reversed.base).toBe(ANCHOR.fullHash);
    expect(reversed.head).toBe(TARGET.fullHash);
  });

  it("앵커의 시각을 알 수 없으면 사용자가 고른 순서를 지킨다", () => {
    const pair = chooseComparePair({ fullHash: "unknown", shortHash: "unknown", authorAt: null }, TARGET);
    expect(pair.base).toBe("unknown");
    expect(pair.head).toBe(TARGET.fullHash);
  });

  it("시각이 같으면 먼저 고른 쪽을 base로 둔다", () => {
    const pair = chooseComparePair({ fullHash: "a", shortHash: "a", authorAt: TARGET.authorAt }, TARGET);
    expect(pair.base).toBe("a");
  });
});
