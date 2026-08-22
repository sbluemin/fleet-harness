import {
  createAiGatewaySettingsStore,
  readCodexSubscriptionAuth,
  readCursorSubscriptionToken,
  readXaiSubscriptionToken,
  type AiGatewaySettingsStore,
} from "@dotobokuri/core-ai-gateway";
import {
  KIMI_AUTH_PROVIDER_ID,
  OPENCODE_AUTH_PROVIDER_ID,
} from "@dotobokuri/fleet-admiral";
import { createInfraServices, getFleetDataDir, type AuthService } from "@dotobokuri/core-infra";

import { buildGatewayHelpText } from "./help.js";
import { runGatewayInteractive } from "./interactive.js";
import { GATEWAY_SET_KEYS, applyGatewaySetting, isGatewaySetKey } from "./policy.js";
import {
  buildGatewayStatusReport,
  collectGatewayModels,
  renderGatewayModelsJson,
  renderGatewayModelsText,
  renderGatewayStatusJson,
  renderGatewayStatusText,
  type GatewayCredentialReport,
} from "./report.js";
import { runGatewayServe } from "./serve.js";
import { dispatchAuthCommand } from "../auth/dispatcher.js";

export type GatewayDispatch =
  | { readonly kind: "help" }
  | { readonly kind: "interactive" }
  | { readonly kind: "serve"; readonly argv: readonly string[] }
  | { readonly kind: "auth"; readonly argv: readonly string[] }
  | { readonly kind: "models"; readonly json: boolean }
  | { readonly kind: "status"; readonly json: boolean }
  | { readonly kind: "set"; readonly key: string | undefined; readonly value: string | undefined }
  | { readonly kind: "unknown"; readonly command: string };

export interface GatewayCommandIo {
  readonly stdout: { write(chunk: string): boolean; isTTY?: boolean };
  readonly stderr: { write(chunk: string): boolean };
}

export interface GatewayCommandDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly dataDir?: string;
  readonly createStore?: (dataDir: string) => AiGatewaySettingsStore;
  readonly createAuthService?: () => AuthService;
  readonly dispatchAuthCommand?: typeof dispatchAuthCommand;
  readonly runInteractive?: typeof runGatewayInteractive;
  readonly runServe?: typeof runGatewayServe;
  readonly readSubscriptions?: GatewaySubscriptionReaders;
}

export interface GatewaySubscriptionReaders {
  readonly codex: () => Promise<unknown>;
  readonly cursor: () => Promise<unknown>;
  readonly xai: () => Promise<unknown>;
}

/** `gateway` 뒤의 인자만 받는다. 알 수 없는 명령은 Claude로 흘리지 않고 여기서 끝난다. */
export function classifyGatewayArgv(argv: readonly string[]): GatewayDispatch {
  const command = argv[0];
  if (command === undefined) return { kind: "interactive" };
  if (command === "--help" || command === "-h") return { kind: "help" };
  if (command === "serve") return { kind: "serve", argv: argv.slice(1) };
  if (command === "auth") return { kind: "auth", argv: ["auth", ...argv.slice(1)] };
  if (command === "models") return { kind: "models", json: hasJsonFlag(argv.slice(1)) };
  if (command === "status") return { kind: "status", json: hasJsonFlag(argv.slice(1)) };
  if (command === "set") return { kind: "set", key: argv[1], value: argv[2] };
  return { kind: "unknown", command };
}

