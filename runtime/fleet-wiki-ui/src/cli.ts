import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ASCII_FLEET_BANNER,
  FLEET_COMMAND,
  GRADIENT_COLORS,
  command,
  dim,
  option,
  paint,
  resolveColorEnabled,
  section,
  stripAnsi,
} from "./help-style.js";

import { openBrowser } from "./browser.js";
import { isProcessAlive, isProcessAliveWithStatus, lockFilePath, readLockFile, removeLockFile } from "./lock.js";
import type { FleetWikiLock } from "./lock.js";
import { resolveWorkspaceMemoryPaths } from "./paths.js";
import { isLockTrustworthyForRestart, isStaleLock } from "./stale.js";

export type RestartMode = "restart" | "reuse" | "abort";
export type CliMode = "run" | "stop" | "help";

export interface RestartDecision {
  mode: RestartMode;
  reason?: string;
}

export type HealthyLockWaitOptions =
  | { trust: "owned" }
  | { trust: "existing" };

export interface HealthyLockTrustDecision {
  trusted: boolean;
  reason?: string;
}

interface CliArgs {
  mode: CliMode;
  host?: string;
  port?: number;
}

export interface BuildWikiHelpTextOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
  readonly release?: string;
}

export interface OpenFleetWikiWorkspaceOptions {
  readonly cwd: string;
  readonly host?: string;
  readonly port?: number;
}

export interface OpenFleetWikiWorkspaceResult {
  readonly host: string;
  readonly pid: number;
  readonly port: number;
  readonly url: string;
}

export interface ProbeFleetWikiDaemonOptions {
  readonly cwd: string;
}

const DEFAULT_PORT = 3737;
const DEFAULT_HOST = "127.0.0.1";
const HEALTH_TIMEOUT_MS = 5000;
const HEALTH_INTERVAL_MS = 150;
const TRAMPOLINE_ENV = "FLEET_WIKI_TRAMPOLINED";
const SIGNAL_EXIT_FALLBACK_MS = 1000;
const HELP_BANNER_INDENT = "  ";
const DEFAULT_HELP_RELEASE = "local";
const RFC1123_HOSTNAME = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const IPV4_WILDCARD_HOST = "0.0.0.0";
const IPV4_LOOPBACK_HOST = "127.0.0.1";
const IPV6_WILDCARD_HOSTS = new Set(["::", "0:0:0:0:0:0:0:0"]);
const IPV6_LOOPBACK_HOST = "::1";

export function parseCliArgs(argv: string[]): CliArgs {
  const result: CliArgs = { mode: "run" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help") {
      result.mode = "help";
    } else if (arg === "--stop") {
      result.mode = "stop";
    } else if (arg === "--port") {
      const raw = argv[i + 1];
      if (!raw || raw.startsWith("--")) {
        process.stderr.write("--port requires a value\n");
        process.exit(1);
        return result;
      }
      i += 1;
      const port = Number(raw);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        process.stderr.write(`Invalid --port value: ${raw}\n`);
        process.exit(1);
        return result;
      }
      result.port = port;
    } else if (arg === "--host") {
      const raw = argv[i + 1];
      if (!raw || raw.startsWith("--")) {
        process.stderr.write("--host requires a value\n");
        process.exit(1);
        return result;
      }
      i += 1;
      result.host = parseHostValue(raw);
    } else if (arg.startsWith("--port=")) {
      const raw = arg.slice("--port=".length);
      const port = Number(raw);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        process.stderr.write(`Invalid --port value: ${raw}\n`);
        process.exit(1);
        return result;
      }
      result.port = port;
    } else if (arg.startsWith("--host=")) {
      const raw = arg.slice("--host=".length);
      result.host = parseHostValue(raw);
    } else if (arg.startsWith("--")) {
      process.stderr.write(`Unknown option: ${arg}\n`);
      process.exit(1);
      return result;
    }
  }
  return result;
}

