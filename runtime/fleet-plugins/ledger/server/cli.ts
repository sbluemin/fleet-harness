import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { resolvePathBinary } from "@dotobokuri/core-process";
import { withHidden } from "@dotobokuri/core-process";

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface CliExecutorOpts {
  readonly cwd: string;
  readonly timeout: number;
}

export type CliExecutor = (args: readonly string[], opts: CliExecutorOpts) => Promise<CliResult>;
export type InstallExecutor = (
  file: string,
  args: readonly string[],
  timeout: number,
  env: NodeJS.ProcessEnv,
) => Promise<void>;

export const TOKSCALE_VERSION = "4.7.0";
export const TOKSCALE_PACKAGE = "tokscale";
export const TOKSCALE_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const PROCESS_KILL_GRACE_MS = 1_000;
const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org/";

let _binPath: string | null = null;
let _bootstrapPromise: Promise<string> | null = null;

export function resetCliStateForTest(): void {
  _binPath = null;
  _bootstrapPromise = null;
}

export function resolveNpmCommand(
  npmArgs: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[] } {
  if (platform !== "win32") return { file: "npm", args: [...npmArgs] };
  const resolved = resolvePathBinary("npm", env, { platform });
  if (!resolved) throw new Error("npm binary not found on PATH");
  return { file: resolved.bin, args: [...resolved.prefixArgs, ...npmArgs] };
}

export function createNpmInstallEnv(cliHome: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "TEMP", "TMP"]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  // npmrc·registry·NODE_OPTIONS를 상속하면 Console 권한의 bootstrap이 사용자 설정이나
  // 조작된 레지스트리의 코드 실행 경로가 된다. npm이 필요한 최소 OS 환경만 유지한다.
  env.npm_config_registry = OFFICIAL_NPM_REGISTRY;
  env.npm_config_userconfig = path.join(cliHome, ".npmrc-disabled-user");
  env.npm_config_globalconfig = path.join(cliHome, ".npmrc-disabled-global");
  env.npm_config_cache = path.join(cliHome, ".npm-cache");
  return env;
}

const defaultInstallExecutor: InstallExecutor = (file, args, timeout, env) =>
  new Promise<void>((resolve, reject) => {
    const child = execFile(file, [...args], withHidden({ shell: false, timeout, env }));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install exited with code ${code}`));
    });
    child.on("error", reject);
  });

function isContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function resolveSafeTokscaleBin(cliHome: string): Promise<string | null> {
  const binPath = path.join(cliHome, "node_modules", TOKSCALE_PACKAGE, "bin.js");
  try {
    const stat = await fs.lstat(binPath);
    if (!stat.isFile()) return null;
    const [realCliHome, realBinPath] = await Promise.all([fs.realpath(cliHome), fs.realpath(binPath)]);
    return isContainedPath(realCliHome, realBinPath) ? realBinPath : null;
  } catch {
    return null;
  }
}

export async function hasPinnedTokscale(cliHome: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(cliHome, "node_modules", TOKSCALE_PACKAGE, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { readonly version?: unknown };
    return pkg.version === TOKSCALE_VERSION && await resolveSafeTokscaleBin(cliHome) !== null;
  } catch {
    return false;
  }
}

export function ensureTokscaleBin(
  cliHome: string,
  installExecutor: InstallExecutor = defaultInstallExecutor,
): Promise<string> {
  if (_binPath) {
    return resolveSafeTokscaleBin(cliHome).then((validated) => {
      if (validated) {
        _binPath = validated;
        return validated;
      }
      _binPath = null;
      return ensureTokscaleBin(cliHome, installExecutor);
    });
  }
  if (_bootstrapPromise) return _bootstrapPromise;

  _bootstrapPromise = (async () => {
    if (!await hasPinnedTokscale(cliHome)) {
      await fs.mkdir(cliHome, { recursive: true });
      const command = resolveNpmCommand([
        "install",
        `${TOKSCALE_PACKAGE}@${TOKSCALE_VERSION}`,
        "--prefix", cliHome,
        "--global=false",
        "--force=false",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
      ]);
      await installExecutor(
        command.file,
        command.args,
        TOKSCALE_TIMEOUT_MS,
        createNpmInstallEnv(cliHome),
      );
    }
    if (!await hasPinnedTokscale(cliHome)) {
      throw new Error("tokscale installation failed validation");
    }
    const binPath = await resolveSafeTokscaleBin(cliHome);
    if (!binPath) throw new Error("tokscale executable failed containment validation");
    _binPath = binPath;
    return binPath;
  })();

  _bootstrapPromise
    .finally(() => {
      _bootstrapPromise = null;
    })
    .catch(() => {});

  return _bootstrapPromise;
}

export function createDefaultExecutor(cliHome: string): CliExecutor {
  return async (args, { cwd, timeout }) => {
    const binPath = await ensureTokscaleBin(cliHome);
    return new Promise<CliResult>((resolve, reject) => {
      const spawnOptions: SpawnOptions = withHidden({
        shell: false,
        cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const child = spawn(
        process.execPath,
        [binPath, ...args],
        spawnOptions,
      );
      const stdoutParts: string[] = [];
      const stderrParts: string[] = [];
      let bufferedBytes = 0;
      let settled = false;
      let terminationStarted = false;
      const beginTermination = () => {
        if (terminationStarted) return;
        terminationStarted = true;
        terminateProcessTree(child);
        const killEscalation = setTimeout(
          () => forceKillProcessTree(child),
          PROCESS_KILL_GRACE_MS,
        );
        killEscalation.unref?.();
      };
      const timeoutTimer = setTimeout(beginTermination, timeout);
      timeoutTimer.unref?.();
      const append = (parts: string[], chunk: Buffer) => {
        bufferedBytes += chunk.length;
        if (bufferedBytes > MAX_BUFFER_BYTES) {
          beginTermination();
          return;
        }
        parts.push(chunk.toString());
      };
      child.stdout?.on("data", (chunk: Buffer) => append(stdoutParts, chunk));
      child.stderr?.on("data", (chunk: Buffer) => append(stderrParts, chunk));
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        resolve({
          stdout: stdoutParts.join(""),
          stderr: stderrParts.join(""),
          exitCode: code ?? 1,
        });
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        reject(error);
      });
    });
  };
}

function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(child.pid), "/T"], withHidden({ shell: false }), () => {});
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function forceKillProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], withHidden({ shell: false }), () => {});
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
