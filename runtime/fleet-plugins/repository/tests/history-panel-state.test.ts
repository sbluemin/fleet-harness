import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { CommitRow, findDetachedCheckout } from "../client/history-panel.js";
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
      onSelect: vi.fn(),
    });
    const children = row.props.children as readonly ReactNode[];
    const subject = children.find((child) => isElement(child) && child.type === "span" && child.props.className === "history-commit-subject");

    expect(isElement(subject) && subject.props.title).toBe(COMMIT.subject);
    expect(isElement(subject) && subject.props.children).toBe(COMMIT.subject);
  });
});
