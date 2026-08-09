import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolvePathBinary } from "@dotobokuri/core-process";
import { withHidden } from "@dotobokuri/core-process";

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

// Windows에서 `npm`은 `npm.cmd` 셸 심(shim)이라 execFile(shell:false)로 직접 못 띄운다
// (ENOENT, 패치된 Node에서는 .cmd 직접 spawn이 EINVAL). core-agent의 resolvePathBinary가
// PATH/PATHEXT 탐색 + `cmd.exe /d /s /c call <npm.cmd>` 래핑을 담당한다 — terminal 플러그인과
// 동일한 크로스플랫폼 정공법. POSIX는 `npm`이 그대로 실행되므로 변환하지 않는다.
export function resolveNpmCommand(
  npmArgs: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[] } {
  if (platform !== "win32") return { file: "npm", args: npmArgs };
  const resolved = resolvePathBinary("npm", env, { platform });
  if (!resolved) throw new Error("npm binary not found on PATH");
  return { file: resolved.bin, args: [...resolved.prefixArgs, ...npmArgs] };
}

async function runNpmInstall(cliHome: string): Promise<void> {
  const { file, args } = resolveNpmCommand([
    "install",
    `${SKILLS_PACKAGE}@${SKILLS_VERSION}`,
    "--prefix", cliHome,
    "--global=false",
    "--force=false",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
  ]);
  return new Promise<void>((resolve, reject) => {
    const child = execFile(
      file,
      args,
      // windowsHide: GUI 콘솔에서 하위 프로세스(cmd.exe 심 래퍼) 콘솔 창이 순간 표시되는 것을 막는다.
      withHidden({ shell: false, timeout: BOOTSTRAP_TIMEOUT_MS }),
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
            // windowsHide: GUI 콘솔에서 하위 node.exe 콘솔 창이 순간 표시되는 것을 막는다.
            withHidden({ shell: false, cwd, timeout, maxBuffer: 10 * 1024 * 1024 }),
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