export function buildWikiHelpText(options: BuildWikiHelpTextOptions = {}): string {
  const colorEnabled = resolveColorEnabled(options);
  const subtitle = `Fleet Wiki · ${options.release ?? DEFAULT_HELP_RELEASE}`;
  const lines = [
    ...ASCII_FLEET_BANNER.map(
      (line, index) => `${HELP_BANNER_INDENT}${paint(GRADIENT_COLORS[index] ?? FLEET_COMMAND, line, colorEnabled)}`,
    ),
    dim(subtitle, colorEnabled),
    "",
    section("USAGE", colorEnabled),
    `  ${command("fleet wiki", colorEnabled)} ${dim("[--host <addr>] [--port <port>] [--stop] [--help]", colorEnabled)}`,
    `  ${dim("Standalone binary:", colorEnabled)} ${command("fleet-wiki", colorEnabled)} ${dim("[--host <addr>] [--port <port>]", colorEnabled)}`,
    "",
    section("OPTIONS", colorEnabled),
    `  ${option("--host <addr>", colorEnabled)}   ${dim("Bind the daemon to an IP or RFC1123 hostname; non-loopback hosts expose GET reads on the LAN.", colorEnabled)}`,
    `  ${option("--port <port>", colorEnabled)}   ${dim("Set the local Fleet Wiki daemon port.", colorEnabled)}`,
    `  ${option("--stop", colorEnabled)}          ${dim("Stop the user's Fleet Wiki daemon.", colorEnabled)}`,
    `  ${option("--help", colorEnabled)}          ${dim("Show this help message and exit.", colorEnabled)}`,
    "",
    section("ENVIRONMENT", colorEnabled),
    `  ${option("FLEET_WIKI_PORT", colorEnabled)}             ${dim("Set the default port.", colorEnabled)}`,
    `  ${option("FLEET_WIKI_NO_AUTO_RESTART", colorEnabled)}  ${dim("Disable automatic restart of stale daemons.", colorEnabled)}`,
    "",
    section("EXAMPLES", colorEnabled),
    `  ${command("fleet wiki", colorEnabled)}`,
    `  ${command("fleet wiki --host 0.0.0.0", colorEnabled)} ${dim("# explicit LAN read-share; write/admin stay loopback-only", colorEnabled)}`,
    `  FLEET_WIKI_PORT=4040 ${command("fleet wiki", colorEnabled)}`,
    `  ${command("fleet wiki --stop", colorEnabled)}`,
    "",
  ];
  const text = lines.join("\n");
  return colorEnabled ? text : stripAnsi(text);
}

export function evaluateRestartDecision(
  existing: FleetWikiLock,
  cwd: string,
  health: { ok: boolean; cwd: string | null },
  noAutoRestart: boolean,
  host?: string,
  stale = false,
): RestartDecision {
  const trust = isLockTrustworthyForRestart(existing, cwd, health.cwd, host);
  if (!trust.trusted) {
    return { mode: "abort", reason: trust.reason };
  }
  if (noAutoRestart || !stale) {
    return { mode: "reuse" };
  }
  return { mode: "restart" };
}

export function evaluateHealthyLockTrust(
  lock: FleetWikiLock,
  health: { ok: boolean; cwd: string | null },
  options: HealthyLockWaitOptions,
  host?: string,
): HealthyLockTrustDecision {
  if (!health.ok) {
    return { trusted: false, reason: "health check failed" };
  }
  if (options.trust === "owned") {
    return { trusted: true };
  }
  const trust = isLockTrustworthyForRestart(lock, "", health.cwd, host);
  return trust.trusted ? { trusted: true } : { trusted: false, reason: trust.reason };
}

export async function openFleetWikiWorkspace(
  options: OpenFleetWikiWorkspaceOptions,
): Promise<OpenFleetWikiWorkspaceResult> {
  const cwd = path.resolve(options.cwd);
  const paths = resolveWorkspaceMemoryPaths(cwd);
  if (!(await directoryExists(paths.root))) {
    throw new Error("`.fleet/knowledge` 디렉토리를 찾을 수 없습니다. 워크스페이스 루트에서 실행하세요.");
  }

  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? configuredPort();
  const lockPath = lockFilePath();
  const lock = await ensureServer(cwd, lockPath, host, port);
  const workspace = await registerWorkspace(lock, cwd);
  const url = `${serverUrl(resolveBrowserOpenHost(lock.host), lock.port)}${workspace.urlPath}`;
  await openBrowser(url);
  return { host: lock.host, pid: lock.pid, port: lock.port, url };
}

export async function probeFleetWikiDaemon(
  _options: ProbeFleetWikiDaemonOptions,
): Promise<OpenFleetWikiWorkspaceResult | null> {
  const lock = await readLockFile(lockFilePath());
  if (!lock) {
    return null;
  }
  const health = await healthCheck(lock);
  if (!health.ok) {
    return null;
  }
  return {
    host: lock.host,
    pid: lock.pid,
    port: lock.port,
    url: serverUrl(resolveBrowserOpenHost(lock.host), lock.port),
  };
}

export async function main(): Promise<void> {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  if (cliArgs.mode === "help") {
    printHelp();
    return;
  }

  const cwd = path.resolve(process.cwd());
  if (cliArgs.mode === "stop") {
    await stopDaemon();
    return;
  }

  await openFleetWikiWorkspace({ cwd, host: cliArgs.host, port: cliArgs.port });
}

