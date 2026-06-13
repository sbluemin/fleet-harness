import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { ConsoleLockPayload } from "./api-types.js";
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

export type ConsoleCliMode = "start" | "stop" | "status" | "help";

export interface ConsoleDaemonLifecycleDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly serverModulePath?: string;
  readonly spawnDetached?: (execPath: string, args: readonly string[], options: { readonly detached: true; readonly env: NodeJS.ProcessEnv; readonly stdio: "ignore" }) => void;
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

export interface BuildConsoleHelpTextOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
  readonly release?: string;
}

const FIXED_HOST = "127.0.0.1";
const FIXED_PORT = 37283;
const HELP_BANNER_INDENT = "  ";
const DEFAULT_HELP_RELEASE = "local";

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
  } else if (first === "status") {
    mode = "status";
  } else {
    throw new Error(`Unknown fleet console command: ${first}\nRun 'fleet console --help' for usage.`);
  }

  for (const arg of rest) {
    if (arg === "--help" || arg === "-h") return "help";
    throw new Error(`Unknown fleet console option: ${arg}\nRun 'fleet console --help' for usage.`);
  }
  return mode;
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
    dim("Observe registered Fleet CLI workspaces, carrier jobs, live output streams, and terminal sessions.", colorEnabled),
    "",
    section("USAGE", colorEnabled),
    `  ${command("fleet console", colorEnabled)} ${dim("[start|stop|status] [--help]", colorEnabled)}`,
    `  ${dim("Standalone binary:", colorEnabled)} ${command("fleet-console", colorEnabled)} ${dim("[start|stop|status]", colorEnabled)}`,
    "",
    section("COMMANDS", colorEnabled),
    `  ${command("start", colorEnabled)}   ${dim("Ensure the local Fleet Console server, then open it in your browser. (default)", colorEnabled)}`,
    `  ${command("stop", colorEnabled)}    ${dim("Stop the local Fleet Console server.", colorEnabled)}`,
    `  ${command("status", colorEnabled)}  ${dim("Show the local Fleet Console server status.", colorEnabled)}`,
    "",
    section("OPTIONS", colorEnabled),
    `  ${option("--help, -h", colorEnabled)}  ${dim("Show this help message and exit.", colorEnabled)}`,
    "",
    section("EXAMPLES", colorEnabled),
    `  ${command("fleet console", colorEnabled)}`,
    `  ${command("fleet console status", colorEnabled)}`,
    `  ${command("fleet console stop", colorEnabled)}`,
    "",
  ];
  const text = lines.join("\n");
  return colorEnabled ? text : stripAnsi(text);
}

export function buildWikiHelpText(options: BuildConsoleHelpTextOptions = {}): string {
  const colorEnabled = resolveColorEnabled(options);
  const subtitle = `Fleet Wiki · ${options.release ?? DEFAULT_HELP_RELEASE}`;
  const lines = [
    ...ASCII_FLEET_BANNER.map(
      (line, index) => `${HELP_BANNER_INDENT}${paint(GRADIENT_COLORS[index] ?? FLEET_COMMAND, line, colorEnabled)}`,
    ),
    dim(subtitle, colorEnabled),
    "",
    section("USAGE", colorEnabled),
    `  ${command("fleet wiki", colorEnabled)} ${dim("[--stop] [--help]", colorEnabled)}`,
    `  ${dim("Standalone binary:", colorEnabled)} ${command("fleet-wiki", colorEnabled)} ${dim("[--stop] [--help]", colorEnabled)}`,
    "",
    section("OPTIONS", colorEnabled),
    `  ${option("--stop", colorEnabled)}  ${dim("Stop the local Fleet Console daemon that owns Codex.", colorEnabled)}`,
    `  ${option("--help", colorEnabled)}  ${dim("Show this help message and exit.", colorEnabled)}`,
    "",
    section("EXAMPLES", colorEnabled),
    `  ${command("fleet wiki", colorEnabled)}`,
    `  ${command("fleet wiki --stop", colorEnabled)}`,
    "",
  ];
  const text = lines.join("\n");
  return colorEnabled ? text : stripAnsi(text);
}

