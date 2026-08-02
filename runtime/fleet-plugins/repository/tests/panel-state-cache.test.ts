import { afterEach, describe, expect, it } from "vitest";

import {
  dropCompareViewState,
  dropRepoViewState,
  dropWorkspaceTreeState,
  PANEL_STATE_CACHE_LIMIT,
  readCompareViewState,
  readRepoViewState,
  readWorkspaceTreeState,
  writeCompareViewState,
  writeRepoViewState,
  writeWorkspaceTreeState,
  type CompareViewState,
  type RepoViewState,
  type WorkspaceTreeState,
} from "../client/repository-state.js";

const theaterIds = new Set<string>();
const repoScopes = new Set<readonly [string, string]>();
const theater = (name: string): string => {
  theaterIds.add(name);
  return name;
};
const repository = (theaterId: string, repoRel: string): readonly [string, string] => {
  theaterIds.add(theaterId);
  repoScopes.add([theaterId, repoRel]);
  return [theaterId, repoRel];
};
const treeEntry = (query: string): WorkspaceTreeState => ({ query, collapsedSections: ["tags"], collapsedFolders: ["packages/core"], scrollTop: 40 });
const viewEntry = (filterText: string): RepoViewState => ({ filterText, refFilter: "refs/heads/canary", scrollTop: 80, collapsedFolders: ["runtime"] });
const compareEntry = (message: string): CompareViewState => ({ result: { kind: "error", message }, selectedPath: null, listPaneWidth: 320, scrollTop: 120 });

afterEach(() => {
  for (const theaterId of theaterIds) dropWorkspaceTreeState(theaterId);
  for (const [theaterId, repoRel] of repoScopes) {
    dropRepoViewState(theaterId, repoRel);
    dropCompareViewState(theaterId, repoRel);
  }
  theaterIds.clear();
  repoScopes.clear();
});

describe("repository panel state cache", () => {
  it("round-trips entries in all three caches", () => {
    const theaterId = theater("round-trip");
    const [repoTheaterId, repoRel] = repository(theaterId, "packages/core");
    const tree = treeEntry("core");
    const view = viewEntry("index");
    const compare = compareEntry("no_merge_base");

    writeWorkspaceTreeState(theaterId, tree);
    writeRepoViewState(repoTheaterId, repoRel, view);
    writeCompareViewState(repoTheaterId, repoRel, compare);

    expect(readWorkspaceTreeState(theaterId)).toBe(tree);
    expect(readRepoViewState(repoTheaterId, repoRel)).toBe(view);
    expect(readCompareViewState(repoTheaterId, repoRel)).toBe(compare);
  });

  it("evicts the least recently used key above PANEL_STATE_CACHE_LIMIT", () => {
    const keys = Array.from({ length: PANEL_STATE_CACHE_LIMIT + 1 }, (_, index) => theater(`limit-${index}`));
    keys.forEach((key, index) => writeWorkspaceTreeState(key, treeEntry(String(index))));

    expect(readWorkspaceTreeState(keys[0]!)).toBeNull();
    expect(readWorkspaceTreeState(keys.at(-1)!)).not.toBeNull();
  });

  it("moves an updated key to the most recently used position", () => {
    const keys = Array.from({ length: PANEL_STATE_CACHE_LIMIT }, (_, index) => repository(`update-${index}`, "repo"));
    keys.forEach(([theaterId, repoRel], index) => writeRepoViewState(theaterId, repoRel, viewEntry(String(index))));
    const updated = viewEntry("updated");
    writeRepoViewState(keys[0]![0], keys[0]![1], updated);
    const overflow = repository("update-overflow", "repo");
    writeRepoViewState(overflow[0], overflow[1], viewEntry("overflow"));

    expect(readRepoViewState(keys[0]![0], keys[0]![1])).toBe(updated);
    expect(readRepoViewState(keys[1]![0], keys[1]![1])).toBeNull();
  });

  it("moves a read key to the most recently used position", () => {
    const keys = Array.from({ length: PANEL_STATE_CACHE_LIMIT }, (_, index) => repository(`read-${index}`, "repo"));
    keys.forEach(([theaterId, repoRel], index) => writeCompareViewState(theaterId, repoRel, compareEntry(String(index))));
    expect(readCompareViewState(keys[0]![0], keys[0]![1])).not.toBeNull();
    const overflow = repository("read-overflow", "repo");
    writeCompareViewState(overflow[0], overflow[1], compareEntry("overflow"));

    expect(readCompareViewState(keys[0]![0], keys[0]![1])).not.toBeNull();
    expect(readCompareViewState(keys[1]![0], keys[1]![1])).toBeNull();
  });

  it("drops only the requested entries", () => {
    const dropped = repository("drop", "one");
    const retained = repository("drop", "two");
    writeRepoViewState(dropped[0], dropped[1], viewEntry("drop"));
    writeRepoViewState(retained[0], retained[1], viewEntry("keep"));
    dropRepoViewState(dropped[0], dropped[1]);

    expect(readRepoViewState(dropped[0], dropped[1])).toBeNull();
    expect(readRepoViewState(retained[0], retained[1])?.filterText).toBe("keep");
  });

  it("keeps the three maps independent for keys with the same suffix", () => {
    const theaterId = theater("shared");
    const scope = repository(theaterId, "shared");
    writeWorkspaceTreeState(theaterId, treeEntry("tree"));
    writeRepoViewState(scope[0], scope[1], viewEntry("view"));
    writeCompareViewState(scope[0], scope[1], compareEntry("compare"));

    dropRepoViewState(scope[0], scope[1]);

    expect(readWorkspaceTreeState(theaterId)?.query).toBe("tree");
    expect(readRepoViewState(scope[0], scope[1])).toBeNull();
    expect(readCompareViewState(scope[0], scope[1])?.result).toEqual({ kind: "error", message: "compare" });
  });
});
