import { describe, expect, it } from "vitest";

import { buildRepoTree, compressRepoFolder, countRepos } from "../client/repository-parsers.js";
import type { RepoCandidate } from "../server/types.js";

function repo(relPath: string, name?: string): RepoCandidate {
  return { relPath, name: name ?? relPath.split("/").pop() ?? relPath, branch: "main", kind: "nested" };
}

describe("buildRepoTree", () => {
  it("returns empty tree for no repos", () => {
    const tree = buildRepoTree([]);
    expect(tree.dirs).toEqual({});
    expect(tree.repos).toEqual([]);
    expect(countRepos(tree)).toBe(0);
  });

  it("places single-segment repos at the root", () => {
    const tree = buildRepoTree([repo("alpha"), repo("beta")]);
    expect(Object.keys(tree.dirs)).toEqual([]);
    expect(tree.repos.map((item) => item.relPath)).toEqual(["alpha", "beta"]);
  });

  it("nests repos under their parent directory segments", () => {
    const tree = buildRepoTree([repo("packages/foo"), repo("packages/bar"), repo("apps/web")]);
    expect(Object.keys(tree.dirs).sort()).toEqual(["apps", "packages"]);
    expect(tree.dirs.packages!.repos.map((item) => item.relPath)).toEqual(["packages/bar", "packages/foo"]);
    expect(tree.dirs.apps!.repos.map((item) => item.relPath)).toEqual(["apps/web"]);
    expect(countRepos(tree)).toBe(3);
  });

  it("sorts directories then repos alphabetically at each node", () => {
    const tree = buildRepoTree([repo("z/one"), repo("a/two"), repo("m/three"), repo("solo")]);
    expect(Object.keys(tree.dirs)).toEqual(["a", "m", "z"]);
    expect(tree.repos.map((item) => item.relPath)).toEqual(["solo"]);
  });

  it("sorts repos within a node by name (localeCompare)", () => {
    const tree = buildRepoTree([
      { relPath: "root/zeta", name: "zeta", branch: "main", kind: "nested" },
      { relPath: "root/alpha", name: "alpha", branch: "main", kind: "nested" },
      { relPath: "root/mid", name: "mid", branch: "main", kind: "nested" },
    ]);
    expect(tree.dirs.root!.repos.map((item) => item.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("keeps single-child chains uncompressed in the pure tree (compression is a UI concern)", () => {
    const tree = buildRepoTree([repo("a/b/c/leaf")]);
    expect(Object.keys(tree.dirs)).toEqual(["a"]);
    expect(Object.keys(tree.dirs.a!.dirs)).toEqual(["b"]);
    expect(Object.keys(tree.dirs.a!.dirs.b!.dirs)).toEqual(["c"]);
    expect(tree.dirs.a!.dirs.b!.dirs.c!.repos.map((item) => item.relPath)).toEqual(["a/b/c/leaf"]);
  });

  it("counts nested repos recursively", () => {
    const tree = buildRepoTree([repo("a/b/one"), repo("a/b/two"), repo("a/three"), repo("solo")]);
    expect(countRepos(tree)).toBe(4);
    expect(countRepos(tree.dirs.a!)).toBe(3);
    expect(countRepos(tree.dirs.a!.dirs.b!)).toBe(2);
  });

  it("filters empty path segments and skips repos with only-empty paths", () => {
    const tree = buildRepoTree([repo(""), repo("/foo"), repo("bar/")]);
    // "" ignored; "/foo" → after filter=["foo"], pop→[], repo at root name "foo"
    // "bar/" → after filter=["bar"], pop→[], repo at root name ""
    expect(Object.keys(tree.dirs)).toEqual([]);
    expect(tree.repos.map((item) => item.relPath).sort()).toEqual(["/foo", "bar/"]);
  });

  it("splits Windows-style backslash relPaths into segments without mutating the original relPath", () => {
    const tree = buildRepoTree([repo("packages\\foo", "foo"), repo("packages\\deep\\bar", "bar")]);
    expect(Object.keys(tree.dirs)).toEqual(["packages"]);
    expect(tree.dirs.packages!.repos.map((item) => item.relPath)).toEqual(["packages\\foo"]);
    expect(Object.keys(tree.dirs.packages!.dirs)).toEqual(["deep"]);
    expect(tree.dirs.packages!.dirs.deep!.repos.map((item) => item.relPath)).toEqual(["packages\\deep\\bar"]);
  });

  it("handles reserved property names as directory segments", () => {
    const tree = buildRepoTree([repo("__proto__/one"), repo("constructor/two"), repo("toString/three")]);
    expect(Object.keys(tree.dirs)).toEqual(["__proto__", "constructor", "toString"]);
    expect(tree.dirs["__proto__"]!.repos.map((item) => item.relPath)).toEqual(["__proto__/one"]);
    expect(tree.dirs["constructor"]!.repos.map((item) => item.relPath)).toEqual(["constructor/two"]);
    expect(tree.dirs["toString"]!.repos.map((item) => item.relPath)).toEqual(["toString/three"]);
    expect(countRepos(tree)).toBe(3);
  });

  it("does not pollute Object.prototype when a segment is __proto__", () => {
    const tree = buildRepoTree([repo("__proto__/one")]);
    expect(({} as Record<string, unknown>)["one"]).toBeUndefined();
    expect(Object.getPrototypeOf(tree.dirs)).toBeNull();
  });
});

describe("compressRepoFolder", () => {
  it("returns the folder unchanged when it holds repos or multiple child dirs", () => {
    const tree = buildRepoTree([repo("packages/foo"), repo("packages/nested/bar")]);
    const { label, node } = compressRepoFolder("packages", tree.dirs.packages!);
    expect(label).toBe("packages");
    expect(node).toBe(tree.dirs.packages!);
  });

  it("compresses a single-child repo-less chain into one label", () => {
    const tree = buildRepoTree([repo("a/b/c/leaf")]);
    const { label, node } = compressRepoFolder("a", tree.dirs.a!);
    expect(label).toBe("a/b/c");
    expect(node).toBe(tree.dirs.a!.dirs.b!.dirs.c!);
    expect(node.repos.map((item) => item.relPath)).toEqual(["a/b/c/leaf"]);
  });

  it("stops compressing at a node that owns repos", () => {
    const tree = buildRepoTree([repo("a/b/mid"), repo("a/b/c/leaf")]);
    const { label, node } = compressRepoFolder("a", tree.dirs.a!);
    expect(label).toBe("a/b");
    expect(node).toBe(tree.dirs.a!.dirs.b!);
    expect(countRepos(node)).toBe(2);
  });

  it("compresses deep chains across many levels", () => {
    const tree = buildRepoTree([repo("v/w/x/y/z/leaf")]);
    const { label } = compressRepoFolder("v", tree.dirs.v!);
    expect(label).toBe("v/w/x/y/z");
  });
});
