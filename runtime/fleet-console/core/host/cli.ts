import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { withHidden } from "@dotobokuri/core-process";

import type { ConsoleLockPayload } from "./console-contract-types.js";
import { openBrowser, type OpenBrowserDeps } from "./browser.js";
import { createConsoleHealthClient } from "./health.js";
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
import { createConsoleLock } from "./lock.js";
import { createConsolePaths } from "./paths.js";
import { createConsoleServer } from "./server.js";
import { createConsoleStalePolicy } from "./stale.js";

export type ConsoleCliMode = "start" | "stop" | "restart" | "status" | "help";

export interface ConsoleDaemonLifecycleDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly serverModulePath?: string;
  readonly spawnDetached?: (execPath: string, args: readonly string[], options: { readonly detached: true; readonly env: NodeJS.ProcessEnv; readonly stdio: "ignore"; readonly windowsHide: true }) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly health?: ReturnType<typeof createConsoleHealthClient>;
}

export interface OpenFleetConsoleDeps {
  readonly lifecycle?: Pick<ReturnType<typeof createConsoleDaemonLifecycle>, "ensureDaemon" | "probe">;
  readonly openBrowser?: (url: string, deps?: OpenBrowserDeps) => void;
}

export interface OpenFleetConsoleResult {
  readonly url: string;
}

export interface ConsoleStatusDeps {
  readonly lifecycle?: Pick<ReturnType<typeof createConsoleDaemonLifecycle>, "probe">;
}

export interface ConsoleStopDeps {
  readonly lifecycle?: Pick<ReturnType<typeof createConsoleDaemonLifecycle>, "stop">;
}

export type ConsoleHookCommand =
  | { readonly command: "capture-session"; readonly provider: "claude" | "codex" }
  | { readonly command: "turn-start" }
  | { readonly command: "turn-end" }
  | { readonly command: "attention" }
  | { readonly command: "auto-name" };

export interface ConsoleRestartDeps {
  readonly lifecycle?: Pick<ReturnType<typeof createConsoleDaemonLifecycle>, "stop" | "ensureDaemon" | "probe">;
  readonly openBrowser?: (url: string, deps?: OpenBrowserDeps) => void;
}

export interface BuildConsoleHelpTextOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
  readonly release?: string;
}

const FIXED_HOST = "127.0.0.1";
const HELP_BANNER_INDENT = "  ";
const DEFAULT_HELP_RELEASE = "local";
const CONSOLE_HOOK_COMMANDS = new Set(["capture-session", "turn-start", "turn-end", "attention", "auto-name"]);

export function parseConsoleCliMode(argv: readonly string[]): ConsoleCliMode {
  // 인자가 없으면 기본 동작은 start(서버 보장 + 브라우저 열기)다.
  if (argv.length === 0) return "start";
  const [first, ...rest] = argv;
  if (first === "--help" || first === "-h") return "help";

  let mode: ConsoleCliMode;
  if (first === "start") {
    mode = "start";
  } else if (first === "stop") {
    mode = "stop";
  } else if (first === "restart") {
    mode = "restart";
  } else if (first === "status") {
    mode = "status";
  } else {
    throw new Error(`Unknown fleet console command: ${first}\nRun 'fleet-console --help' for usage.`);
  }

  for (const arg of rest) {
    if (arg === "--help" || arg === "-h") return "help";
    throw new Error(`Unknown fleet console option: ${arg}\nRun 'fleet-console --help' for usage.`);
  }
  return mode;
}

export function parseConsoleHookCommand(argv: readonly string[]): ConsoleHookCommand {
  const [commandName, ...rest] = argv;
  if (!commandName || !CONSOLE_HOOK_COMMANDS.has(commandName)) {
    throw new Error("Unknown fleet-console hook command");
  }
  if (commandName === "turn-start" && rest.length === 0) return { command: "turn-start" };
  if (commandName === "turn-end" && rest.length === 0) return { command: "turn-end" };
  if (commandName === "attention" && rest.length === 0) return { command: "attention" };
  if (commandName === "auto-name" && rest.length === 0) return { command: "auto-name" };
  if (commandName === "capture-session" && rest.length === 1 && (rest[0] === "claude" || rest[0] === "codex")) return { command: "capture-session", provider: rest[0] };
  throw new Error("Unknown fleet-console hook command");
}

