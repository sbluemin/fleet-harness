import { parseConsoleCliMode, runConsolePublishedCommand } from "../core/host/bootstrap/console-lifecycle.js";

import { buildFleetHelpText, buildFleetVersionText, isFleetVersionArg } from "./cli-args.js";
import { dispatchGatewayCommand } from "./gateway/dispatcher.js";
import { dispatchUpdateCommand } from "./update/dispatcher.js";
import { resolveSiblingConsoleCliPath } from "./update/stop-console.js";

export type FleetDispatch =
  | { readonly kind: "update"; readonly argv: readonly string[] }
  | { readonly kind: "gateway"; readonly gatewayArgv: readonly string[] }
  | { readonly kind: "console"; readonly consoleArgv: readonly string[] }
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "unknown"; readonly command: string };

export interface FleetDispatchOptions {
  readonly stdout: { write(chunk: string): boolean; isTTY?: boolean };
  readonly stderr: { write(chunk: string): boolean };
  readonly env?: NodeJS.ProcessEnv;
  readonly dispatchUpdateCommand?: (
    argv: readonly string[],
    io: { readonly stdout: { write(chunk: string): boolean }; readonly stderr: { write(chunk: string): boolean } },
    options?: { readonly siblingCliPath?: string },
  ) => Promise<number>;
  readonly dispatchGatewayCommand?: typeof dispatchGatewayCommand;
  readonly siblingCliPath?: string;
  readonly moduleUrl?: string;
}

/**
 * fleet.mjs precedence: update > gateway > console > status > help > version > unknown.
 * Bare `fleet` prints help. Anything else, including the retired `cli` spelling, stops here.
 */
export function classifyFleetArgv(argv: readonly string[]): FleetDispatch {
  const command = argv[0];
  if (command === undefined || command === "--help" || command === "-h") return { kind: "help" };
  if (command === "update") return { kind: "update", argv };
  if (command === "gateway") return { kind: "gateway", gatewayArgv: argv.slice(1) };
  if (command === "console") return { kind: "console", consoleArgv: argv.slice(1) };
  if (command === "status") return { kind: "console", consoleArgv: ["status", ...argv.slice(1)] };
  if (isFleetVersionArg(command)) return { kind: "version" };
  return { kind: "unknown", command };
}

export async function dispatchFleetArgv(
  argv: readonly string[],
  options: FleetDispatchOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const update = options.dispatchUpdateCommand ?? dispatchUpdateCommand;
  const io = { stdout: options.stdout, stderr: options.stderr };
  const dispatch = classifyFleetArgv(argv);

  if (dispatch.kind === "update") {
    const siblingCliPath =
      options.siblingCliPath ??
      resolveSiblingConsoleCliPath(options.moduleUrl ?? import.meta.url);
    return await update(dispatch.argv, io, { siblingCliPath });
  }

  if (dispatch.kind === "gateway") {
    return await (options.dispatchGatewayCommand ?? dispatchGatewayCommand)(dispatch.gatewayArgv, io);
  }

  if (dispatch.kind === "console") {
    try {
      const mode = parseConsoleCliMode(dispatch.consoleArgv);
      await runConsolePublishedCommand(mode, { stdout: io.stdout, env });
      return 0;
    } catch (error: unknown) {
      io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  if (dispatch.kind === "help") {
    io.stdout.write(buildFleetHelpText({ env, isTTY: io.stdout.isTTY }));
    return 0;
  }

  if (dispatch.kind === "version") {
    io.stdout.write(buildFleetVersionText());
    return 0;
  }

  io.stderr.write(`Unknown fleet command: ${dispatch.command}\nRun 'fleet --help' for usage.\n`);
  return 1;
}
