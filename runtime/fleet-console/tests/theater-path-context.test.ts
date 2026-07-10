import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listTheaterDirectories, resolveTheaterPathContext } from "../core/host/theater-path-context.js";
import { listTheaterWorktrees, parseGitWorktreePorcelain } from "../core/host/theater-worktrees.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Theater path context resolver", () => {
  it("canonicalizes contained aliases and rejects traversal-shaped input", async () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, "nested"));
    fs.symlinkSync(path.join(root, "nested"), path.join(root, "alias"));
    await expect(resolveTheaterPathContext(root, "alias")).resolves.toMatchObject({ relPath: "nested", label: "nested" });
    await expect(resolveTheaterPathContext(root, "nested/../x")).rejects.toMatchObject({ code: "invalid_path" });
    await expect(resolveTheaterPathContext(root, "nested\\..\\sibling")).rejects.toMatchObject({ code: "invalid_path" });
    await expect(resolveTheaterPathContext(root, "/tmp")).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("omits escaping directory symlinks and caps directory output", async () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, "safe"));
    fs.symlinkSync(os.tmpdir(), path.join(root, "escape"));
    const directories = await listTheaterDirectories(root, null);
    expect(directories).toEqual([{ relPath: "safe", label: "safe" }]);
  });
});

describe("git worktree discovery", () => {
  it("pins Git output to the C locale without changing execution bounds", async () => {
    const root = makeRoot();
    const execFile = async (_file: string, _args: readonly string[], options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly shell: false; readonly timeout: number; readonly maxBuffer: number }) => {
      expect(options).toMatchObject({ cwd: root, env: { LC_ALL: "C" }, shell: false, timeout: 3_000, maxBuffer: 1_000_000 });
      return { stdout: "" };
    };
    await expect(listTheaterWorktrees(root, { execFile })).resolves.toEqual({ isGitRepo: true, worktrees: [] });
  });
});

describe("git worktree porcelain parser", () => {
  it("keeps paths with spaces and detached records without raw porcelain fields", () => {
    expect(parseGitWorktreePorcelain("worktree /tmp/root\nHEAD abc\nbranch refs/heads/feature/x\n\nworktree /tmp/root/my worktree\nHEAD def\ndetached\n")).toEqual([
      { worktree: "/tmp/root", branch: "feature/x", detached: false },
      { worktree: "/tmp/root/my worktree", branch: null, detached: true },
    ]);
  });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-path-context-"));
  tempDirs.push(root);
  return root;
}