export function findLocalCliMjs(cwd: string): string | null {
  let currentDir = path.resolve(cwd);
  while (true) {
    const candidate = path.join(currentDir, "runtime", "fleet-wiki-ui", "dist", "cli.mjs");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export async function stopDaemon(): Promise<void> {
  const lockPath = lockFilePath();
  const lock = await readLockFile(lockPath);
  if (!lock) {
    process.stderr.write("실행 중인 Fleet Wiki daemon lock을 찾지 못했습니다.\n");
    return;
  }
  if (!Number.isInteger(lock.pid) || lock.pid <= 1) {
    throw new Error(`lock에 비정상 PID가 기록되어 있습니다(pid=${String(lock.pid)}). 안전을 위해 종료를 건너뜁니다.`);
  }
  if (!isProcessAlive(lock.pid)) {
    await removeLockFile(lockPath);
    process.stderr.write(`Fleet Wiki daemon(pid=${lock.pid})은 이미 종료되어 있습니다.\n`);
    return;
  }
  await killServer(lock.pid);
  if (isProcessAlive(lock.pid)) {
    throw new Error(`Fleet Wiki daemon(pid=${lock.pid})을 종료하지 못했습니다.`);
  }
  await removeLockFile(lockPath);
}

export function formatHostForUrl(host: string): string {
  return net.isIPv6(host) ? `[${host}]` : host;
}

export function serverUrl(host: string, port: number): string {
  return `http://${formatHostForUrl(host)}:${port}`;
}

export function resolveLocalControlHost(bindHost: string): string {
  if (bindHost === IPV4_WILDCARD_HOST) return IPV4_LOOPBACK_HOST;
  if (IPV6_WILDCARD_HOSTS.has(bindHost)) return IPV6_LOOPBACK_HOST;
  if (!isLoopbackHost(bindHost)) return IPV4_LOOPBACK_HOST;
  return bindHost;
}

export function resolveBrowserOpenHost(bindHost: string): string {
  if (bindHost === IPV4_WILDCARD_HOST) return IPV4_LOOPBACK_HOST;
  if (IPV6_WILDCARD_HOSTS.has(bindHost)) return IPV6_LOOPBACK_HOST;
  return bindHost;
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    return (await stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

function printHelp(): void {
  process.stdout.write(buildWikiHelpText({ env: process.env, isTTY: process.stdout.isTTY }));
}

async function ensureServer(cwd: string, lockPath: string, host: string, port: number): Promise<FleetWikiLock> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await readLockFile(lockPath);
    if (existing && isProcessAlive(existing.pid)) {
      if (existing.port > 0) {
        const health = await healthCheck(existing);
        if (health.ok) {
          const decision = evaluateRestartDecision(
            existing, cwd, health,
            Boolean(process.env.FLEET_WIKI_NO_AUTO_RESTART),
            host,
            await isExistingDaemonStale(existing),
          );
          if (decision.mode === "reuse") {
            return existing;
          }
          if (decision.mode === "abort") {
            throw new Error(
              `기존 lock의 신뢰 검증 실패(${decision.reason}) — 재기동할 수 없습니다. ` +
              `lock 파일을 수동으로 삭제한 후 다시 실행하세요.`,
            );
          }
          process.stderr.write(`기존 서버(pid=${existing.pid})를 종료 후 재기동합니다.\n`);
          await killServer(existing.pid);
          await removeLockFile(lockPath);
          continue;
        }
      }
      return waitForHealthyLock(lockPath, { trust: "existing" }, host);
    }
    if (existing) {
      await removeLockFile(lockPath);
    }
    spawnDetachedServer(cwd, lockPath, host, port);
    return waitForHealthyLock(lockPath, { trust: "existing" }, host);
  }
  throw new Error("Fleet Wiki 서버 락을 획득하지 못했습니다.");
}

function spawnDetachedServer(cwd: string, lockPath: string, host: string, port: number): void {
  const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
  const child = spawn(process.execPath, [serverPath, "--cwd", cwd, "--lock", lockPath, "--host", host, "--port", String(port)], {
    cwd,
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();
}

async function waitForHealthyLock(lockPath: string, options: HealthyLockWaitOptions, host?: string): Promise<FleetWikiLock> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < HEALTH_TIMEOUT_MS) {
    const lock = await readLockFile(lockPath);
    if (lock && isProcessAlive(lock.pid)) {
      const health = await healthCheck(lock);
      if (health.ok) {
        const trust = evaluateHealthyLockTrust(lock, health, options, host);
        if (!trust.trusted) {
          throw new Error(
            `기존 lock의 신뢰 검증 실패(${trust.reason}) — 재사용할 수 없습니다. ` +
            `lock 파일을 수동으로 삭제한 후 다시 실행하세요.`,
          );
        }
        return lock;
      }
    }
    await sleep(HEALTH_INTERVAL_MS);
  }
  throw new Error("Fleet Wiki 서버 헬스체크가 5초 안에 통과하지 못했습니다.");
}

async function healthCheck(lock: FleetWikiLock): Promise<{ ok: boolean; cwd: string | null }> {
  try {
    const response = await fetch(`${serverUrl(resolveLocalControlHost(lock.host), lock.port)}/api/health`);
    if (response.status !== 200) return { ok: false, cwd: null };
    const body = await response.json() as { ok?: boolean; cwd?: string };
    return { ok: body.ok === true, cwd: typeof body.cwd === "string" ? body.cwd : null };
  } catch {
    return { ok: false, cwd: null };
  }
}

async function isExistingDaemonStale(lock: FleetWikiLock): Promise<boolean> {
  try {
    const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
    const serverStat = await stat(serverPath);
    return isStaleLock(lock, serverStat.mtimeMs);
  } catch {
    return false;
  }
}

async function registerWorkspace(lock: FleetWikiLock, cwd: string): Promise<{ id: string; urlPath: string }> {
  const response = await fetch(`${serverUrl(resolveLocalControlHost(lock.host), lock.port)}/api/admin/workspaces`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${lock.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ cwd }),
  });
  if (!response.ok) {
    throw new Error(`Fleet Wiki workspace 등록 실패: HTTP ${response.status}`);
  }
  const body = await response.json() as { workspace?: { id?: string; urlPath?: string } };
  if (!body.workspace?.id || !body.workspace.urlPath) {
    throw new Error("Fleet Wiki workspace 등록 응답이 올바르지 않습니다.");
  }
  return { id: body.workspace.id, urlPath: body.workspace.urlPath };
}

