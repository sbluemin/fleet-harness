import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export type GitFileStatus = "modified" | "untracked" | "deleted";

export interface GitStatusEntry {
  readonly path: string;
  readonly status: GitFileStatus;
}

export interface GitStatusResult {
  readonly ok: true;
  readonly gitAvailable: boolean;
  readonly statuses: readonly GitStatusEntry[];
}

export type GitStatusPathErrorCode = "invalid_path" | "not_found" | "forbidden";

export class GitStatusPathError extends Error {
  readonly code: GitStatusPathErrorCode;

  constructor(code: GitStatusPathErrorCode) {
    super(code);
    this.name = "GitStatusPathError";
    this.code = code;
  }
}

interface ParsedGitStatusEntry {
  readonly gitPath: string;
  readonly status: GitFileStatus;
}

interface GitStatusDependencies {
  readonly realpath?: typeof fs.realpath;
  readonly execGit?: (theaterRootAbs: string, args: readonly string[]) => Promise<string>;
}

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

export async function readTheaterGitStatus(
  theaterPath: string,
  deps: GitStatusDependencies = {},
): Promise<GitStatusResult> {
  const realpath = deps.realpath ?? fs.realpath;
  const execGit = deps.execGit ?? executeGit;
  let theaterRootAbs: string;
  try {
    theaterRootAbs = await realpath(path.resolve(theaterPath));
  } catch (error) {
    throw mapFsError(error);
  }

  try {
    const [prefixOutput, statusOutput] = await Promise.all([
      execGit(theaterRootAbs, ["rev-parse", "--show-prefix"]),
      execGit(theaterRootAbs, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
    ]);
    const prefix = stripTrailingLineBreak(prefixOutput);
    return {
      ok: true,
      gitAvailable: true,
      statuses: scopeGitStatusesToTheater(parseGitStatusPorcelainV1Z(statusOutput), prefix),
    };
  } catch {
    return { ok: true, gitAvailable: false, statuses: [] };
  }
}

export function parseGitStatusPorcelainV1Z(output: string): ParsedGitStatusEntry[] {
  const records = output.split("\0");
  const statuses: ParsedGitStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4 || record[2] !== " ") continue;

    const indexStatus = record[0] ?? " ";
    const worktreeStatus = record[1] ?? " ";
    const statusPair = `${indexStatus}${worktreeStatus}`;
    const gitPath = record.slice(3);
    const isRenameOrCopy = statusPair.includes("R") || statusPair.includes("C");
    const status = classifyGitStatus(statusPair);
    if (status && gitPath) statuses.push({ gitPath, status });

    // In porcelain v1 -z, rename/copy records are "new\0old\0".
    if (isRenameOrCopy && index + 1 < records.length) index += 1;
  }
  return statuses;
}

export function scopeGitStatusesToTheater(
  entries: readonly ParsedGitStatusEntry[],
  prefix: string,
  separator = path.sep,
): GitStatusEntry[] {
  const statuses: GitStatusEntry[] = [];
  for (const entry of entries) {
    if (prefix && !entry.gitPath.startsWith(prefix)) continue;
    const relativeGitPath = prefix ? entry.gitPath.slice(prefix.length) : entry.gitPath;
    const segments = relativeGitPath.split("/");
    if (
      relativeGitPath === ""
      || relativeGitPath.startsWith("/")
      || segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) continue;
    const relativePath = segments.join(separator);
    if (path.isAbsolute(relativePath)) continue;
    statuses.push({ path: relativePath, status: entry.status });
  }
  return statuses;
}

function classifyGitStatus(statusPair: string): GitFileStatus | null {
  if (statusPair === "??") return "untracked";
  if (statusPair.includes("D")) return "deleted";
  if ([...statusPair].some((status) => status === "A" || status === "M" || status === "R" || status === "C")) {
    return "modified";
  }
  return null;
}

function executeGit(theaterRootAbs: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", theaterRootAbs, ...args],
      {
        encoding: "utf8",
        // Background status reads must not refresh the index and feed their own file-watch loop.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        maxBuffer: GIT_MAX_BUFFER,
        shell: false,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function stripTrailingLineBreak(output: string): string {
  if (!output.endsWith("\n")) return output;
  const withoutLineFeed = output.slice(0, -1);
  return withoutLineFeed.endsWith("\r") ? withoutLineFeed.slice(0, -1) : withoutLineFeed;
}

function mapFsError(error: unknown): GitStatusPathError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") return new GitStatusPathError("forbidden");
  if (code === "ENOENT" || code === "ENOTDIR") return new GitStatusPathError("not_found");
  return new GitStatusPathError("invalid_path");
}