export function buildConsoleHelpText(options: BuildConsoleHelpTextOptions = {}): string {
  const colorEnabled = resolveColorEnabled(options);
  const subtitle = `Fleet Console · ${options.release ?? DEFAULT_HELP_RELEASE}`;
  const lines = [
    ...ASCII_FLEET_BANNER.map(
      (line, index) => `${HELP_BANNER_INDENT}${paint(GRADIENT_COLORS[index] ?? FLEET_COMMAND, line, colorEnabled)}`,
    ),
    dim(subtitle, colorEnabled),
    "",
    dim("Observe carrier jobs, live output streams, and console-owned terminal sessions.", colorEnabled),
    "",
    section("USAGE", colorEnabled),
    `  ${command("fleet-console", colorEnabled)} ${dim("[start|stop|restart|status] [--help]", colorEnabled)}`,
    "",
    section("COMMANDS", colorEnabled),
    `  ${command("start", colorEnabled)}   ${dim("Ensure the local Fleet Console server, then open it in your browser. (default)", colorEnabled)}`,
    `  ${command("stop", colorEnabled)}    ${dim("Stop the local Fleet Console server.", colorEnabled)}`,
    `  ${command("restart", colorEnabled)} ${dim("Restart the local Fleet Console server, then open it in your browser.", colorEnabled)}`,
    `  ${command("status", colorEnabled)}  ${dim("Show the local Fleet Console server status.", colorEnabled)}`,
    "",
    section("OPTIONS", colorEnabled),
    `  ${option("--help, -h", colorEnabled)}  ${dim("Show this help message and exit.", colorEnabled)}`,
    "",
    section("EXAMPLES", colorEnabled),
    `  ${command("fleet-console", colorEnabled)}`,
    `  ${command("fleet-console status", colorEnabled)}`,
    `  ${command("fleet-console restart", colorEnabled)}`,
    `  ${command("fleet-console stop", colorEnabled)}`,
    "",
  ];
  const text = lines.join("\n");
  return colorEnabled ? text : stripAnsi(text);
}

