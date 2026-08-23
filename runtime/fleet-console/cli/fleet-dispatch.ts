import { createProviderAuthService, type AuthService } from "@dotobokuri/core-ai-gateway";

import { runApp } from "./app.js";
import { dispatchAuthCommand } from "./auth/dispatcher.js";
import { buildFleetHelpText, buildFleetVersionText, isFleetVersionArg } from "./cli-args.js";
import { dispatchGatewayCommand } from "./gateway/dispatcher.js";
import { dispatchDoctorCommand } from "./doctor.js";
import { readFleetCliRelease } from "./release.js";
import {
  buildConsoleHelpText,
  openFleetConsole,
  parseConsoleCliMode,
  runConsoleRestart,
  runConsoleStatus,
  runConsoleStop,
} from "../core/host/console-lifecycle.js";
import { describeConsoleLaunch } from "../core/host/failure-notice.js";
import { dispatchUpdateCommand } from "./update/dispatcher.js";
import { resolveSiblingConsoleCliPath } from "./update/stop-console.js";

export type FleetDispatch =
  | { readonly kind: "update"; readonly argv: readonly string[] }
  | { readonly kind: "gateway"; readonly gatewayArgv: readonly string[] }
  | { readonly kind: "auth"; readonly argv: readonly string[] }
  | { readonly kind: "console"; readonly consoleArgv: readonly string[] }
  | { readonly kind: "doctor"; readonly argv: readonly string[] }
  | { readonly kind: "help"; readonly passthroughArgs: readonly string[] }
  | { readonly kind: "version" }
  | { readonly kind: "passthrough"; readonly passthroughArgs: readonly string[] };

export interface FleetDispatchOptions {
  readonly stdout: { write(chunk: string): boolean; isTTY?: boolean };
  readonly stderr: { write(chunk: string): boolean };
  readonly env?: NodeJS.ProcessEnv;
  readonly runApp?: typeof runApp;
  readonly createAuthService?: () => AuthService;
  readonly dispatchAuthCommand?: typeof dispatchAuthCommand;
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
 * Exact fleet.mjs precedence: update > gateway > auth > console > doctor > status > cli > help >
 * version > Claude passthrough. `cli` is stripped before help/passthrough classification.
 * Reserved words after `cli` stay Claude passthrough so `fleet cli status` still asks Claude Code.
 */
export function classifyFleetArgv(argv: readonly string[]): FleetDispatch {
  const command = argv[0];
  if (command === "update") return { kind: "update", argv };
  if (command === "gateway") return { kind: "gateway", gatewayArgv: argv.slice(1) };
  if (command === "auth") return { kind: "auth", argv };
  if (command === "console") return { kind: "console", consoleArgv: argv.slice(1) };
  if (command === "doctor") return { kind: "doctor", argv };
  if (command === "status") return { kind: "console", consoleArgv: ["status", ...argv.slice(1)] };

  const passthroughArgv = command === "cli" ? argv.slice(1) : argv;
  if (passthroughArgv[0] === "--help" || passthroughArgv[0] === "-h") {
    return { kind: "help", passthroughArgs: passthroughArgv.slice(1) };
  }
  if (command !== "cli" && isFleetVersionArg(passthroughArgv[0])) {
    return { kind: "version" };
  }
  return { kind: "passthrough", passthroughArgs: [...passthroughArgv] };
}

export async function dispatchFleetArgv(
  argv: readonly string[],
  options: FleetDispatchOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const runAppImpl = options.runApp ?? runApp;
  const createAuth = options.createAuthService ?? (() => createProviderAuthService());
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

  if (dispatch.kind === "gateway") {
    return await (options.dispatchGatewayCommand ?? dispatchGatewayCommand)(dispatch.gatewayArgv, io);
  }

  if (dispatch.kind === "auth") {
    // `fleet auth`는 `fleet gateway auth`로 옮겨 갔다. 손가락이 기억하는 문법을 곧장
    // 깨뜨리지 않되, 어디로 갔는지는 매번 말한다.
    io.stderr.write("`fleet auth` moved to `fleet gateway auth`. The old spelling still works for now.\n");
    return await auth(dispatch.argv, io, { authService: createAuth() });
  }

  if (dispatch.kind === "doctor") {
    return await dispatchDoctorCommand(dispatch.argv, io, { env, authService: createAuth() });
  }

  if (dispatch.kind === "console") {
    try {
      const mode = parseConsoleCliMode(dispatch.consoleArgv);
      if (mode === "help") {
        const release = readFleetCliRelease();
        io.stdout.write(`${buildConsoleHelpText({ env, isTTY: io.stdout.isTTY, release: `${release.version} · ${release.channel}` })}\n`);
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
        const restarted = await runConsoleRestart();
        io.stdout.write(`${describeConsoleLaunch("Fleet Console restarted.", restarted)}\n${await runConsoleStatus()}\n`);
        return 0;
      }
      const opened = await openFleetConsole();
      io.stdout.write(`${describeConsoleLaunch("Fleet Console opened.", opened)}\n${await runConsoleStatus()}\n`);
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

  await runAppImpl({ passthroughArgs: dispatch.passthroughArgs });
  return 0;
}
