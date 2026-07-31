import { describe, expect, it } from "vitest";

import { mapGitStatusBadge } from "../client/tree.js";

describe("mapGitStatusBadge", () => {
  it("maps git states to their fixed badge letter and accessible message key", () => {
    expect(mapGitStatusBadge("modified")).toEqual({
      text: "M",
      status: "modified",
      messageKey: "fileExplorer.git.modified",
    });
    expect(mapGitStatusBadge("untracked")).toEqual({
      text: "U",
      status: "untracked",
      messageKey: "fileExplorer.git.untracked",
    });
    expect(mapGitStatusBadge("deleted")).toEqual({
      text: "D",
      status: "deleted",
      messageKey: "fileExplorer.git.deleted",
    });
    expect(mapGitStatusBadge(undefined)).toBeNull();
  });
});
