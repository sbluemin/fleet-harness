import { describe, expect, it } from "vitest";

import { buildRefListGroups, isRemoteHeadRef } from "../client/rail-panel.js";

describe("Repository ref list rows", () => {
  it("excludes symbolic remote HEAD refs from the REMOTES group", () => {
    const refs = {
      branches: [{ label: "main", ref: "refs/heads/main", current: true }],
      remotes: [
        { label: "origin", ref: "refs/remotes/origin/HEAD", current: false },
        { label: "origin/main", ref: "refs/remotes/origin/main", current: false },
      ],
      tags: [], stashes: [],
    };

    expect(isRemoteHeadRef("refs/remotes/origin/HEAD")).toBe(true);
    expect(isRemoteHeadRef("refs/remotes/origin/main")).toBe(false);
    expect(buildRefListGroups("branches", refs)).toEqual([
      { label: "LOCAL", rows: [{ key: "refs/heads/main", source: "branches", primary: "main", ref: "refs/heads/main", current: true }] },
      { label: "REMOTES", rows: [{ key: "refs/remotes/origin/main", source: "branches", primary: "origin/main", ref: "refs/remotes/origin/main", current: false }] },
    ]);
  });

  it("maps stash primary and secondary labels", () => {
    const refs = {
      branches: [], remotes: [], tags: [],
      stashes: [{ name: "stash@{0}", subject: "WIP: preserve selection" }, { name: "stash@{1}", subject: "" }],
    };

    expect(buildRefListGroups("stashes", refs)[0]?.rows).toEqual([
      { key: "stash@{0}", source: "stashes", primary: "WIP: preserve selection", sub: "stash@{0}", ref: null, current: false },
      { key: "stash@{1}", source: "stashes", primary: "stash@{1}", sub: "stash@{1}", ref: null, current: false },
    ]);
  });
});
