import { describe, expect, it } from "vitest";

import { buildRefListGroups, isRemoteHeadRef, isWorktreePathContextSelectable, worktreePathContextRelPath } from "../client/rail-panel.js";

describe("Repository ref list rows", () => {
  it("excludes symbolic remote HEAD refs from the REMOTES group", () => {
    const refs = {
      branches: [{ label: "main", ref: "refs/heads/main", current: true }],
      remotes: [
        { label: "origin", ref: "refs/remotes/origin/HEAD", current: false },
        { label: "origin/main", ref: "refs/remotes/origin/main", current: false },
      ],
      tags: [], stashes: [], worktrees: [],
    };

    expect(isRemoteHeadRef("refs/remotes/origin/HEAD")).toBe(true);
    expect(isRemoteHeadRef("refs/remotes/origin/main")).toBe(false);
    expect(buildRefListGroups("branches", refs)).toEqual([
      { label: "LOCAL", rows: [{ key: "refs/heads/main", source: "branches", primary: "main", ref: "refs/heads/main", current: true }] },
      { label: "REMOTES", rows: [{ key: "refs/remotes/origin/main", source: "branches", primary: "origin/main", ref: "refs/remotes/origin/main", current: false }] },
    ]);
  });

  it("maps stash and worktree primary and secondary labels", () => {
    const refs = {
      branches: [], remotes: [], tags: [],
      stashes: [{ name: "stash@{0}", subject: "WIP: preserve selection" }, { name: "stash@{1}", subject: "" }],
      worktrees: [{ name: "repository-ref-list-polish", branch: "repository-ref-list-polish", current: true, contextRelPath: "" }, { name: "detached", branch: null, current: false, contextRelPath: null }, { name: "worktree-dir", branch: "topic", current: false, contextRelPath: ".fleet/worktrees/topic" }],
    };

    expect(buildRefListGroups("stashes", refs)[0]?.rows).toEqual([
      { key: "stash@{0}", source: "stashes", primary: "WIP: preserve selection", sub: "stash@{0}", ref: null, current: false },
      { key: "stash@{1}", source: "stashes", primary: "stash@{1}", sub: "stash@{1}", ref: null, current: false },
    ]);
    expect(buildRefListGroups("worktrees", refs)[0]?.rows).toEqual([
      { key: "repository-ref-list-polish", source: "worktrees", primary: "repository-ref-list-polish", ref: null, current: true, contextRelPath: "" },
      { key: "detached", source: "worktrees", primary: "detached", ref: null, current: false, contextRelPath: null },
      { key: "worktree-dir", source: "worktrees", primary: "topic", sub: "worktree-dir", ref: null, current: false, contextRelPath: ".fleet/worktrees/topic" },
    ]);
  });

  it("enables only selectable worktrees and maps the theater root to the deck root", () => {
    const selectPathContext = () => undefined;

    expect(isWorktreePathContextSelectable(selectPathContext, "")).toBe(true);
    expect(isWorktreePathContextSelectable(selectPathContext, ".fleet/worktrees/topic")).toBe(true);
    expect(isWorktreePathContextSelectable(selectPathContext, null)).toBe(false);
    expect(isWorktreePathContextSelectable(undefined, ".fleet/worktrees/topic")).toBe(false);
    expect(worktreePathContextRelPath("")).toBeNull();
    expect(worktreePathContextRelPath(".fleet/worktrees/topic")).toBe(".fleet/worktrees/topic");
  });
});
