import { execFile } from "node:child_process";

export interface WorkspaceChangeScanner {
  snapshot(cwd: string): Promise<readonly WorkspaceChangeSnapshotEntry[] | null>;
}

export interface WorkspaceChangeSnapshotEntry {
  readonly status: string;
  readonly path: string;
  readonly contentHash?: string;
}

const GIT_STATUS_TIMEOUT_MS = 4_000;
const GIT_STATUS_MAX_BUFFER = 1024 * 1024;
const GIT_HASH_TIMEOUT_MS = 4_000;
const GIT_HASH_MAX_BUFFER = 1024 * 1024;

export function createWorkspaceChangeScanner(): WorkspaceChangeScanner {
  return {
    async snapshot(cwd) {
      try {
        const stdout = await execGitStatus(cwd);
        const entries = parseGitStatusPorcelainZ(stdout);
        if (!entries) return null;
        return await enrichEntriesWithContentHashes(cwd, entries);
      } catch {
        return null;
      }
    },
  };
}

export function parseGitStatusPorcelainZ(output: string): WorkspaceChangeSnapshotEntry[] | null {
  try {
    const tokens = output.split("\0").filter((token) => token.length > 0);
    const entries: WorkspaceChangeSnapshotEntry[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      if (token.length < 4) continue;
      const status = token.slice(0, 2).trim();
      const filePath = token.slice(3);
      if (!status || !filePath) continue;
      if (status.startsWith("R") || status.startsWith("C")) {
        const oldPath = tokens[i + 1];
        i += 1;
        if (!oldPath) return null;
        entries.push({ status, path: `${oldPath} -> ${filePath}` });
      } else {
        entries.push({ status, path: filePath });
      }
    }
    return entries;
  } catch {
    return null;
  }
}

async function enrichEntriesWithContentHashes(
  cwd: string,
  entries: readonly WorkspaceChangeSnapshotEntry[],
): Promise<WorkspaceChangeSnapshotEntry[]> {
  const hashPaths = entries.map((entry) => hashablePath(entry)).filter((filePath): filePath is string => Boolean(filePath));
  if (hashPaths.length === 0) return [...entries];

  try {
    const stdout = await execGitHashObject(cwd, hashPaths);
    const hashes = stdout.split(/\r?\n/).filter((line) => line.length > 0);
    if (hashes.length !== hashPaths.length) return [...entries];
    const hashByPath = new Map(hashPaths.map((filePath, index) => [filePath, hashes[index]!]));
    return entries.map((entry) => {
      const contentHash = hashByPath.get(hashablePath(entry) ?? "");
      return contentHash ? { ...entry, contentHash } : entry;
    });
  } catch {
    return [...entries];
  }
}

function execGitStatus(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: GIT_STATUS_MAX_BUFFER,
        timeout: GIT_STATUS_TIMEOUT_MS,
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

function execGitHashObject(cwd: string, paths: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["hash-object", "--stdin-paths"],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: GIT_HASH_MAX_BUFFER,
        timeout: GIT_HASH_TIMEOUT_MS,
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
    child.stdin?.end(`${paths.join("\n")}\n`);
  });
}

function hashablePath(entry: WorkspaceChangeSnapshotEntry): string | null {
  if (entry.status === "D") return null;
  const filePath = entry.path.includes(" -> ") ? entry.path.split(" -> ").at(-1)! : entry.path;
  if (!filePath || filePath.includes("\n")) return null;
  return filePath;
}
