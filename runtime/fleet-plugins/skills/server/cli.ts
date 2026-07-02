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
    _bootstrapPromise = null;
    return mjsPath;
  })();

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
