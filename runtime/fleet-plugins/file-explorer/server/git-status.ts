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
  readonly truncated?: true;
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
  readonly realpath?: (target: string) => Promise<string>;
  readonly execGit?: (args: readonly string[], options: GitExecOptions) => Promise<string>;
  readonly environment?: NodeJS.ProcessEnv;
}

interface GitExecOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly killSignal: "SIGKILL";
  readonly maxBuffer: number;
  readonly timeout: number;
}

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const GIT_STATUS_CAP = 10_000;
const UNMERGED_STATUS_PAIRS = new Set(["UU", "UD", "DU", "AA", "AU", "UA", "DD"]);
const BLOCKED_GIT_ENVIRONMENT_KEYS = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_OPTIONAL_LOCKS",
]);

export async function readTheaterGitStatus(
  theaterPath: string,
  deps: GitStatusDependencies = {},
): Promise<GitStatusResult> {
  const realpath = deps.realpath ?? ((target: string) => fs.realpath(target));
  const execGit = deps.execGit ?? executeGit;
  let theaterRootAbs: string;
  try {
    theaterRootAbs = await realpath(path.resolve(theaterPath));
  } catch (error) {
    throw mapFsError(error);
  }

  try {
    const options: GitExecOptions = {
      env: sanitizeGitEnvironment(deps.environment ?? process.env),
      killSignal: "SIGKILL",
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
    };
    const gitArgs = (args: readonly string[]) => [
      "-c",
      "core.fsmonitor=false",
      "--no-optional-locks",
      "-C",
      theaterRootAbs,
      ...args,
    ];
    const [prefixOutput, statusOutput] = await Promise.all([
      execGit(gitArgs(["rev-parse", "--show-prefix"]), options),
      execGit(gitArgs(["status", "--porcelain=v1", "-z", "--untracked-files=all"]), options),
    ]);
    const prefix = stripTrailingLineBreak(prefixOutput);
    const statuses = scopeGitStatusesToTheater(parseGitStatusPorcelainV1Z(statusOutput), prefix);
    const truncated = statuses.length > GIT_STATUS_CAP;
    return {
      ok: true,
      gitAvailable: true,
      statuses: statuses.slice(0, GIT_STATUS_CAP),
      ...(truncated ? { truncated: true as const } : {}),
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
  if (UNMERGED_STATUS_PAIRS.has(statusPair)) return "modified";
  if (statusPair.includes("D")) return "deleted";
  if ([...statusPair].some((status) => status === "A" || status === "M" || status === "R" || status === "C")) {
    return "modified";
  }
  return null;
}

function executeGit(args: readonly string[], options: GitExecOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        encoding: "utf8",
        env: options.env,
        killSignal: options.killSignal,
        maxBuffer: options.maxBuffer,
        shell: false,
        timeout: options.timeout,
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

function sanitizeGitEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    const normalizedKey = key.toUpperCase();
    if (
      BLOCKED_GIT_ENVIRONMENT_KEYS.has(normalizedKey)
      || normalizedKey.startsWith("GIT_CONFIG_KEY_")
      || normalizedKey.startsWith("GIT_CONFIG_VALUE_")
    ) continue;
    if (value !== undefined) sanitized[key] = value;
  }
  sanitized.GIT_OPTIONAL_LOCKS = "0";
  return sanitized;
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
