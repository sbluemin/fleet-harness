import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolvePathBinary } from "@fleet-console/process";
import { withHidden } from "@fleet-console/process";
import type { FleetPluginOwnedProcess, FleetPluginProcessesHost } from "@fleet-console/sdk/plugin";

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

const SKILLS_VERSION = "1.5.14";

const SKILLS_PACKAGE = "skills";
const BOOTSTRAP_TIMEOUT_MS = 60_000;
const CLI_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const ANSI_RE = /(\x9B|\x1B\[)[0-?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[^[\x9B\]]|\x9C/g;
const WARMUP_LINE = "Preparing skills CLI (first run may take a moment)…";

// ─── module state ─────────────────────────────────────────────────────────────

let _cliMjsPath: string | null = null;
let _bootstrapPromise: Promise<string> | null = null;

// ─── functions ───────────────────────────────────────────────────────────────

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * 전역 범위의 기준 홈. Console이 띄우는 Claude 자식과 같은 환경(`HOME`)을 따른다 — 패널이 보여
 * 주는 전역 스킬이 그 세션이 실제로 싣는 스킬과 달라지지 않게 하려는 것이다. 개발 격리는 Fleet
 * 상태만 옮기고 Agent 상태는 옮기지 않으므로(docs/fleet-development-reference.md §5), 전역 범위를
 * 격리하려면 `HOME`과 `CLAUDE_CONFIG_DIR`을 함께 바꿔 띄운다.
 */
export function defaultCwd(): string {
  return os.homedir();
}

/**
 * Claude Code의 사용자 설정 디렉터리. 전역 Claude 스킬은 `<이 경로>/skills`에 놓인다.
 * skills CLI(`CLAUDE_CONFIG_DIR?.trim() || ~/.claude`)와 같은 규칙이어야 두 쪽이 한 폴더를 본다.
 */
export function claudeConfigDir(): string {
  const configured = process.env["CLAUDE_CONFIG_DIR"]?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".claude");
}

/**
 * CLI 자식 환경. 설치 텔레메트리(출처·스킬 이름을 add-skill.vercel.sh로 보냄)는 기본으로 끈다 —
 * 사용자가 켠 적 없는 외부 전송을 Console이 대신 켜 두지 않는다. 나머지는 Console 환경을 그대로
 * 물려준다(`HOME`·`CLAUDE_CONFIG_DIR`·`CODEX_HOME`·`XDG_CONFIG_HOME`이 CLI의 경로를 정한다).
 */
export function cliChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, DISABLE_TELEMETRY: "1" };
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

async function runNpmInstall(cliHome: string, processes?: FleetPluginProcessesHost): Promise<void> {
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
    const child = processes
      ? bounded(processes.spawnOwned({ command: file, args }), BOOTSTRAP_TIMEOUT_MS)
      : execFile(
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

/**
 * What execFile gave the host-owned child: it is ended (with everything it started, through `killGroup`) once it runs
 * past `timeoutMs` or prints more than `maxBuffer` bytes, and its output is always read so it never blocks on a full pipe.
 * The Console ends it anyway if the Console itself ends first.
 */
function bounded(child: FleetPluginOwnedProcess, timeoutMs: number, maxBuffer = CLI_MAX_BUFFER_BYTES): FleetPluginOwnedProcess {
  let bytes = 0;
  const stop = () => { child.killGroup("SIGTERM"); };
  const timer = setTimeout(stop, timeoutMs);
  timer.unref?.();
  const count = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > maxBuffer) stop();
  };
  child.stdout?.on("data", count);
  child.stderr?.on("data", count);
  child.on("close", () => clearTimeout(timer));
  child.on("error", () => clearTimeout(timer));
  return child;
}

async function ensureCliMjs(cliHome: string, onBootstrap?: (line: string) => void, processes?: FleetPluginProcessesHost): Promise<string> {
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
      await runNpmInstall(cliHome, processes);
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

/**
 * Runs the skills CLI. With the host's owned-process port (`ctx.host.processes`) the CLI and its npm bootstrap are
 * children the Console ends however the Console ends, including a crash or a kill while a registry call hangs; without it
 * (an older Console, a test) they are execFile children as before.
 */
export function createDefaultExecutor(cliHome: string, processes?: FleetPluginProcessesHost): CliExecutor {
  return (args, { cwd, timeout, onChunk, onBootstrap }) =>
    new Promise((resolve, reject) => {
      void ensureCliMjs(cliHome, onBootstrap, processes)
        .then((mjsPath) => {
          const child = processes
            ? bounded(processes.spawnOwned({ command: process.execPath, args: [mjsPath, ...args], cwd, env: cliChildEnv() }), timeout)
            : execFile(
              process.execPath,
              [mjsPath, ...args],
              // windowsHide: GUI 콘솔에서 하위 node.exe 콘솔 창이 순간 표시되는 것을 막는다.
              withHidden({ shell: false, cwd, timeout, maxBuffer: CLI_MAX_BUFFER_BYTES, env: cliChildEnv() }),
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
