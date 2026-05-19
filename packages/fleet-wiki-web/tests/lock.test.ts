import path from "node:path";

import { describe, expect, it } from "vitest";

import { lockFilePath, workspaceHash } from "../src/lock.js";

describe("lock", () => {
  it("uses a stable 12 character workspace hash", () => {
    expect(workspaceHash("/tmp/example")).toMatch(/^[a-f0-9]{12}$/);
    expect(workspaceHash("/tmp/example")).toBe(workspaceHash(path.resolve("/tmp/example")));
  });

  it("places lock files in the OS temp directory", () => {
    expect(lockFilePath()).toMatch(/fleet-wiki-daemon\.lock$/);
  });
});
