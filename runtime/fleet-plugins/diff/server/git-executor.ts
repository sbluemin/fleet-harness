import { spawn } from "node:child_process";

export type GitErrorCode = "timeout" | "non_zero_exit" | "spawn_failed" | "no_git_repo";

export class GitExecutorError extends Error {
  readonly code: GitErrorCode;
  readonly exitCode?: number;
  readonly stderr: string;

  constructor(code: GitErrorCode, stderr = "", exitCode?: number) {
    super(code);
    this.name = "GitExecutorError";
    this.code = code;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export interface GitRunResult {
  readonly stdout: string;
  readonly truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

export function runGit(
  args: readonly string[],
  opts: { readonly cwd: string; readonly timeoutMs?: number; readonly maxBuffer?: number; readonly allowExitCodes?: readonly number[] },
): Promise<GitRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;

  return new Promise((resolve, reject) => {
    let child;
    try {
      // Windows에서 자식 프로세스 콘솔 창이 깜빡이며 떴다 사라지는 현상 방지
      child = spawn("git", args as string[], { cwd: opts.cwd, shell: false, windowsHide: true });
    } catch (error) {
      reject(new GitExecutorError("spawn_failed", String(error)));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      reject(new GitExecutorError("timeout"));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const remaining = maxBuffer - stdoutLen;
      if (chunk.length >= remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutLen += remaining;
        truncated = true;
      } else {
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new GitExecutorError("spawn_failed", error.message));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        if (code !== null && (opts.allowExitCodes?.includes(code) ?? false)) {
          const stdout = Buffer.concat(stdoutChunks).toString("utf8");
          resolve({ stdout, truncated });
          return;
        }
        const isNoRepo = stderr.includes("not a git repository");
        reject(new GitExecutorError(isNoRepo ? "no_git_repo" : "non_zero_exit", stderr, code ?? undefined));
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      resolve({ stdout, truncated });
    });
  });
}
