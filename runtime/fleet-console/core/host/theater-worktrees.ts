import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

export interface TheaterWorktree {
  readonly relPath: string;
  readonly branch: string | null;
  readonly isCurrent: boolean;
}

export interface TheaterWorktreesResult {
  readonly isGitRepo: boolean;
  readonly worktrees: readonly TheaterWorktree[];
}

export interface WorktreeRecord {
  readonly worktree: string;
  readonly branch: string | null;
  readonly detached: boolean;
}

export interface ListTheaterWorktreesDeps {
  readonly execFile?: (file: string, args: readonly string[], options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly shell: false; readonly timeout: number; readonly maxBuffer: number }) => Promise<{ readonly stdout: string }>;
  readonly realpath?: typeof fs.promises.realpath;
}

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 3_000;
const GIT_MAX_BUFFER = 1_000_000;

export async function listTheaterWorktrees(theaterRoot: string, deps: ListTheaterWorktreesDeps = {}): Promise<TheaterWorktreesResult> {
  const exec = deps.execFile ?? ((file, args, options) => execFileAsync(file, args as string[], options));
  const realpath = deps.realpath ?? fs.promises.realpath;
  let stdout: string;
  try {
    ({ stdout } = await exec("git", ["worktree", "list", "--porcelain"], { cwd: theaterRoot, env: { ...process.env, LC_ALL: "C" }, shell: false, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }));
  } catch (error) {
    if (isNotGitError(error)) return { isGitRepo: false, worktrees: [] };
    throw error;
  }
  const realRoot = await realpath(theaterRoot);
  const records = parseGitWorktreePorcelain(stdout);
  const worktrees: TheaterWorktree[] = [];
  for (const record of records) {
    try {
      const real = await realpath(record.worktree);
      if (!isWithinRoot(real, realRoot) || real === realRoot) continue;
      worktrees.push({ relPath: path.relative(realRoot, real).split(path.sep).join("/"), branch: record.branch, isCurrent: real === realRoot });
    } catch { /* prunable or external worktrees are omitted */ }
  }
  return { isGitRepo: true, worktrees };
}

export function parseGitWorktreePorcelain(value: string): readonly WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  for (const block of value.split("\n\n")) {
    const fields = block.split("\n");
    const worktree = fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length);
    if (!worktree) continue;
    const branchRef = fields.find((field) => field.startsWith("branch "))?.slice("branch ".length) ?? null;
    records.push({ worktree, branch: branchRef?.replace(/^refs\/heads\//, "") ?? null, detached: fields.includes("detached") });
  }
  return records;
}

function isWithinRoot(candidate: string, root: string): boolean {
  const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return candidate === root || candidate.startsWith(normalizedRoot);
}

function isNotGitError(error: unknown): boolean {
  const value = error as { readonly stderr?: unknown; readonly message?: unknown };
  const text = `${typeof value.stderr === "string" ? value.stderr : ""}\n${typeof value.message === "string" ? value.message : ""}`;
  return /not a git repository/i.test(text);
}
