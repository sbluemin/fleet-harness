import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
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

    writeFileSync(workspace.identityPath, JSON.stringify({ cwd: `${workspace.cwd}-other` }));
    expect(() => ensureWorkspaceDirectory(dataDir, cwd)).toThrow(/identity collision/);
    expect(() => findWorkspaceDirectory(dataDir, cwd)).toThrow(/identity does not match/);
    expect(() => resolveWorkspaceDirectoryByName(dataDir, workspace.name)).toThrow(/identity does not match/);
  });

  it("finds no workspace without creating the data directory", () => {
    const root = makeTempRoot();
    const cwd = path.join(root, "repo");
    const dataDir = path.join(root, "missing-fleet-data");
    mkdirSync(cwd, { recursive: true });

    expect(findWorkspaceDirectory(dataDir, cwd)).toBeNull();
    expect(existsSync(path.join(dataDir, "workspaces"))).toBe(false);
  });

  it("keeps ASCII paths with lossy legacy names in independent workspaces", () => {
    const root = makeTempRoot();
    assertIndependentWorkspaces(root, path.join(root, "a", "b-c"), path.join(root, "a", "b", "c"));
  });

  it("keeps paths differing only in non-ASCII names in independent workspaces", () => {
    const root = makeTempRoot();
    assertIndependentWorkspaces(root, path.join(root, "활성 무대"), path.join(root, "대기 무대"));
  });

  it("reuses verified legacy data and gives a colliding cwd its own new workspace", () => {
    const root = makeTempRoot();
    const cwd = path.join(root, "활성 무대");
    const otherCwd = path.join(root, "대기 무대");
    const dataDir = path.join(root, "fleet-data");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(otherCwd, { recursive: true });
    const canonicalCwd = realpathSync.native(cwd);
    // 이전 버전이 저장한 이름·identity·내용을 새 API를 거치지 않고 준비한다.
    const legacyName = canonicalCwd.replace(/[^a-zA-Z0-9]/g, "-");
    const legacyPath = path.join(dataDir, "workspaces", legacyName);
    mkdirSync(legacyPath, { recursive: true });
    writeFileSync(path.join(legacyPath, "cwd.json"), JSON.stringify({ cwd: canonicalCwd }));
    writeFileSync(path.join(legacyPath, "knowledge.json"), "legacy knowledge");

    const existing = findWorkspaceDirectory(dataDir, cwd);
    expect(existing?.path).toBe(legacyPath);
    expect(ensureWorkspaceDirectory(dataDir, cwd)).toEqual(existing);
    expect(resolveWorkspaceDirectoryByName(dataDir, legacyName)).toEqual(existing);
    expect(readFileSync(path.join(legacyPath, "knowledge.json"), "utf8")).toBe("legacy knowledge");
    expect(existsSync(path.join(dataDir, "workspaces", toWorkspaceDirectoryName(canonicalCwd)))).toBe(false);
    expect(findWorkspaceDirectory(dataDir, otherCwd)).toBeNull();
    const other = ensureWorkspaceDirectory(dataDir, otherCwd);
    expect(other.path).not.toBe(legacyPath);
    expect(findWorkspaceDirectory(dataDir, cwd)).toEqual(existing);
    expect(resolveWorkspaceDirectoryByName(dataDir, other.name)).toEqual(other);
    expect(readFileSync(path.join(legacyPath, "knowledge.json"), "utf8")).toBe("legacy knowledge");
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
    expect(() => ensureWorkspaceDirectory(dataDir, cwd)).toThrow(/root not found or unsafe/);
  });
});

function assertIndependentWorkspaces(root: string, first: string, second: string): void {
  const dataDir = path.join(root, "fleet-data");
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  const firstWorkspace = ensureWorkspaceDirectory(dataDir, first);
  const secondWorkspace = ensureWorkspaceDirectory(dataDir, second);
  expect(firstWorkspace.path).not.toBe(secondWorkspace.path);
  writeFileSync(path.join(firstWorkspace.path, "knowledge.json"), "first");
  writeFileSync(path.join(secondWorkspace.path, "knowledge.json"), "second");
  for (const [cwd, workspace, contents] of [[first, firstWorkspace, "first"], [second, secondWorkspace, "second"]] as const) {
    expect(ensureWorkspaceDirectory(dataDir, cwd)).toEqual(workspace);
    expect(findWorkspaceDirectory(dataDir, cwd)).toEqual(workspace);
    expect(resolveWorkspaceDirectoryByName(dataDir, workspace.name)).toEqual(workspace);
    expect(readFileSync(path.join(workspace.path, "knowledge.json"), "utf8")).toBe(contents);
  }
}

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-workspace-dir-"));
  cleanupPaths.push(root);
  return root;
}
