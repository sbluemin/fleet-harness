import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ─── types ───────────────────────────────────────────────────────────────────

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface CliExecutorOpts {
  readonly cwd: string;
  readonly timeout: number;
  readonly onChunk?: (chunk: string) => void;
  readonly onBootstrap?: (line: string) => void;
}

export type CliExecutor = (
  args: string[],
  opts: CliExecutorOpts,
) => Promise<CliResult>;

// ─── constants ───────────────────────────────────────────────────────────────

export const SKILLS_VERSION = "1.5.14";

const SKILLS_PACKAGE = "skills";
const BOOTSTRAP_TIMEOUT_MS = 60_000;
const ANSI_RE = /(\x9B|\x1B\[)[0-?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[^[\x9B\]]|\x9C/g;
const WARMUP_LINE = "Preparing skills CLI (first run may take a moment)…";

// ─── module state ─────────────────────────────────────────────────────────────

let _cliMjsPath: string | null = null;
let _bootstrapPromise: Promise<string> | null = null;

// ─── functions ───────────────────────────────────────────────────────────────

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export function defaultCwd(): string {
  return os.homedir();
}

export function resetCliStateForTest(): void {
  _cliMjsPath = null;
  _bootstrapPromise = null;
}

async function runNpmInstall(cliHome: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = execFile(
      "npm",
      [
        "install",
        `${SKILLS_PACKAGE}@${SKILLS_VERSION}`,
        "--prefix", cliHome,
        "--global=false",
        "--force=false",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
      ],
      { shell: false, timeout: BOOTSTRAP_TIMEOUT_MS },
    );
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

async function ensureCliMjs(cliHome: string, onBootstrap?: (line: string) => void): Promise<string> {
  if (_cliMjsPath) return _cliMjsPath;
  if (_bootstrapPromise) return _bootstrapPromise;

  _bootstrapPromise = (async () => {
    const mjsPath = path.join(cliHome, "node_modules", SKILLS_PACKAGE, "bin", "cli.mjs");
    const pkgPath = path.join(cliHome, "node_modules", SKILLS_PACKAGE, "package.json");

    let needsInstall = true;
    try {
      const raw = await fs.readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(raw) as { version?: string };
      if (pkg.version === SKILLS_VERSION) needsInstall = false;
    } catch {
      // 부재/파싱 실패 → 설치 필요
    }

    if (needsInstall) {
      onBootstrap?.(WARMUP_LINE);
      await fs.mkdir(cliHome, { recursive: true });
      await runNpmInstall(cliHome);
    }

    _cliMjsPath = mjsPath;
    return mjsPath;
  })();

  // 실패한 부트스트랩을 캐시하면 일시적 네트워크 오류가 콘솔 재시작 전까지
  // 영구 실패로 고착된다 — 정착 후 항상 비워 다음 호출이 재시도할 수 있게 한다.
  // (호출자에게는 원본 promise가 반환되어 에러가 전파되고, 이 파생 체인은
  // 리셋 전용이므로 reject를 흡수해 unhandled rejection을 막는다.)
  _bootstrapPromise
    .finally(() => {
      _bootstrapPromise = null;
    })
    .catch(() => {});

  return _bootstrapPromise;
}

export function createDefaultExecutor(cliHome: string): CliExecutor {
  return (args, { cwd, timeout, onChunk, onBootstrap }) =>
    new Promise((resolve, reject) => {
      void ensureCliMjs(cliHome, onBootstrap)
        .then((mjsPath) => {
          const child = execFile(
            process.execPath,
            [mjsPath, ...args],
            { shell: false, cwd, timeout, maxBuffer: 10 * 1024 * 1024 },
          );

          const stdoutParts: string[] = [];
          const stderrParts: string[] = [];

          child.stdout?.on("data", (chunk: Buffer) => {
            const s = chunk.toString();
            stdoutParts.push(s);
            onChunk?.(s);
          });

          child.stderr?.on("data", (chunk: Buffer) => {
            const s = chunk.toString();
            stderrParts.push(s);
            onChunk?.(s);
          });

          child.on("close", (code) => {
            resolve({
              stdout: stdoutParts.join(""),
              stderr: stderrParts.join(""),
              exitCode: code ?? 1,
            });
          });

          child.on("error", reject);
        })
        .catch(reject);
    });
}