function configuredPort(): number {
  const rawPort = process.env.FLEET_WIKI_PORT;
  if (!rawPort) return DEFAULT_PORT;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`FLEET_WIKI_PORT 값이 올바르지 않습니다: ${rawPort}`);
  }
  return port;
}

function parseHostValue(raw: string): string {
  if (!isValidHostValue(raw)) {
    process.stderr.write(`Invalid --host value: ${raw}\n`);
    process.exit(1);
    return raw;
  }
  return raw;
}

function isValidHostValue(raw: string): boolean {
  if (!raw) return false;
  if (net.isIP(raw) !== 0) return true;
  return RFC1123_HOSTNAME.test(raw);
}

function isLoopbackHost(host: string): boolean {
  return host === IPV4_LOOPBACK_HOST || host === IPV6_LOOPBACK_HOST || host === "localhost";
}

async function killServer(pid: number): Promise<void> {
  if (!signalProcess(pid, "SIGTERM")) {
    return;
  }
  await sleep(200);
  if (isProcessAliveWithStatus(pid).alive) {
    signalProcess(pid, "SIGKILL");
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return false;
    }
    if (isNodeError(error) && error.code === "EPERM") {
      throw new Error(`Fleet Wiki daemon(pid=${pid})에 ${signal} 권한이 없습니다.`);
    }
    throw error;
  }
}

function maybeTrampolineToLocalCli(): void {
  if (process.env[TRAMPOLINE_ENV] === "1") return;
  const localCli = findLocalCliMjs(process.cwd());
  if (!localCli) return;

  const currentCli = fileURLToPath(import.meta.url);
  if (path.resolve(localCli) === path.resolve(currentCli)) return;
  if (!isSameGitCommonDir(localCli, currentCli)) return;

  const cyan = process.stderr.isTTY ? "\x1b[36m" : "";
  const reset = process.stderr.isTTY ? "\x1b[0m" : "";
  process.stderr.write(`${cyan}fleet-wiki: redirecting to ${localCli}${reset}\n`);

  const result = spawnSync(process.execPath, [localCli, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, [TRAMPOLINE_ENV]: "1" },
  });
  if (result.error) {
    process.stderr.write(`fleet-wiki: trampoline failed: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    setTimeout(() => process.exit(1), SIGNAL_EXIT_FALLBACK_MS);
    return;
  }
  process.exit(result.status ?? 1);
}

function isSameGitCommonDir(candidateCli: string, currentCli: string): boolean {
  const candidateCommonDir = gitCommonDir(path.dirname(candidateCli));
  const currentCommonDir = gitCommonDir(path.dirname(currentCli));
  return candidateCommonDir !== null && currentCommonDir !== null && candidateCommonDir === currentCommonDir;
}

function gitCommonDir(cwd: string): string | null {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return null;
  }
  const rawCommonDir = result.stdout.trim();
  if (!rawCommonDir) {
    return null;
  }
  return path.resolve(cwd, rawCommonDir);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  maybeTrampolineToLocalCli();
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
