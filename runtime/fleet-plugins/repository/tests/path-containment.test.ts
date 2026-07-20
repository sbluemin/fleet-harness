import path from "node:path";

import { describe, expect, it } from "vitest";

import { isPathContained } from "../server/path-containment.js";

describe("Repository path containment", () => {
  it("treats an empty relative path as contained", () => {
    expect(isPathContained(path.join(path.parse(process.cwd()).root, "repo"), path.join(path.parse(process.cwd()).root, "repo"))).toBe(true);
  });

  it("rejects parent traversal and sibling-prefix paths", () => {
    const root = path.join(path.parse(process.cwd()).root, "repo");
    expect(isPathContained(root, path.dirname(root))).toBe(false);
    expect(isPathContained(root, `${root}-sibling`)).toBe(false);
  });

  it("accepts a child of a filesystem-root Theater", () => {
    const filesystemRoot = path.parse(process.cwd()).root;
    expect(isPathContained(filesystemRoot, path.join(filesystemRoot, "nested-repository"))).toBe(true);
  });
});
