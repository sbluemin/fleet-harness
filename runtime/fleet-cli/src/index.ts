import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { buildSubagentsSection } from "@dotobokuri/fleet-admiral";
import {
  buildClaudeSubagentDefinitions,
  createCarrierRuntime,
  getCarrierConfig,
  getEnabledCarrierSubagentIds,
  getRegisteredOrder,
  readCarrierAgentModeSnapshot,
  resolveAgentCliType,
  type CarrierConfig,
  type CarrierModelDefaults,
} from "@dotobokuri/fleet-carriers";
import { createInfraServices } from "@dotobokuri/fleet-infra";

import { dispatchAuthCommand } from "./auth/dispatcher.js";
import { runApp } from "./app.js";
import { buildFleetHelpText, parseFleetCliOptions, parseFleetHookCommand } from "./cli-args.js";
import { dispatchUpdateCommand } from "./update/dispatcher.js";

const HELP_HINT = "Run 'fleet --help' for usage.";
const require = createRequire(import.meta.url);
const FLEET_ENTRY_PATH = fileURLToPath(import.meta.url);
const PLUGIN_ASSETS_DIR = path.join(dirname(dirname(FLEET_ENTRY_PATH)), "assets");
const PLUGIN_TSX_LOADER_PATH = resolveOptionalPackage("tsx");
const PLUGIN_ENTRY = {
  entryPath: FLEET_ENTRY_PATH,
  execPath: process.execPath,
  ...(PLUGIN_TSX_LOADER_PATH ? { tsxLoaderPath: PLUGIN_TSX_LOADER_PATH } : {}),
};
const argv = process.argv.slice(2);

if (argv[0] === "auth") {
  // auth 커맨드 전용 Composition Root — 경량 infraServices 조립 후 authService 주입
  const authInfraServices = createInfraServices();
  const status = await dispatchAuthCommand(
    argv,
    { stdout: process.stdout, stderr: process.stderr },
    { authService: authInfraServices.authService },
  );
  process.exit(status);
}

if (argv[0] === "hook") {
  const hookCommand = parseFleetHookCommandOrExit(argv.slice(1));
  if (hookCommand === "subagents-context") {
    process.stdout.write(`${runSubagentsContextHook(process.env)}\n`);
    process.exit(0);
  }
}

if (argv[0] === "wiki") {
  const cliPath = require.resolve("@dotobokuri/fleet-wiki-ui/dist/cli.mjs");
  const child = spawn(process.execPath, [cliPath, ...argv.slice(1)], {
    stdio: "inherit",
    cwd: process.env.INIT_CWD || process.cwd(),
  });
  const status = await new Promise<number>((resolve) => {
    child.on("error", (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (typeof code === "number") {
        resolve(code);
        return;
      }
      if (signal) {
        resolve(1);
        return;
      }
      resolve(0);
    });
  });
  process.exit(status);
}

if (argv[0] === "update") {
  const status = await dispatchUpdateCommand(argv, {
    stdout: process.stdout,
    stderr: process.stderr,
  });
  process.exit(status);
}

if (argv[0] && !argv[0].startsWith("-")) {
  process.stderr.write(`Unknown fleet command: ${argv[0]}\n${HELP_HINT}\n`);
  process.exit(1);
}

const options = parseFleetCliOptionsOrExit(argv);

if (options.help) {
  process.stdout.write(buildFleetHelpText());
  process.exit(0);
}

runApp({
  argvOptions: options,
  cursorSync: options.cursorSync,
  pluginAssetsDir: PLUGIN_ASSETS_DIR,
  pluginEntry: PLUGIN_ENTRY,
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

function parseFleetCliOptionsOrExit(argv: readonly string[]): ReturnType<typeof parseFleetCliOptions> {
  try {
    return parseFleetCliOptions(argv, process.env);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

function parseFleetHookCommandOrExit(argv: readonly string[]): ReturnType<typeof parseFleetHookCommand> {
  try {
    return parseFleetHookCommand(argv);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

function resolveOptionalPackage(id: string): string | undefined {
  try {
    return require.resolve(id);
  } catch {
    return undefined;
  }
}

function runSubagentsContextHook(env: NodeJS.ProcessEnv): string {
  const fleetRoot = env.FLEET_ROOT ?? path.join(env.HOME ?? os.homedir(), ".fleet");
  if (!canReadCarrierState(path.join(fleetRoot, "carriers.json"))) {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "" } });
  }
  const carrierRuntime = createCarrierRuntime();
  carrierRuntime.store.initStore(fleetRoot);
  carrierRuntime.registerCarrierDefaults();
  const carrierIds = getRegisteredOrder(carrierRuntime.registry);
  const carrierConfigs = carrierIds
    .map((carrierId) => getCarrierConfig(carrierRuntime.registry, carrierId))
    .filter((config): config is NonNullable<typeof config> => config !== undefined);
  const defaultsByCarrier = Object.fromEntries(
    carrierConfigs.map((config) => [config.id, buildCarrierModelDefaults(config)]),
  );
  const enabledCarrierIds = getEnabledCarrierSubagentIds(
    readCarrierAgentModeSnapshot(defaultsByCarrier),
    carrierIds,
  );
  const definitions = buildClaudeSubagentDefinitions({ carrierConfigs, enabledCarrierIds });
  const configsById = new Map(carrierConfigs.map((config) => [config.id, config]));
  const additionalContext = buildSubagentsSection(definitions.map((definition) => ({
    carrierId: definition.carrierId,
    displayName: configsById.get(definition.carrierId)?.displayName,
    nativeName: definition.name,
  }))) ?? "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } });
}

function canReadCarrierState(filePath: string): boolean {
  try {
    return isReadableCarrierStateRoot(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return false;
  }
}

function isReadableCarrierStateRoot(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const carriers = value.carriers;
  return carriers === undefined || isRecord(carriers);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildCarrierModelDefaults(config: CarrierConfig): CarrierModelDefaults {
  const cliType = resolveAgentCliType(config.id, config.defaultCliType);
  const cliDefaults = cliType === "claude"
    ? config.subagent?.byHost?.claude ?? {
      ...(config.defaultEffort ? { defaultEffort: config.defaultEffort } : {}),
      ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
    }
    : {};
  return {
    cliType,
    ...(config.defaultAgentMode ? { defaultAgentMode: config.defaultAgentMode } : {}),
    ...(cliDefaults.defaultEffort ? { defaultEffort: cliDefaults.defaultEffort } : {}),
    ...(cliDefaults.defaultModel ? { defaultModel: cliDefaults.defaultModel } : {}),
  };
}