export function createConsoleDaemonLifecycle(deps: ConsoleDaemonLifecycleDeps = {}) {
  const env = deps.env ?? process.env;
  const execPath = deps.execPath ?? process.execPath;
  const serverModulePath = deps.serverModulePath ?? resolveDefaultServerModulePath();
  const spawnDetached = deps.spawnDetached ?? ((bin, args, options) => {
    const child = spawn(bin, [...args], options);
    // 데몬 spawn 실패는 이후 health probe 단계에서 처리하므로 여기서는 uncaught 'error'만 막는다.
    child.once("error", () => {});
    child.unref();
  });
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const paths = createConsolePaths({ env });
  const lock = createConsoleLock();
  const health = deps.health ?? createConsoleHealthClient();
  const stale = createConsoleStalePolicy();

  async function runServer(): Promise<void> {
    const server = createConsoleServer();
    await server.start(paths);
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", () => { void server.stop().finally(resolve); });
      process.once("SIGINT", () => { void server.stop().finally(resolve); });
    });
  }

  async function probe() {
    const payload = readTrustedLock();
    const probeResult = await health.probe(payload);
    return { ...probeResult, buildStale: payload ? stale.isBuildStale(payload, serverModulePath) : false };
  }

  async function stop(): Promise<void> {
    const payload = readTrustedLock();
    if (!payload) return;
    // 소유권 가드는 살아있는 desktop 프로세스에 시그널을 보내는 것만 막는다 —
    // sidecar가 락을 남기고 죽었을 때까지 막으면 stale lock을 CLI가 영영 정리할 수 없다.
    if (isLockProcessAlive(payload.pid)) assertCliCanControlDaemon(payload);
    try {
      process.kill(payload.pid, "SIGTERM");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
    await sleep(200);
    try {
      process.kill(payload.pid, 0);
      process.kill(payload.pid, "SIGKILL");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
    lock.removeLock(paths.lockFile, payload.pid);
  }

  async function ensureDaemon(): Promise<string> {
    const current = readTrustedLock({ cleanUntrusted: true });
    const probeResult = await health.probe(current);
    const isBuildStale = current ? stale.isBuildStale(current, serverModulePath) : false;
    if (probeResult.healthy && current) {
      if (!isBuildStale) return current.endpoint;
      if (typeof probeResult.health?.workspaceCount === "number" && probeResult.health.workspaceCount > 0) return current.endpoint;
    }
    if (current) await stop();
    spawnDetached(execPath, [serverModulePath, "serve"], withHidden({ detached: true, env, stdio: "ignore" as const }));
    for (let i = 0; i < 30; i += 1) {
      await sleep(100);
      const next = await probe();
      if (next.healthy && next.lock) return next.lock.endpoint;
    }
    throw new Error("Fleet Console server did not become healthy");
  }

  return { ensureDaemon, probe, runServer, stop };

  function readTrustedLock(options: { readonly cleanUntrusted?: boolean } = {}): ConsoleLockPayload | null {
    try {
      const payload = lock.readLock(paths.lockFile);
      if (!payload) return null;
      lock.assertTrustedLock({
        dir: paths.dir,
        lockFile: paths.lockFile,
        payload,
        host: FIXED_HOST,
      });
      return payload;
    } catch (err) {
      if (!options.cleanUntrusted) throw err;
      // 신뢰할 수 없는 잠금은 프로세스를 종료하지 않고 파일만 폐기한다.
      lock.removeLock(paths.lockFile);
      return null;
    }
  }
}

export async function openFleetConsole(deps: OpenFleetConsoleDeps = {}): Promise<OpenFleetConsoleResult> {
  const lifecycle = deps.lifecycle ?? createConsoleDaemonLifecycle();
  await lifecycle.ensureDaemon();
  const status = await lifecycle.probe();
  if (!status.healthy || !status.lock) {
    throw new Error("Fleet Console server is not healthy after ensure");
  }
  const url = `${status.lock.endpoint}console/`;
  (deps.openBrowser ?? openBrowser)(url);
  return { url };
}

export async function runConsoleStatus(deps: ConsoleStatusDeps = {}): Promise<string> {
  const lifecycle = deps.lifecycle ?? createConsoleDaemonLifecycle();
  const status = await lifecycle.probe();
  if (!status.healthy || !status.lock) {
    const reason = status.error ? ` (${status.error})` : "";
    return `Fleet Console server: not running${reason}`;
  }
  const consoleUrl = `${status.lock.endpoint}console/`;
  const workspaceCount = typeof status.health?.workspaceCount === "number" ? status.health.workspaceCount : 0;
  const staleNote = status.buildStale ? " · build stale (restart recommended)" : "";
  const ownerNote = status.lock.owner?.kind === "desktop" ? " · owned by desktop" : "";
  return [
    `Fleet Console server: running (pid ${status.lock.pid})`,
    `  endpoint   ${status.lock.endpoint}`,
    `  console    ${consoleUrl}`,
    `  workspaces ${workspaceCount}${staleNote}${ownerNote}`,
  ].join("\n");
}

export async function runConsoleStop(deps: ConsoleStopDeps = {}): Promise<string> {
  const lifecycle = deps.lifecycle ?? createConsoleDaemonLifecycle();
  await lifecycle.stop();
  return "Fleet Console server stopped.";
}

export function assertCliCanControlDaemon(payload: ConsoleLockPayload): void {
  void payload;
}

export function isLockProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM은 살아있지만 권한이 없는 프로세스 — 보호 대상으로 취급한다. ESRCH만 죽은 것으로 본다.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function runConsoleRestart(deps: ConsoleRestartDeps = {}): Promise<OpenFleetConsoleResult> {
  const lifecycle = deps.lifecycle ?? createConsoleDaemonLifecycle();
  // 기존 데몬을 정지한 뒤 새 데몬을 띄우고 브라우저를 연다.
  await lifecycle.stop();
  return openFleetConsole({ lifecycle, openBrowser: deps.openBrowser });
}

export async function main(): Promise<void> {
  if (process.argv[2] === "serve") {
    await createConsoleDaemonLifecycle().runServer();
    return;
  }
  if (process.argv[2] === "hook") {
    const hookCommand = parseConsoleHookCommand(process.argv.slice(3));
    if (hookCommand.command === "turn-start" || hookCommand.command === "turn-end") {
      // 턴 상태 hook은 항상 무출력·exit 0 best-effort다(codex Stop exit2=continuation, claude block 출력 금지).
      await postAgentHook(`/sessions/${readHookSessionId(process.env)}/turn`, { phase: hookCommand.command === "turn-start" ? "start" : "end" }, process.env);
      return;
    }
    if (hookCommand.command === "attention") {
      // 입력 대기 알림 hook도 무출력·exit 0 best-effort다(claude block/추가 stdout 금지).
      await postAgentHook(`/sessions/${readHookSessionId(process.env)}/attention`, { input: await readStdinBestEffort() }, process.env);
      return;
    }
    if (hookCommand.command === "auto-name") {
      // 자동 작명 hook도 무출력·exit 0 best-effort다(stdin prompt를 읽어 서버로 전달만 한다).
      await postAgentHook(`/sessions/${readHookSessionId(process.env)}/auto-name`, { input: await readStdinBestEffort() }, process.env);
      return;
    }
    await postAgentHook(`/sessions/${readHookSessionId(process.env)}/capture`, { provider: hookCommand.provider, input: await readStdinBestEffort() }, process.env);
    return;
  }
  const mode = parseConsoleCliMode(process.argv.slice(2));
  if (mode === "help") {
    process.stdout.write(`${buildConsoleHelpText({ env: process.env, isTTY: process.stdout.isTTY })}\n`);
    return;
  }
  if (mode === "status") {
    process.stdout.write(`${await runConsoleStatus()}\n`);
    return;
  }
  if (mode === "stop") {
    process.stdout.write(`${await runConsoleStop()}\n`);
    return;
  }
  if (mode === "restart") {
    await runConsoleRestart();
    process.stdout.write("Fleet Console restarted.\n");
    return;
  }
  await openFleetConsole();
  process.stdout.write("Fleet Console opened.\n");
}

function resolveDefaultServerModulePath(): string {
  const builtPath = new URL("../dist/cli.mjs", import.meta.url).pathname;
  if (fs.existsSync(builtPath)) return builtPath;
  return fileURLToPath(import.meta.url);
}

function readHookSessionId(env: NodeJS.ProcessEnv): string {
  return encodeURIComponent(env.FLEET_CONSOLE_SESSION_ID ?? "");
}

async function postAgentHook(pathname: string, body: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const paths = createConsolePaths({ env });
    const lock = createConsoleLock().readLock(paths.lockFile);
    if (!lock) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    if (typeof timer.unref === "function") timer.unref();
    try {
      await fetch(`${lock.endpoint}plugins/terminal/agent${pathname}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${lock.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // provider hook은 UI best-effort 신호라 실패해도 stdout/stderr와 exit code에 영향을 주지 않는다.
  }
}

function readStdinBestEffort(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish(""), 500);
    if (typeof timer.unref === "function") timer.unref();
    process.stdin.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      finish("");
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      finish(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

// npm/pnpm 글로벌 bin은 dist/cli.mjs로의 symlink다. path.resolve는 symlink를
// 풀지 않으므로 argv[1]과 import.meta.url이 달라 main()이 영영 스킵된다.
// /var vs /private/var 같은 플랫폼 alias도 realpath로 정규화한다.
export function isCliDirectRun(argv1: string | undefined, moduleUrl: string = import.meta.url): boolean {
  if (!argv1) return false;
  try {
    return fs.realpathSync(path.resolve(argv1)) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isCliDirectRun(process.argv[1])) {
  await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
