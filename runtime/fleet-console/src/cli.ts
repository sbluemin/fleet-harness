import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createGatewayDaemonLifecycle } from "@dotobokuri/fleet-gateway";

import { openBrowser, type OpenBrowserDeps } from "./browser.js";
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

export type ConsoleCliMode = "start" | "stop" | "status" | "help";

type ConsoleGatewayLifecycle = Pick<
  ReturnType<typeof createGatewayDaemonLifecycle>,
  "ensureDaemon" | "probe" | "stop"
>;

export interface OpenFleetConsoleDeps {
  readonly lifecycle?: Pick<ConsoleGatewayLifecycle, "ensureDaemon" | "probe">;
  readonly openBrowser?: (url: string, deps?: OpenBrowserDeps) => void;
}

export interface OpenFleetConsoleResult {
  readonly url: string;
}

export interface ConsoleStatusDeps {
  readonly lifecycle?: Pick<ConsoleGatewayLifecycle, "probe">;
}

export interface ConsoleStopDeps {
  readonly lifecycle?: Pick<ConsoleGatewayLifecycle, "stop">;
}

export interface BuildConsoleHelpTextOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
  readonly release?: string;
}

const GATEWAY_ENDPOINT_PATH = "/mcp";
const CONSOLE_BASE_PATH = "/console/";
const HELP_BANNER_INDENT = "  ";
const DEFAULT_HELP_RELEASE = "local";

export function parseConsoleCliMode(argv: readonly string[]): ConsoleCliMode {
  // 인자가 없으면 기본 동작은 start(데몬 보장 + 브라우저 열기)다.
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
    dim("Observe Fleet Gateway tenants, carrier jobs, and live output streams.", colorEnabled),
    "",
    section("USAGE", colorEnabled),
    `  ${command("fleet console", colorEnabled)} ${dim("[start|stop|status] [--help]", colorEnabled)}`,
    `  ${dim("Standalone binary:", colorEnabled)} ${command("fleet-console", colorEnabled)} ${dim("[start|stop|status]", colorEnabled)}`,
    "",
    section("COMMANDS", colorEnabled),
    `  ${command("start", colorEnabled)}   ${dim("Ensure the gateway daemon, then open Fleet Console in your browser. (default)", colorEnabled)}`,
    `  ${command("stop", colorEnabled)}    ${dim("Stop the local Fleet Gateway daemon.", colorEnabled)}`,
    `  ${command("status", colorEnabled)}  ${dim("Show the local Fleet Gateway daemon status.", colorEnabled)}`,
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

export async function openFleetConsole(deps: OpenFleetConsoleDeps = {}): Promise<OpenFleetConsoleResult> {
  const lifecycle = deps.lifecycle ?? createGatewayDaemonLifecycle();
  await lifecycle.ensureDaemon();
  const status = await lifecycle.probe();
  if (!status.healthy || !status.lock) {
    throw new Error("Fleet Gateway daemon is not healthy after ensure");
  }
  const url = `${status.lock.endpoint.replace(GATEWAY_ENDPOINT_PATH, CONSOLE_BASE_PATH)}#observerToken=${encodeURIComponent(status.lock.observerToken)}`;
  (deps.openBrowser ?? openBrowser)(url);
  return { url };
}

export async function runConsoleStatus(deps: ConsoleStatusDeps = {}): Promise<string> {
  const lifecycle = deps.lifecycle ?? createGatewayDaemonLifecycle();
  const status = await lifecycle.probe();
  if (!status.healthy || !status.lock) {
    const reason = status.error ? ` (${status.error})` : "";
    return `Fleet Gateway daemon: not running${reason}`;
  }
  const consoleUrl = status.lock.endpoint.replace(GATEWAY_ENDPOINT_PATH, CONSOLE_BASE_PATH);
  const tenantCount = typeof status.health?.tenantCount === "number" ? status.health.tenantCount : 0;
  const staleNote = status.buildStale ? " · build stale (restart recommended)" : "";
  return [
    `Fleet Gateway daemon: running (pid ${status.lock.pid})`,
    `  endpoint   ${status.lock.endpoint}`,
    `  console    ${consoleUrl}`,
    `  workspaces ${tenantCount}${staleNote}`,
  ].join("\n");
}

export async function runConsoleStop(deps: ConsoleStopDeps = {}): Promise<string> {
  const lifecycle = deps.lifecycle ?? createGatewayDaemonLifecycle();
  await lifecycle.stop();
  return "Fleet Gateway daemon stopped.";
}

async function main(): Promise<void> {
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

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
