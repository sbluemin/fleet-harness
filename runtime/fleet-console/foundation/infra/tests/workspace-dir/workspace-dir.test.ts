import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureWorkspaceDirectory,
  findWorkspaceDirectory,
  resolveWorkspaceDirectoryByName,
  toWorkspaceDirectoryName,
} from "../../src/workspace-dir/workspace-dir.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { force: true, recursive: true });
  }
});

describe("WorkspaceDirectory", () => {
  it("uses Claude-style readable cwd names without collapsing replacements", () => {
    expect(toWorkspaceDirectoryName("/Users/sbluemin/workspace/fleet-harness"))
      .toBe("-Users-sbluemin-workspace-fleet-harness");
    expect(toWorkspaceDirectoryName("/Users/sbluemin/workspace/fleet-harness/.fleet"))
      .toBe("-Users-sbluemin-workspace-fleet-harness--fleet");
    expect(toWorkspaceDirectoryName("C:\\Users\\sbluemin\\workspace\\fleet-harness"))
      .toBe("C--Users-sbluemin-workspace-fleet-harness");
    expect(toWorkspaceDirectoryName("D:\\asd")).toBe("D--asd");
  });

  it("creates a secure cwd identity and resolves it by workspace name", () => {
    const root = makeTempRoot();
    const cwd = path.join(root, "repo");
    const dataDir = path.join(root, "fleet-data");
    mkdirSync(cwd, { recursive: true });

    const workspace = ensureWorkspaceDirectory(dataDir, cwd);
    const identity = JSON.parse(readFileSync(workspace.identityPath, "utf8")) as { cwd: string };
    const resolved = resolveWorkspaceDirectoryByName(dataDir, workspace.name);

    expect(workspace.path).toBe(path.join(dataDir, "workspaces", workspace.name));
    expect(identity).toEqual({ cwd: workspace.cwd });
    expect(resolved).toEqual(workspace);
    expect(findWorkspaceDirectory(dataDir, cwd)).toEqual(workspace);
  });

  it("finds no workspace without creating the data directory", () => {
    const root = makeTempRoot();
    const cwd = path.join(root, "repo");
    const dataDir = path.join(root, "missing-fleet-data");
    mkdirSync(cwd, { recursive: true });

    expect(findWorkspaceDirectory(dataDir, cwd)).toBeNull();
    expect(existsSync(path.join(dataDir, "workspaces"))).toBe(false);
  });

  it("rejects different canonical cwd values that sanitize to the same name", () => {
    const root = makeTempRoot();
    const first = path.join(root, "a", "b-c");
    const second = path.join(root, "a", "b", "c");
    const dataDir = path.join(root, "fleet-data");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });

    const firstWorkspace = ensureWorkspaceDirectory(dataDir, first);
    expect(toWorkspaceDirectoryName(path.resolve(first)))
      .toBe(toWorkspaceDirectoryName(path.resolve(second)));
    expect(() => ensureWorkspaceDirectory(dataDir, second))
      .toThrow(/identity collision/);
    expect(JSON.parse(readFileSync(firstWorkspace.identityPath, "utf8")))
      .toEqual({ cwd: firstWorkspace.cwd });
  });

  it("rejects unsafe workspace references and symlinked workspace directories", () => {
    const root = makeTempRoot();
    const dataDir = path.join(root, "fleet-data");
    const workspaces = path.join(dataDir, "workspaces");
    const outside = path.join(root, "outside");
    mkdirSync(workspaces, { recursive: true });
    mkdirSync(outside, { recursive: true });

    expect(() => resolveWorkspaceDirectoryByName(dataDir, "../outside"))
      .toThrow(/Invalid workspace directory name/);

    if (process.platform !== "win32") {
      const name = "-tmp-symlinked";
      symlinkSync(outside, path.join(workspaces, name), "dir");
      expect(() => resolveWorkspaceDirectoryByName(dataDir, name))
        .toThrow(/not found or unsafe/);
    }
  });

  it("rejects a symlinked workspaces root", () => {
    if (process.platform === "win32") return;
    const root = makeTempRoot();
    const dataDir = path.join(root, "fleet-data");
    const cwd = path.join(root, "repo");
    const outside = path.join(root, "outside");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(dataDir, "workspaces"), "dir");

    expect(() => findWorkspaceDirectory(dataDir, cwd)).toThrow(/root not found or unsafe/);
    expect(() => ensureWorkspaceDirectory(dataDir, cwd)).toThrow(/Unsafe Fleet directory/);
  });
});

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-workspace-dir-"));
  cleanupPaths.push(root);
  return root;
}
