import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createGatewayDaemonLifecycle } from "@dotobokuri/fleet-gateway";

import { openBrowser, type OpenBrowserDeps } from "./browser.js";

export type ConsoleCliMode = "open" | "help";

export interface OpenFleetConsoleDeps {
  readonly lifecycle?: ConsoleGatewayLifecycle;
  readonly openBrowser?: (url: string, deps?: OpenBrowserDeps) => void;
}

export interface OpenFleetConsoleResult {
  readonly url: string;
}

type ConsoleGatewayLifecycle = Pick<ReturnType<typeof createGatewayDaemonLifecycle>, "ensureDaemon" | "probe">;

const GATEWAY_ENDPOINT_PATH = "/mcp";
const CONSOLE_BASE_PATH = "/console/";
const HELP_TEXT = `Fleet Console — observe Fleet Gateway tenants, carrier jobs, and live output streams.

USAGE
  fleet console [--help]
  Standalone binary: fleet-console [--help]

Ensures the local Fleet Gateway daemon is running, then opens the Fleet Console
in your browser. The observer token is passed once through the URL fragment and
never through a query string.
`;

export function parseConsoleCliMode(argv: readonly string[]): ConsoleCliMode {
  let mode: ConsoleCliMode = "open";
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      mode = "help";
    } else {
      throw new Error(`Unknown fleet console option: ${arg}\nRun 'fleet console --help' for usage.`);
    }
  }
  return mode;
}

export function buildConsoleHelpText(): string {
  return HELP_TEXT;
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

async function main(): Promise<void> {
  const mode = parseConsoleCliMode(process.argv.slice(2));
  if (mode === "help") {
    process.stdout.write(buildConsoleHelpText());
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
