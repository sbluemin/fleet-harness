import { createInfraServices } from "@dotobokuri/core-infra";

import { runApp } from "./app.js";
import { dispatchAuthCommand } from "./auth/dispatcher.js";
import { buildFleetHelpText } from "./cli-args.js";
import {
  buildConsoleHelpText,
  openFleetConsole,
  parseConsoleCliMode,
  runConsoleRestart,
  runConsoleStatus,
  runConsoleStop,
} from "../core/host/console-lifecycle.js";
import { dispatchUpdateCommand } from "./update/dispatcher.js";
import { resolveSiblingConsoleCliPath } from "./update/stop-console.js";

export type FleetDispatch =
  | { readonly kind: "update"; readonly argv: readonly string[] }
  | { readonly kind: "auth"; readonly argv: readonly string[] }
  | { readonly kind: "console"; readonly consoleArgv: readonly string[] }
  | { readonly kind: "help"; readonly passthroughArgs: readonly string[] }
  | { readonly kind: "passthrough"; readonly passthroughArgs: readonly string[] };

export interface FleetDispatchOptions {
  readonly stdout: { write(chunk: string): boolean; isTTY?: boolean };
  readonly stderr: { write(chunk: string): boolean };
  readonly env?: NodeJS.ProcessEnv;
  readonly runApp?: typeof runApp;
  readonly createInfraServices?: typeof createInfraServices;
  readonly dispatchAuthCommand?: typeof dispatchAuthCommand;
  readonly dispatchUpdateCommand?: (
    argv: readonly string[],
    io: { readonly stdout: { write(chunk: string): boolean }; readonly stderr: { write(chunk: string): boolean } },
    options?: { readonly siblingCliPath?: string },
  ) => Promise<number>;
  readonly siblingCliPath?: string;
  readonly moduleUrl?: string;
}

/**
 * Exact fleet.mjs precedence: update > auth > console > cli > help > Claude passthrough.
 * `cli` is stripped before help/passthrough classification.
 */
export function classifyFleetArgv(argv: readonly string[]): FleetDispatch {
  const command = argv[0];
  if (command === "update") return { kind: "update", argv };
  if (command === "auth") return { kind: "auth", argv };
  if (command === "console") return { kind: "console", consoleArgv: argv.slice(1) };

  const passthroughArgv = command === "cli" ? argv.slice(1) : argv;
  if (passthroughArgv[0] === "--help" || passthroughArgv[0] === "-h") {
    return { kind: "help", passthroughArgs: passthroughArgv.slice(1) };
  }
  return { kind: "passthrough", passthroughArgs: [...passthroughArgv] };
}

export async function dispatchFleetArgv(
  argv: readonly string[],
  options: FleetDispatchOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const runAppImpl = options.runApp ?? runApp;
  const createInfra = options.createInfraServices ?? createInfraServices;
  const auth = options.dispatchAuthCommand ?? dispatchAuthCommand;
  const update = options.dispatchUpdateCommand ?? dispatchUpdateCommand;
  const io = { stdout: options.stdout, stderr: options.stderr };
  const dispatch = classifyFleetArgv(argv);

  if (dispatch.kind === "update") {
    const siblingCliPath =
      options.siblingCliPath ??
      resolveSiblingConsoleCliPath(options.moduleUrl ?? import.meta.url);
    return await update(dispatch.argv, io, { siblingCliPath });
  }

  if (dispatch.kind === "auth") {
    return await auth(dispatch.argv, io, createInfra());
  }

  if (dispatch.kind === "console") {
    try {
      const mode = parseConsoleCliMode(dispatch.consoleArgv);
      if (mode === "help") {
        io.stdout.write(`${buildConsoleHelpText({ env, isTTY: io.stdout.isTTY })}\n`);
        return 0;
      }
      if (mode === "status") {
        io.stdout.write(`${await runConsoleStatus()}\n`);
        return 0;
      }
      if (mode === "stop") {
        io.stdout.write(`${await runConsoleStop()}\n`);
        return 0;
      }
      if (mode === "restart") {
        await runConsoleRestart();
        io.stdout.write(`Fleet Console restarted.\n${await runConsoleStatus()}\n`);
        return 0;
      }
      await openFleetConsole();
      io.stdout.write(`Fleet Console opened.\n${await runConsoleStatus()}\n`);
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

  await runAppImpl({ passthroughArgs: dispatch.passthroughArgs });
  return 0;
}
