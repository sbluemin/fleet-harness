import { spawn } from "node:child_process";
import { withHidden } from "@dotobokuri/core-process";

export type GitErrorCode = "timeout" | "non_zero_exit" | "spawn_failed" | "no_git_repo" | "git_unavailable";

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
  opts: { readonly cwd: string; readonly timeoutMs?: number; readonly maxBuffer?: number; readonly allowExitCodes?: readonly number[]; readonly signal?: AbortSignal },
): Promise<GitRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;

  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new GitExecutorError("timeout"));
      return;
    }
    let child;
    try {
      // Windows에서 자식 프로세스 콘솔 창이 깜빡이며 떴다 사라지는 현상 방지
      child = spawn("git", args as string[], withHidden({ cwd: opts.cwd, shell: false }));
    } catch (error) {
      // spawn 동기 예외에서도 ENOENT는 git 바이너리 미설치로 분류한다(방어적 처리).
      const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "git_unavailable" : "spawn_failed";
      reject(new GitExecutorError(code, String(error)));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let truncated = false;
    let timedOut = false;

    const abort = () => {
      timedOut = true;
      child.kill("SIGTERM");
      reject(new GitExecutorError("timeout"));
    };
    opts.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      abort();
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
    };

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
      cleanup();
      // ENOENT = git 바이너리가 PATH에 없음; 나머지는 일반 spawn 실패
      const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "git_unavailable" : "spawn_failed";
      reject(new GitExecutorError(code, error.message));
    });

    child.on("close", (code) => {
      cleanup();
      if (timedOut) return;
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        if (code !== null && (opts.allowExitCodes?.includes(code) ?? false)) {
          const stdout = Buffer.concat(stdoutChunks).toString("utf8");
          resolve({ stdout, truncated });
          return;
        }
        // macOS git diff는 "Not a git repository"(대문자 N)로 출력하므로 대소문자 무관하게 비교
        const isNoRepo = stderr.toLowerCase().includes("not a git repository");
        reject(new GitExecutorError(isNoRepo ? "no_git_repo" : "non_zero_exit", stderr, code ?? undefined));
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      resolve({ stdout, truncated });
    });
  });
}
