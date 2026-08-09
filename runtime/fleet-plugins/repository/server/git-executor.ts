import { spawn, type SpawnOptions } from "node:child_process";
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
  readonly stderr: string;
  readonly truncated: boolean;
  readonly stderrTruncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const STDERR_MAX_BUFFER = 1024 * 1024;
const PROBE_TIMEOUT_MS = 5_000;
const GIT_HARDENING_PREFIX = ["-c", "core.fsmonitor=false", "--no-optional-locks"] as const;

function sanitizeGitEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    const normalizedKey = key.toUpperCase();
    // GIT_* 전량 + askpass 프로그램 환경변수는 zero-click 실행 경로라 차단한다.
    if (normalizedKey.startsWith("GIT_") || normalizedKey === "LC_ALL" || normalizedKey === "SSH_ASKPASS" || normalizedKey === "SSH_ASKPASS_REQUIRE") continue;
    if (value !== undefined) sanitized[key] = value;
  }
  sanitized.GIT_OPTIONAL_LOCKS = "0";
  sanitized.GIT_TERMINAL_PROMPT = "0";
  // repo config으로 덮을 수 없는 default-deny transport allowlist — 알 수 없는
  // remote helper(`<vcs>::` URL, remote.<name>.vcs)의 zero-click 실행을 막는다.
  sanitized.GIT_ALLOW_PROTOCOL = "ssh:git:http:https:file";
  sanitized.LC_ALL = "C";
  return sanitized;
}

export function runGit(
  args: readonly string[],
  opts: { readonly cwd: string; readonly timeoutMs?: number; readonly maxBuffer?: number; readonly allowExitCodes?: readonly number[]; readonly signal?: AbortSignal },
): Promise<GitRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const hardenedArgs = [...GIT_HARDENING_PREFIX, ...args];

  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new GitExecutorError("timeout"));
      return;
    }
    let child;
    try {
      // Windows에서 자식 프로세스 콘솔 창이 깜빡이며 떴다 사라지는 현상 방지
      child = spawn("git", hardenedArgs, withHidden({
        cwd: opts.cwd,
        env: sanitizeGitEnvironment(process.env),
        shell: false,
      }));
    } catch (error) {
      // spawn 동기 예외에서도 ENOENT는 git 바이너리 미설치로 분류한다(방어적 처리).
      const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "git_unavailable" : "spawn_failed";
      reject(new GitExecutorError(code, String(error)));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let truncated = false;
    let stderrTruncated = false;
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
      if (stderrTruncated) return;
      const remaining = STDERR_MAX_BUFFER - stderrLen;
      if (chunk.length >= remaining) {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrLen += remaining;
        stderrTruncated = true;
      } else {
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
      }
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
          resolve({ stdout, stderr, truncated, stderrTruncated });
          return;
        }
        // 산문 매칭은 빠른 길일 뿐이다. git은 버전마다 다른 진단을 내며 — 새 git은 비-저장소
        // 경로에서 "not a git repository" 대신 pathspec 경고부터 낸다 — 그 문장이 없다고 저장소가
        // 있는 것은 아니다. 못 알아본 실패는 git에게 직접 물어 판정한다.
        if (stderr.toLowerCase().includes("not a git repository")) {
          reject(new GitExecutorError("no_git_repo", stderr, code ?? undefined));
          return;
        }
        isInsideRepository(opts.cwd).then((inside) => {
          reject(new GitExecutorError(inside ? "non_zero_exit" : "no_git_repo", stderr, code ?? undefined));
        });
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      resolve({ stdout, stderr, truncated, stderrTruncated });
    });
  });
}

// 저장소 여부를 git에게 직접 묻는다. 종료 코드만 보므로 git의 문구·로케일·버전에 흔들리지 않는다.
// 실패한 명령 뒤에서만 부르므로 정상 경로에는 추가 프로세스가 생기지 않는다. 판정할 수 없으면
// true를 돌려 원래 분류(non_zero_exit)를 유지한다 — 확신 없이 no_git_repo로 낮추지 않는다.
function isInsideRepository(cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (inside: boolean) => {
      if (settled) return;
      settled = true;
      resolve(inside);
    };
    try {
      const probeOptions: SpawnOptions = {
        cwd,
        env: sanitizeGitEnvironment(process.env),
        stdio: "ignore",
        shell: false,
      };
      const probe = spawn("git", [...GIT_HARDENING_PREFIX, "rev-parse", "--git-dir"], withHidden(probeOptions));
      const timer = setTimeout(() => {
        probe.kill("SIGKILL");
        done(true);
      }, PROBE_TIMEOUT_MS);
      timer.unref?.();
      probe.on("error", () => {
        clearTimeout(timer);
        done(true);
      });
      probe.on("close", (code) => {
        clearTimeout(timer);
        done(code === 0);
      });
    } catch {
      done(true);
    }
  });
}
