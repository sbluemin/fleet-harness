import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureWorkspaceDirectory } from "@dotobokuri/core-infra";
import { discoverMissionControlCounts } from "../src/mission-control/loaded-counts.js";

const temporaryPaths: string[] = [];

describe("discoverMissionControlCounts", () => {
  afterEach(() => {
    for (const temporaryPath of temporaryPaths.splice(0)) {
      rmSync(temporaryPath, { recursive: true, force: true });
    }
  });

  it("returns zero Wiki counts for a missing workspace without creating durable storage", () => {
    const invocationCwd = temporaryDirectory("fleet-count-project-");
    const dataParent = temporaryDirectory("fleet-count-parent-");
    const dataDir = path.join(dataParent, "data");

    expect(discoverMissionControlCounts({ dataDir, invocationCwd })).toEqual({
      carriers: 6,
      queuedPatches: 0,
      wikiEntries: 0,
    });
    expect(existsSync(dataDir)).toBe(false);
    expect(existsSync(path.join(invocationCwd, ".fleet", "knowledge"))).toBe(false);
  });

  it("counts only populated workspace-backed Wiki knowledge", () => {
    const invocationCwd = temporaryDirectory("fleet-count-project-");
    const dataDir = temporaryDirectory("fleet-count-data-");
    const workspace = ensureWorkspaceDirectory(dataDir, invocationCwd);
    writeFile(path.join(workspace.path, "knowledge", "wiki", "index.md"), "# Index\n");
    writeFile(path.join(workspace.path, "knowledge", "wiki", "entry.md"), "# Entry\n");
    writeFile(path.join(workspace.path, "knowledge", "wiki", "nested", "child.md"), "# Child\n");
    writeFile(path.join(workspace.path, "knowledge", "queue", "pending", "patch.md"), "# Patch\n");
    writeFile(path.join(workspace.path, "knowledge", "queue", "_sets", "ignored", "patch.md"), "# Ignored\n");

    expect(discoverMissionControlCounts({ dataDir, invocationCwd })).toEqual({
      carriers: 6,
      queuedPatches: 1,
      wikiEntries: 2,
    });
  });

  it("fails closed for an unsafe workspace Wiki destination", () => {
    const invocationCwd = temporaryDirectory("fleet-count-project-");
    const dataDir = temporaryDirectory("fleet-count-data-");
    const outside = temporaryDirectory("fleet-count-outside-");
    const workspace = ensureWorkspaceDirectory(dataDir, invocationCwd);
    writeFile(path.join(outside, "wiki", "entry.md"), "# Outside\n");
    rmSync(path.join(workspace.path, "knowledge"), { recursive: true, force: true });
    symlinkSync(outside, path.join(workspace.path, "knowledge"));

    expect(discoverMissionControlCounts({ dataDir, invocationCwd })).toEqual({
      carriers: 6,
      queuedPatches: 0,
      wikiEntries: 0,
    });
  });

  it("ignores root legacy knowledge before the first Wiki tool use", () => {
    const invocationCwd = temporaryDirectory("fleet-count-project-");
    const dataDir = temporaryDirectory("fleet-count-data-");
    writeFile(path.join(invocationCwd, ".fleet", "knowledge", "wiki", "legacy.md"), "# Legacy\n");

    expect(discoverMissionControlCounts({ dataDir, invocationCwd })).toEqual({
      carriers: 6,
      queuedPatches: 0,
      wikiEntries: 0,
    });
    expect(existsSync(path.join(dataDir, "workspaces"))).toBe(false);
  });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

function writeFile(target: string, contents: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, { encoding: "utf8" });
}