export function createConsoleDaemonLifecycle(deps: ConsoleDaemonLifecycleDeps = {}) {
  const env = deps.env ?? process.env;
  const execPath = deps.execPath ?? process.execPath;
  const serverModulePath = deps.serverModulePath ?? resolveDefaultServerModulePath();
  const spawnDetached = deps.spawnDetached ?? ((bin, args, options) => { spawn(bin, [...args], options).unref(); });
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
    spawnDetached(execPath, [serverModulePath, "serve"], { detached: true, env, stdio: "ignore" });
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
        port: FIXED_PORT,
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

export async function openFleetWikiWorkspace(options: OpenFleetWikiWorkspaceOptions): Promise<OpenFleetWikiWorkspaceResult> {
  const lifecycle = createConsoleDaemonLifecycle();
  await lifecycle.ensureDaemon();
  const status = await lifecycle.probe();
  if (!status.healthy || !status.lock) {
    throw new Error("Fleet Console server is not healthy after ensure");
  }
  const response = await fetch(`${status.lock.endpoint}console/codex/api/admin/workspaces`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${status.lock.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ cwd: path.resolve(options.cwd) }),
  });
  if (!response.ok) {
    throw new Error(`Fleet Console Codex workspace registration failed: ${response.status} ${await response.text()}`);
  }
  const body = await response.json() as { workspace: { urlPath: string } };
  const url = new URL(body.workspace.urlPath, status.lock.endpoint).toString();
  openBrowser(url);
  return { host: status.lock.host, pid: status.lock.pid, port: status.lock.port, url };
}

export async function probeFleetWikiDaemon(_options: ProbeFleetWikiDaemonOptions): Promise<OpenFleetWikiWorkspaceResult | null> {
  const lifecycle = createConsoleDaemonLifecycle();
  const status = await lifecycle.probe();
  if (!status.healthy || !status.lock) return null;
  return {
    host: status.lock.host,
    pid: status.lock.pid,
    port: status.lock.port,
    url: new URL("console/codex", status.lock.endpoint).toString(),
  };
}

export async function stopDaemon(): Promise<void> {
  await createConsoleDaemonLifecycle().stop();
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
  return [
    `Fleet Console server: running (pid ${status.lock.pid})`,
    `  endpoint   ${status.lock.endpoint}`,
    `  console    ${consoleUrl}`,
    `  workspaces ${workspaceCount}${staleNote}`,
  ].join("\n");
}

export async function runConsoleStop(deps: ConsoleStopDeps = {}): Promise<string> {
  const lifecycle = deps.lifecycle ?? createConsoleDaemonLifecycle();
  await lifecycle.stop();
  return "Fleet Console server stopped.";
}

export async function main(): Promise<void> {
  if (process.argv[2] === "serve") {
    await createConsoleDaemonLifecycle().runServer();
    return;
  }
  if (process.argv[2] === "codex") {
    await mainWiki(process.argv.slice(3));
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
  await openFleetConsole();
  process.stdout.write("Fleet Console opened.\n");
}

export async function mainWiki(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${buildWikiHelpText({ env: process.env, isTTY: process.stdout.isTTY })}\n`);
    return;
  }
  if (argv.includes("--stop")) {
    await stopDaemon();
    return;
  }
  const unsupported = argv.filter((arg) => arg !== "--host" && arg !== "--port" && !arg.startsWith("--host=") && !arg.startsWith("--port="));
  if (unsupported.length > 0) {
    throw new Error(`Unknown fleet wiki option: ${unsupported[0]}`);
  }
  await openFleetWikiWorkspace({ cwd: process.cwd() });
}

function resolveDefaultServerModulePath(): string {
  const builtPath = new URL("../dist/cli.mjs", import.meta.url).pathname;
  if (fs.existsSync(builtPath)) return builtPath;
  return fileURLToPath(import.meta.url);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
