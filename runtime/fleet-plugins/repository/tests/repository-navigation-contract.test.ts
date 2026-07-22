import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { resolveRepositorySelection } from "../client/rail-panel.js";

const source = await fs.readFile(new URL("../client/rail-panel.tsx", import.meta.url), "utf8");

describe("Repository navigation landing contract", () => {
  it("lands a repeated selection in history without a transition", () => {
    expect(resolveRepositorySelection("theater-1", "repo-a", "repo-a")).toEqual({ transition: false, landing: "history" });
  });

  it("lands a different repository or worktree in history through a transition", () => {
    expect(resolveRepositorySelection("theater-1", "repo-a", "repo-b")).toEqual({ transition: true, landing: "history" });
  });

  it("does not transition without a theater", () => {
    expect(resolveRepositorySelection(null, "repo-a", "repo-b")).toEqual({ transition: false, landing: "history" });
  });

  it("keeps automatic context recovery landing in changes", () => {
    expect(source).toContain('landing: Source = "changes"');
    expect(source).toContain("setSource(landing)");
  });
});