export async function dispatchGatewayCommand(
  argv: readonly string[],
  io: GatewayCommandIo,
  deps: GatewayCommandDeps = {},
): Promise<number> {
  const dispatch = classifyGatewayArgv(argv);
  const env = deps.env ?? process.env;

  if (dispatch.kind === "help") {
    io.stdout.write(`${buildGatewayHelpText({ env, isTTY: io.stdout.isTTY })}\n`);
    return 0;
  }

  if (dispatch.kind === "unknown") {
    io.stderr.write(`Unknown fleet gateway command: ${dispatch.command}\n`);
    io.stdout.write(`${buildGatewayHelpText({ env, isTTY: io.stdout.isTTY })}\n`);
    return 1;
  }

  if (dispatch.kind === "serve") {
    return await (deps.runServe ?? runGatewayServe)(dispatch.argv, io, {
      env,
      ...(deps.dataDir === undefined ? {} : { dataDir: deps.dataDir }),
      ...(deps.createStore === undefined ? {} : { createStore: deps.createStore }),
      ...(deps.createAuthService === undefined ? {} : { createAuthService: deps.createAuthService }),
    });
  }

  const dataDir = deps.dataDir ?? getFleetDataDir();
  const store = (deps.createStore ?? ((dir) => createAiGatewaySettingsStore({ dataDir: dir })))(dataDir);

  if (dispatch.kind === "auth") {
    const authService = resolveAuthService(deps);
    return await (deps.dispatchAuthCommand ?? dispatchAuthCommand)(dispatch.argv, io, { authService });
  }

  if (dispatch.kind === "interactive") {
    const authService = resolveAuthService(deps);
    return await (deps.runInteractive ?? runGatewayInteractive)(io, {
      store,
      authService,
      dispatchAuthCommand: deps.dispatchAuthCommand ?? dispatchAuthCommand,
    });
  }

  if (dispatch.kind === "models") {
    const models = collectGatewayModels(store.read());
    io.stdout.write(dispatch.json
      ? renderGatewayModelsJson(models)
      : `${renderGatewayModelsText(models, { env, isTTY: io.stdout.isTTY })}\n`);
    return 0;
  }

  if (dispatch.kind === "status") {
    const report = buildGatewayStatusReport({
      settingsPath: store.path,
      settings: store.read(),
      credentials: await collectCredentials(deps),
    });
    io.stdout.write(dispatch.json
      ? renderGatewayStatusJson(report)
      : `${renderGatewayStatusText(report, { env, isTTY: io.stdout.isTTY })}\n`);
    return 0;
  }

  if (!isGatewaySetKey(dispatch.key)) {
    io.stderr.write(
      `Unknown fleet gateway set key: ${dispatch.key ?? "(missing)"}\nKnown keys: ${GATEWAY_SET_KEYS.join(", ")}.\n`,
    );
    return 1;
  }
  const result = applyGatewaySetting(store, dispatch.key, dispatch.value);
  if (!result.ok) {
    io.stderr.write(`${result.message}\n`);
    return 1;
  }
  io.stdout.write(`${result.summary}\n`);
  return 0;
}

async function collectCredentials(deps: GatewayCommandDeps): Promise<readonly GatewayCredentialReport[]> {
  const readers = deps.readSubscriptions ?? {
    codex: () => readCodexSubscriptionAuth(),
    cursor: () => readCursorSubscriptionToken(),
    xai: () => readXaiSubscriptionToken(),
  };
  const signedIn = await listSignedInProviders(deps);
  return [
    { provider: "codex", source: "subscription", state: await probe(readers.codex) },
    { provider: "xai", source: "subscription", state: await probe(readers.xai) },
    { provider: "cursor", source: "subscription", state: await probe(readers.cursor) },
    {
      provider: "opencode",
      source: "api-key",
      state: signedIn.has(OPENCODE_AUTH_PROVIDER_ID) ? "present" : "absent",
    },
    {
      provider: "kimi",
      source: "api-key",
      state: signedIn.has(KIMI_AUTH_PROVIDER_ID) ? "present" : "absent",
    },
  ];
}

async function listSignedInProviders(deps: GatewayCommandDeps): Promise<ReadonlySet<string>> {
  try {
    return new Set(await resolveAuthService(deps).listProviderIds());
  } catch {
    return new Set();
  }
}

async function probe(read: () => Promise<unknown>): Promise<"present" | "absent"> {
  try {
    const value = await read();
    return value === null || value === undefined ? "absent" : "present";
  } catch {
    return "absent";
  }
}

function resolveAuthService(deps: GatewayCommandDeps): AuthService {
  return (deps.createAuthService ?? (() => createInfraServices().authService))();
}

function hasJsonFlag(argv: readonly string[]): boolean {
  return argv.includes("--json");
}
